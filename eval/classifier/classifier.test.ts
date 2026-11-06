import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ActionRow,
  approvalRequiredAsks,
  blindRow,
  cohensKappa,
  computeMetrics,
  describeCall,
  parseLabels,
  redact,
  resolveLabels,
  stratifiedSample,
} from "./metrics.ts";
import { readFreeze, runClassifier } from "./run.ts";
import { readActions } from "./store.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FREEZE = "2026-11-06T20:00:00+05:30";
const BEFORE = "2026-11-06T10:00:00.000Z";
const AFTER = "2026-11-06T16:00:00.000Z";

/** Synthetic rows for testing the arithmetic. None of this is a result. */
function row(id: string, overrides: Partial<ActionRow> = {}): ActionRow {
  return {
    id,
    at: AFTER,
    source: "hook",
    vendor: "claude",
    agent: "coder",
    kind: "shell",
    class: null,
    decision: "allow",
    request_id: null,
    raw: null,
    ...overrides,
  };
}

describe("Cohen's kappa", () => {
  it("matches the textbook example", () => {
    const pairs: ["risky" | "safe", "risky" | "safe"][] = [
      ...Array<["risky", "risky"]>(20).fill(["risky", "risky"]),
      ...Array<["risky", "safe"]>(5).fill(["risky", "safe"]),
      ...Array<["safe", "risky"]>(10).fill(["safe", "risky"]),
      ...Array<["safe", "safe"]>(15).fill(["safe", "safe"]),
    ];
    expect(cohensKappa(pairs)).toBeCloseTo(0.4);
  });

  it("is 1 for perfect agreement and undefined when there's nothing to tell apart", () => {
    expect(
      cohensKappa([
        ["risky", "risky"],
        ["safe", "safe"],
      ]),
    ).toBeCloseTo(1);
    expect(
      cohensKappa([
        ["safe", "safe"],
        ["safe", "safe"],
      ]),
    ).toBeUndefined();
    expect(cohensKappa([])).toBeUndefined();
  });
});

describe("labels", () => {
  it("reads one label a line and refuses a bad one, saying which", () => {
    expect(parseLabels('{"id":"a","label":"risky","labeller":"x"}\n\n')).toHaveLength(1);
    expect(() => parseLabels('{"id":"a","label":"maybe","labeller":"x"}')).toThrow(/line 1/);
    expect(() => parseLabels("nonsense")).toThrow(/line 1 is not JSON/);
  });

  it("takes a single labeller's word, with no kappa to report", () => {
    const { final, agreement } = resolveLabels([{ id: "a", label: "risky", labeller: "p" }]);
    expect(final.get("a")).toBe("risky");
    expect(agreement.kappa).toBeUndefined();
    expect(agreement.labellers).toEqual(["p"]);
  });

  it("computes kappa with two labellers, and leaves unresolved disagreements out", () => {
    const { final, agreement } = resolveLabels([
      { id: "a", label: "risky", labeller: "p" },
      { id: "a", label: "risky", labeller: "q" },
      { id: "b", label: "safe", labeller: "p" },
      { id: "b", label: "safe", labeller: "q" },
      { id: "c", label: "risky", labeller: "p" },
      { id: "c", label: "safe", labeller: "q" },
    ]);
    expect(agreement.compared).toBe(3);
    expect(agreement.kappa).toBeDefined();
    expect(agreement.disagreements).toBe(1);
    expect(agreement.unresolved).toBe(1);
    expect(final.has("c")).toBe(false);
  });

  it("lets a resolved line settle a disagreement, without changing the kappa", () => {
    const { final, agreement } = resolveLabels([
      { id: "c", label: "risky", labeller: "p" },
      { id: "c", label: "safe", labeller: "q" },
      { id: "c", label: "risky", labeller: "resolved" },
    ]);
    expect(final.get("c")).toBe("risky");
    expect(agreement.unresolved).toBe(0);
    expect(agreement.labellers).toEqual(["p", "q"]);
  });
});

describe("the metrics", () => {
  it("scores held-out calls only: the ones before the freeze tuned the policy", () => {
    const rows = [
      row("old", { at: BEFORE, decision: "allow" }),
      row("new", { decision: "hold", request_id: "CLR-1" }),
    ];
    const labels = new Map<string, "risky" | "safe">([
      ["old", "risky"],
      ["new", "risky"],
    ]);
    const result = computeMetrics(rows, labels, FREEZE);
    expect(result.corpus_calls).toBe(2);
    expect(result.held_out_calls).toBe(1);
    expect(result.labelled_calls).toBe(1);
    expect(result.recall.clearance).toBe(1);
  });

  it("measures recall as risky calls held or denied, and lists what it missed", () => {
    const rows = [
      row("a", { decision: "hold", request_id: "CLR-1", class: "refund" }),
      row("b", { decision: "deny", class: "protected_config" }),
      row("c", { decision: "allow", class: "refund" }),
    ];
    const result = computeMetrics(
      rows,
      new Map([
        ["a", "risky"],
        ["b", "risky"],
        ["c", "risky"],
      ]),
      FREEZE,
    );
    expect(result.recall.clearance).toBeCloseTo(2 / 3);
    expect(result.misses).toEqual([{ id: "c", class: "refund", decision: "allow" }]);
    expect(result.business_class_recall.refund).toEqual({ risky: 2, caught: 1 });
  });

  it("measures false holds on safe calls", () => {
    const rows = [
      row("a", { decision: "hold", request_id: "CLR-1" }),
      row("b"),
      row("c"),
      row("d"),
    ];
    const labels = new Map<string, "risky" | "safe">([
      ["a", "safe"],
      ["b", "safe"],
      ["c", "safe"],
      ["d", "safe"],
    ]);
    expect(computeMetrics(rows, labels, FREEZE).false_hold_rate.clearance).toBeCloseTo(0.25);
  });

  it("counts one card per request however many calls hit it, and shares over all held-out calls", () => {
    const rows = [
      row("a", { decision: "hold", request_id: "CLR-1" }),
      row("b", { decision: "hold", request_id: "CLR-1" }),
      row("c"),
      row("d", { kind: "file_read" }),
    ];
    const result = computeMetrics(rows, new Map([["a", "risky"]]), FREEZE);
    expect(result.cards_per_100.clearance).toBe(25);
    expect(result.no_card_share.clearance).toBe(0.5);
  });

  it("computes approval-required from the same calls", () => {
    expect(approvalRequiredAsks(row("a", { kind: "shell" }))).toBe(true);
    expect(approvalRequiredAsks(row("a", { kind: "file_write" }))).toBe(true);
    expect(approvalRequiredAsks(row("a", { kind: "business" }))).toBe(true);
    expect(approvalRequiredAsks(row("a", { kind: "file_read" }))).toBe(false);
    const rows = [row("a", { kind: "shell" }), row("b", { kind: "file_read" })];
    const result = computeMetrics(
      rows,
      new Map([
        ["a", "risky"],
        ["b", "risky"],
      ]),
      FREEZE,
    );
    expect(result.cards_per_100.approval_required).toBe(50);
    expect(result.recall.approval_required).toBe(0.5);
    expect(result.no_card_share.approval_required).toBe(0.5);
  });

  it("leaves a rate out rather than calling it zero when there's nothing to divide by", () => {
    const result = computeMetrics([row("a")], new Map([["a", "safe"]]), FREEZE);
    expect(result.recall.clearance).toBeUndefined();
    expect(result.false_hold_rate.clearance).toBe(0);
  });

  describe("in shadow mode, where core records `allow` and keeps its real answer in would_decide", () => {
    const wouldHold = (id: string): ActionRow =>
      row(id, { class: "refund", decision: "allow", would_decide: "hold" });

    it("counts a call it would have held as caught, not as a miss", () => {
      const result = computeMetrics([wouldHold("a")], new Map([["a", "risky"]]), FREEZE);
      expect(result.recall.clearance).toBe(1);
      expect(result.misses).toEqual([]);
      expect(result.business_class_recall.refund).toEqual({ risky: 1, caught: 1 });
    });

    it("counts one it would have held on a safe call as a false hold", () => {
      const result = computeMetrics([wouldHold("a")], new Map([["a", "safe"]]), FREEZE);
      expect(result.false_hold_rate.clearance).toBe(1);
    });

    it("doesn't call it quiet: it would have made a card", () => {
      const result = computeMetrics(
        [wouldHold("a"), wouldHold("b"), row("c"), row("d")],
        new Map(),
        FREEZE,
      );
      expect(result.no_card_share.clearance).toBe(0.5);
      expect(result.cards_per_100.clearance).toBe(50);
    });

    it("still names what it would really have done when it would have allowed a risky call", () => {
      const result = computeMetrics(
        [row("a", { class: "refund", decision: "allow", would_decide: "allow" })],
        new Map([["a", "risky"]]),
        FREEZE,
      );
      expect(result.misses).toEqual([{ id: "a", class: "refund", decision: "allow" }]);
    });

    it("keeps would-hold calls in their own part of the sample", () => {
      const rows = [
        ...Array.from({ length: 50 }, (_, i) => row(`allow-${i}`, { class: "refund" })),
        wouldHold("the-one"),
      ];
      expect(stratifiedSample(rows, 5).map((one) => one.id)).toContain("the-one");
    });
  });

  it("refuses a freeze time it can't read", () => {
    expect(() => computeMetrics([], new Map(), "Friday night")).toThrow(/can't be read/);
  });
});

describe("what a labeller sees", () => {
  it("hides the class and the decision, so nobody grades the policy against itself", () => {
    const blind = blindRow(
      row("a", {
        class: "refund",
        decision: "hold",
        raw: '{"tool_name":"Bash","tool_input":{"command":"ls"}}',
      }),
    );
    expect(blind).not.toHaveProperty("class");
    expect(blind).not.toHaveProperty("decision");
    expect(blind.label).toBeNull();
    expect(blind.what).toBe("Bash ls");
  });

  it("describes gate calls too", () => {
    const raw = JSON.stringify({ method: "POST", path: "/acme/refunds", body: { amount: 40000 } });
    expect(describeCall(row("a", { raw }))).toBe('POST /acme/refunds {"amount":40000}');
  });

  it("strips anything shaped like a secret", () => {
    expect(redact("curl -H 'Authorization: Bearer abc123'")).toContain("[redacted]");
    expect(redact("x-acme-admin-key: abcdef")).not.toContain("abcdef");
    expect(redact(`token ${"a".repeat(48)}`)).toBe("token [redacted]");
    expect(redact("key sk-abcdefghijkl")).toBe("key [redacted]");
    expect(redact("ls -la")).toBe("ls -la");
  });

  it("survives a raw payload that isn't JSON", () => {
    expect(describeCall(row("a", { raw: "not json" }))).toBe("not json");
  });
});

describe("the sample", () => {
  const many = (prefix: string, count: number, overrides: Partial<ActionRow>): ActionRow[] =>
    Array.from({ length: count }, (_, index) => row(`${prefix}-${index}`, overrides));
  const corpus = [
    ...many("read", 900, { kind: "file_read" }),
    ...many("shell", 90, { kind: "shell" }),
    ...many("refund", 5, { kind: "business", class: "refund", decision: "hold" }),
    ...many("deploy", 1, { kind: "business", class: "deploy", decision: "hold" }),
  ];

  it("is the size asked for", () => {
    expect(stratifiedSample(corpus, 300)).toHaveLength(300);
  });

  it("keeps a rare class that a plain random sample would lose", () => {
    const sample = stratifiedSample(corpus, 50);
    expect(sample.some((one) => one.class === "deploy")).toBe(true);
    expect(sample.some((one) => one.class === "refund")).toBe(true);
  });

  it("stays roughly in proportion above that", () => {
    const reads = stratifiedSample(corpus, 100).filter((one) => one.kind === "file_read").length;
    expect(reads).toBeGreaterThan(80);
  });

  it("gives the same sample every time, and never repeats a call", () => {
    const first = stratifiedSample(corpus, 100).map((one) => one.id);
    expect(stratifiedSample(corpus, 100).map((one) => one.id)).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
  });

  it("takes everything when the corpus is smaller than the sample", () => {
    expect(stratifiedSample(corpus.slice(-6), 300)).toHaveLength(6);
  });
});

describe("the command", () => {
  let dir: string;
  let dbPath: string;
  let labelsPath: string;
  let outFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e3-"));
    dbPath = join(dir, "actions.sqlite");
    labelsPath = join(dir, "labels.jsonl");
    outFile = join(dir, "out", "classifier.json");
    const db = new DatabaseSync(dbPath);
    db.exec(
      "CREATE TABLE actions (id TEXT PRIMARY KEY, at TEXT, source TEXT, vendor TEXT, agent TEXT, kind TEXT, class TEXT, tier TEXT, score REAL, call_hash TEXT, decision TEXT, step TEXT, request_id TEXT, raw TEXT)",
    );
    const insert = db.prepare(
      "INSERT INTO actions (id, at, source, vendor, agent, kind, class, decision, request_id) VALUES (?, ?, 'hook', 'claude', 'coder', 'shell', ?, ?, ?)",
    );
    insert.run("old", BEFORE, null, "allow", null);
    insert.run("a", AFTER, "refund", "hold", "CLR-1");
    insert.run("b", AFTER, null, "allow", null);
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = () => runClassifier({ dbPath, labelsPath, freezeAt: FREEZE, outFile });

  it("reads what shadow mode would have done, and copes with a database from before that column", () => {
    expect(readActions(dbPath).every((one) => one.would_decide === null)).toBe(true);
    const db = new DatabaseSync(dbPath);
    db.exec("ALTER TABLE actions ADD COLUMN would_decide TEXT");
    db.prepare("UPDATE actions SET would_decide = 'hold' WHERE id = 'b'").run();
    db.close();
    expect(readActions(dbPath).find((one) => one.id === "b")?.would_decide).toBe("hold");
  });

  it("reads the actions table", () => {
    expect(readActions(dbPath).map((one) => one.id)).toEqual(["old", "a", "b"]);
  });

  it("says no labels and produces no number, not even the ones it could work out", () => {
    const result = run();
    expect(result.status).toBe("no labels");
    expect(result.status !== "ok" && result.message).toMatch(/no labels/);
    expect(existsSync(outFile)).toBe(false);
  });

  it("says the same for an empty labels file", () => {
    writeFileSync(labelsPath, "\n");
    expect(run().status).toBe("no labels");
    expect(existsSync(outFile)).toBe(false);
  });

  it("produces no number when every label is on a call before the freeze", () => {
    writeFileSync(labelsPath, '{"id":"old","label":"safe","labeller":"p"}\n');
    expect(run().status).toBe("no held-out labels");
    expect(existsSync(outFile)).toBe(false);
  });

  it("writes held-out numbers once it has labels, and says they're held-out", () => {
    writeFileSync(
      labelsPath,
      '{"id":"a","label":"risky","labeller":"p"}\n{"id":"b","label":"safe","labeller":"p"}\n',
    );
    expect(run().status).toBe("ok");
    const written = JSON.parse(readFileSync(outFile, "utf8")) as Record<string, unknown>;
    expect(written.experiment).toBe("E3");
    expect(written.held_out_only).toBe(true);
    expect(written.labelled_calls).toBe(2);
    expect(written.held_out_calls).toBe(2);
  });

  it("fails on a missing database", () => {
    expect(() =>
      runClassifier({ dbPath: join(dir, "nope"), labelsPath, freezeAt: FREEZE, outFile }),
    ).toThrow(/no database/);
  });

  it("has the freeze time PLAN gives on record", () => {
    expect(readFreeze(join(here, "freeze.json"))).toBe(FREEZE);
  });
});

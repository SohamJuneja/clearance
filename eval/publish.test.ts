import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { secretValuesIn } from "./lib/secrets.ts";
import { filesToPublish, publishResults, secretIn } from "./publish.ts";

describe("what gets published", () => {
  it("is result files", () => {
    expect(filesToPublish(["vendors.json", "authority.json", "baseline-extra.jsonl"])).toEqual([
      "authority.json",
      "baseline-extra.jsonl",
      "vendors.json",
    ]);
  });

  it("isn't a blind labelling pack or anyone's answers, which could spoil a labeller or name a person", () => {
    expect(filesToPublish(["to-label.jsonl", "to-label.jsonl.prashant.labels.jsonl", "x.labels.jsonl"])).toEqual([]);
  });

  it("isn't a probe, or a database, which a secret scan of text can't read", () => {
    expect(filesToPublish(["vendors-probe.json", "e3-corpus.sqlite"])).toEqual([]);
  });
});

describe("the secret check", () => {
  it("finds a known value", () => {
    expect(secretIn("a made-up-value here", ["made-up-value"])).toBe(true);
  });
  it("finds anything shaped like a real key, known or not", () => {
    expect(secretIn(`sk-ant-${"a".repeat(30)}`, [])).toBe(true);
  });
  it("passes ordinary text", () => {
    expect(secretIn("the refund was held", ["made-up-value"])).toBe(false);
  });
  it("treats a setting as secret by its name, so an agent's name in a .env is left alone", () => {
    const env = ["ACME_ADMIN_KEY=abc", "export GATE_TOKEN='tok'", "CLEARANCE_AGENT=refunds-agent", "# API_SECRET=x", "SOME_PASS="].join("\n");
    expect(secretValuesIn(env)).toEqual(["abc", "tok"]);
  });
});

describe("publishing", () => {
  let dir: string;
  let from: string;
  let to: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clearance-publish-"));
    from = join(dir, "out");
    to = join(dir, "results");
    mkdirSync(from);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("copies the results", () => {
    writeFileSync(join(from, "vendors.json"), '{"runs":200}');
    expect(publishResults(from, to, []).copied).toEqual(["vendors.json"]);
    expect(readFileSync(join(to, "vendors.json"), "utf8")).toBe('{"runs":200}');
  });

  it("writes nothing at all if any one file holds a secret, and names the file", () => {
    writeFileSync(join(from, "a.json"), "{}");
    writeFileSync(join(from, "b.json"), '{"x":"made-up-value"}');
    const outcome = publishResults(from, to, ["made-up-value"]);
    expect(outcome.refused).toEqual(["b.json"]);
    expect(outcome.copied).toEqual([]);
    expect(existsSync(join(to, "a.json"))).toBe(false);
  });

  describe("the corpus of calls", () => {
    const corpusWith = (raw: string): void => {
      const db = new DatabaseSync(join(from, "e3-corpus.sqlite"));
      db.exec(
        "CREATE TABLE actions (id TEXT, at TEXT, source TEXT, vendor TEXT, agent TEXT, kind TEXT, class TEXT, decision TEXT, request_id TEXT, raw TEXT, would_decide TEXT, e2_run TEXT)",
      );
      db.prepare("INSERT INTO actions VALUES ('c1','2026-11-07T00:00:00Z','hook','claude','refunds-agent','shell','safe','allow',NULL,?,NULL,'claude C a #1')").run(raw);
      db.close();
    };

    it("goes out as text a clone can read, keeping the ids people's labels point at", () => {
      corpusWith('{"tool_input":{"command":"ls"}}');
      expect(publishResults(from, to, []).copied).toContain("e3-calls.jsonl");
      const row = JSON.parse(readFileSync(join(to, "e3-calls.jsonl"), "utf8").trim()) as { id: string; e2_run: string };
      expect(row).toMatchObject({ id: "c1", e2_run: "claude C a #1" });
    });

    it("stops everything if a call holds a secret", () => {
      corpusWith('{"tool_input":{"command":"curl -H made-up-value"}}');
      writeFileSync(join(from, "a.json"), "{}");
      const outcome = publishResults(from, to, ["made-up-value"]);
      expect(outcome.refused).toEqual(["e3-corpus.sqlite"]);
      expect(existsSync(join(to, "a.json"))).toBe(false);
    });
  });

  it("does nothing with no results to publish", () => {
    expect(publishResults(join(dir, "missing"), to, [])).toEqual({ copied: [], refused: [] });
  });
});

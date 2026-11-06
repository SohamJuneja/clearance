import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callKeeper, keepCalls, readActions } from "./store.ts";

/** Synthetic rows in core's real table shape. None of this is a result. */
const CORE_TABLE = `CREATE TABLE actions (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, source TEXT NOT NULL, vendor TEXT NOT NULL, agent TEXT NOT NULL,
  kind TEXT NOT NULL, class TEXT, tier TEXT, score REAL, call_hash TEXT, decision TEXT NOT NULL, step TEXT NOT NULL,
  request_id TEXT, raw TEXT, would_decide TEXT, action_json TEXT)`;
const RUN = { vendor: "opencode", condition: "C", intent: "refund-small", repeat: 1 };

describe("keeping E2's calls for E3", () => {
  let dir: string;
  let core: string;
  let corpus: string;

  /** What a reset does: core's database is deleted and starts empty. */
  const wipeCore = (): void => {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${core}${suffix}`, { force: true });
  };
  const coreWith = (...ids: string[]): void => {
    wipeCore();
    const db = new DatabaseSync(core);
    db.exec(CORE_TABLE);
    const insert = db.prepare(
      `INSERT INTO actions (id, at, source, vendor, agent, kind, class, decision, step, request_id, raw, would_decide)
       VALUES (?, '2026-11-07T01:00:00.000Z', 'hook', 'opencode', 'ops-agent', 'shell', 'deploy', 'allow', 'unmatched', NULL, '{"tool_name":"Bash"}', 'hold')`,
    );
    for (const id of ids) insert.run(id);
    db.close();
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e3-keep-"));
    core = join(dir, "clearance.sqlite");
    corpus = join(dir, "out", "e3-corpus.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("has every run's calls at the end, though a reset wiped core before each run", () => {
    for (const [index, ids] of [["a", "b"], ["c"], ["d", "e", "f"]].entries()) {
      coreWith(...ids);
      expect(keepCalls(core, corpus, { ...RUN, repeat: index })).toBe(ids.length);
    }
    wipeCore();
    expect(existsSync(core)).toBe(false);
    expect(readActions(corpus).map((row) => row.id).sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("keeps what E3 reads, including what shadow mode would have done", () => {
    coreWith("a");
    keepCalls(core, corpus, RUN);
    expect(readActions(corpus)[0]).toMatchObject({
      id: "a",
      vendor: "opencode",
      class: "deploy",
      decision: "allow",
      would_decide: "hold",
      raw: '{"tool_name":"Bash"}',
    });
  });

  it("says which run each call came from", () => {
    coreWith("a");
    keepCalls(core, corpus, RUN);
    const db = new DatabaseSync(corpus, { readOnly: true });
    const { e2_run } = db.prepare("SELECT e2_run FROM actions").get() as { e2_run: string };
    db.close();
    expect(e2_run).toBe("opencode C refund-small #1");
  });

  it("doesn't count or change a call it already has", () => {
    coreWith("a");
    expect(keepCalls(core, corpus, RUN)).toBe(1);
    expect(keepCalls(core, corpus, { ...RUN, repeat: 2 })).toBe(0);
    expect(readActions(corpus)).toHaveLength(1);
  });

  it("keeps nothing, and makes no file, when core has no database yet", () => {
    expect(keepCalls(core, corpus, RUN)).toBe(0);
    expect(existsSync(corpus)).toBe(false);
  });

  describe("during a real run", () => {
    it("reports how many it has kept", () => {
      const lines: string[] = [];
      const keep = callKeeper({ from: core, into: corpus, print: (line) => lines.push(line) });
      coreWith("a", "b");
      keep(RUN);
      expect(keep.summary()).toBe(`2 calls kept for E3 in ${corpus}`);
      expect(lines).toEqual([]);
    });

    it("never stops E2 over it, but says so loudly and says so again at the end", () => {
      const lines: string[] = [];
      const keep = callKeeper({ from: core, into: corpus, print: (line) => lines.push(line) });
      writeFileSync(core, "this is not a database");
      expect(() => keep(RUN)).not.toThrow();
      expect(lines.join("\n")).toMatch(/WARNING.*opencode C refund-small #1.*E3/);
      expect(keep.summary()).toMatch(/WARNING: 1 run's calls were not kept/);
    });
  });
});

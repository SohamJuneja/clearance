import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { canonicalJson } from "@clearance/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { runLedgerVerify } from "../src/cli/ledger-verify.js";
import { openDatabase, type Db } from "../src/db/index.js";
import { sha256Hex } from "../src/hash.js";
import { GENESIS_HASH, Ledger, verifyLedger } from "../src/ledger/ledger.js";
import { FakeClock } from "./fakes.js";

let path: string;
let db: Db;
let ledger: Ledger;

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "clearance-ledger-")), "t.sqlite");
  db = openDatabase(path);
  ledger = new Ledger(db, new FakeClock(Date.parse("2026-11-04T14:00:00+05:30")));
  ledger.append("policy_loaded", null, { hash: "abc" });
  ledger.append("held", "CLR-0001", { amount: 40000 });
  ledger.append("routed", "CLR-0001", { to: ["sam"] });
  ledger.append("denied", "CLR-0001", { by: "sam" });
});

/** The triggers stop honest code. An attacker with the file can drop them, which is what verify is for. */
function tamper(sql: string, ...params: unknown[]): void {
  const raw = new Database(path);
  raw.exec("DROP TRIGGER IF EXISTS ledger_no_update; DROP TRIGGER IF EXISTS ledger_no_delete;");
  raw.prepare(sql).run(...params);
  raw.close();
}

describe("ledger", () => {
  it("chains each entry to the one before it", () => {
    const rows = ledger.list();
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
    expect(rows[0]?.prev_hash).toBe(GENESIS_HASH);
    for (let index = 1; index < rows.length; index += 1) {
      expect(rows[index]?.prev_hash).toBe(rows[index - 1]?.entry_hash);
    }
  });

  it("computes entry_hash as sha256(prev_hash || canonical_json(entry))", () => {
    const row = ledger.list()[1];
    if (!row) throw new Error("no row");
    const entry = { seq: row.seq, at: row.at, type: row.type, request_id: row.request_id, payload: row.payload };
    expect(row.entry_hash).toBe(sha256Hex(row.prev_hash + canonicalJson(entry)));
  });

  it("verifies an honest chain", () => {
    const result = verifyLedger(db);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(4);
    expect(result.firstBad).toBeUndefined();
    expect(result.head).toBe(ledger.list()[3]?.entry_hash);
  });

  it("verifies an empty ledger", () => {
    const empty = openDatabase(join(mkdtempSync(join(tmpdir(), "clearance-ledger-")), "e.sqlite"));
    expect(verifyLedger(empty)).toMatchObject({ ok: true, count: 0 });
  });

  it("refuses UPDATE and DELETE through ordinary SQL", () => {
    expect(() => db.prepare("UPDATE ledger SET payload = '{}' WHERE seq = 2").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM ledger WHERE seq = 2").run()).toThrow(/append-only/);
  });

  it("names the row when a payload is changed", () => {
    tamper(`UPDATE ledger SET payload = ? WHERE seq = 2`, canonicalJson({ amount: 4000 }));
    const result = verifyLedger(openDatabase(path));
    expect(result.ok).toBe(false);
    expect(result.firstBad?.seq).toBe(2);
    expect(result.firstBad?.reason).toMatch(/hash/i);
  });

  it("names the row when the type or request is changed", () => {
    tamper(`UPDATE ledger SET type = 'approved' WHERE seq = 3`);
    expect(verifyLedger(openDatabase(path)).firstBad?.seq).toBe(3);
  });

  it("names the first bad row even if later rows were rehashed to match", () => {
    const fresh = openDatabase(path);
    const rows = new Ledger(fresh, new FakeClock(0)).list();
    fresh.close();
    const second = rows[1];
    if (!second) throw new Error("no row");
    const forgedPayload = { amount: 4000 };
    const forgedHash = sha256Hex(
      second.prev_hash +
        canonicalJson({
          seq: second.seq,
          at: second.at,
          type: second.type,
          request_id: second.request_id,
          payload: forgedPayload,
        }),
    );
    tamper(`UPDATE ledger SET payload = ?, entry_hash = ? WHERE seq = 2`, canonicalJson(forgedPayload), forgedHash);
    const result = verifyLedger(openDatabase(path));
    expect(result.ok).toBe(false);
    expect(result.firstBad?.seq).toBe(3);
    expect(result.firstBad?.reason).toMatch(/prev_hash/);
  });

  it("names the gap when a row in the middle is deleted", () => {
    tamper(`DELETE FROM ledger WHERE seq = 2`);
    const result = verifyLedger(openDatabase(path));
    expect(result.ok).toBe(false);
    expect(result.firstBad?.seq).toBe(2);
    expect(result.firstBad?.reason).toMatch(/missing/);
  });

  it("notices the last rows being cut off", () => {
    tamper(`DELETE FROM ledger WHERE seq >= 3`);
    const result = verifyLedger(openDatabase(path));
    expect(result.ok).toBe(false);
    expect(result.firstBad?.seq).toBe(3);
  });

  it("reports a payload that is no longer JSON as a bad row, not a crash", () => {
    tamper(`UPDATE ledger SET payload = 'not json' WHERE seq = 4`);
    expect(verifyLedger(openDatabase(path)).firstBad?.seq).toBe(4);
  });

  it("lists by request and after a sequence number", () => {
    expect(ledger.list({ requestId: "CLR-0001" }).map((row) => row.type)).toEqual(["held", "routed", "denied"]);
    expect(ledger.list({ afterSeq: 3 }).map((row) => row.seq)).toEqual([4]);
    expect(ledger.list({ limit: 2 }).map((row) => row.seq)).toEqual([1, 2]);
  });
});

describe("pnpm ledger:verify", () => {
  it("exits 0 on an honest ledger", () => {
    const { code, output } = runLedgerVerify(path);
    expect(code).toBe(0);
    expect(output).toContain("4 entries");
  });

  it("exits 1 and names the row on a tampered ledger", () => {
    tamper(`UPDATE ledger SET payload = '{}' WHERE seq = 3`);
    const { code, output } = runLedgerVerify(path);
    expect(code).toBe(1);
    expect(output).toContain("seq 3");
  });

  it("exits 2 when there is no database", () => {
    const { code, output } = runLedgerVerify(join(tmpdir(), "clearance-no-such-file.sqlite"));
    expect(code).toBe(2);
    expect(output).toMatch(/cannot open/i);
  });
});

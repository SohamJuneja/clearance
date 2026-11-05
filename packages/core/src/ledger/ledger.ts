/**
 * Append-only hash-chained ledger (F8). Each entry has
 * entry_hash = sha256(prev_hash || canonical_json({seq, at, type, request_id, payload})).
 * Triggers refuse UPDATE and DELETE; `verify` is what catches someone who drops them.
 */
import { canonicalJson, type Clock, type LedgerEntryType } from "@clearance/contracts";
import type { Db } from "../db/index.js";
import { sha256Hex } from "../hash.js";

export const GENESIS_HASH = "0".repeat(64);
const HEAD_KEY = "ledger_head_seq";

export type LedgerEntry = {
  seq: number;
  at: string;
  type: LedgerEntryType;
  request_id: string | null;
  payload: Record<string, unknown>;
  prev_hash: string;
  entry_hash: string;
};

type LedgerRow = Omit<LedgerEntry, "payload"> & { payload: string };

function hashEntry(entry: Omit<LedgerEntry, "entry_hash" | "prev_hash">, prevHash: string): string {
  return sha256Hex(
    prevHash +
      canonicalJson({
        seq: entry.seq,
        at: entry.at,
        type: entry.type,
        request_id: entry.request_id,
        payload: entry.payload,
      }),
  );
}

export class Ledger {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  append(type: LedgerEntryType, requestId: string | null, payload: Record<string, unknown>): LedgerEntry {
    const write = this.db.transaction((): LedgerEntry => {
      const last = this.db.prepare(`SELECT seq, entry_hash FROM ledger ORDER BY seq DESC LIMIT 1`).get() as
        | { seq: number; entry_hash: string }
        | undefined;
      const seq = (last?.seq ?? 0) + 1;
      const prevHash = last?.entry_hash ?? GENESIS_HASH;
      const at = new Date(this.clock.nowMs()).toISOString();
      // Round trip so the stored text and the hashed value cannot disagree about undefined.
      const clean = JSON.parse(canonicalJson(payload)) as Record<string, unknown>;
      const entryHash = hashEntry({ seq, at, type, request_id: requestId, payload: clean }, prevHash);
      this.db
        .prepare(`INSERT INTO ledger (seq, at, type, request_id, payload, prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(seq, at, type, requestId, canonicalJson(clean), prevHash, entryHash);
      this.db
        .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
        .run(HEAD_KEY, String(seq));
      return { seq, at, type, request_id: requestId, payload: clean, prev_hash: prevHash, entry_hash: entryHash };
    });
    return write.immediate();
  }

  list(options: { requestId?: string; afterSeq?: number; limit?: number } = {}): LedgerEntry[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.requestId) {
      clauses.push("request_id = ?");
      params.push(options.requestId);
    }
    if (options.afterSeq !== undefined) {
      clauses.push("seq > ?");
      params.push(options.afterSeq);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = options.limit !== undefined ? `LIMIT ${Math.max(0, Math.floor(options.limit))}` : "";
    const rows = this.db.prepare(`SELECT * FROM ledger ${where} ORDER BY seq ${limit}`).all(...params) as LedgerRow[];
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> }));
  }
}

export type LedgerVerification = {
  ok: boolean;
  count: number;
  head: string;
  firstBad?: { seq: number; reason: string };
};

/** Recompute the chain from the start. Reads only, so it works on a read-only connection. */
export function verifyLedger(db: Db): LedgerVerification {
  const rows = db.prepare(`SELECT * FROM ledger ORDER BY seq`).iterate() as IterableIterator<LedgerRow>;
  let expectedSeq = 1;
  let prevHash = GENESIS_HASH;
  let count = 0;
  const bad = (seq: number, reason: string): LedgerVerification => ({
    ok: false,
    count,
    head: prevHash,
    firstBad: { seq, reason },
  });
  let failure: LedgerVerification | null = null;
  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      failure = bad(expectedSeq, `row ${expectedSeq} is missing`);
      break;
    }
    if (row.prev_hash !== prevHash) {
      failure = bad(row.seq, "prev_hash does not match the entry before it");
      break;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      failure = bad(row.seq, "payload is not valid JSON");
      break;
    }
    const expected = hashEntry({ ...row, payload }, row.prev_hash);
    if (row.entry_hash !== expected) {
      failure = bad(row.seq, "entry_hash does not match the entry's contents");
      break;
    }
    prevHash = row.entry_hash;
    expectedSeq += 1;
    count += 1;
  }
  if (failure) {
    rows.return?.();
    return failure;
  }
  const head = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(HEAD_KEY) as { value: string } | undefined;
  if (head && Number(head.value) > count) return bad(count + 1, `row ${count + 1} is missing: the ledger was cut short`);
  return { ok: true, count, head: prevHash };
}

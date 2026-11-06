/**
 * How real requests add up, shared by the daily digest (F22) and the report (F23) so the two can't come to read
 * differently. Reads and counts. Nothing that decides anything looks here.
 */
import type { RequestState } from "@clearance/contracts";
import type { Db } from "../db/index.js";
import { OPEN_STATES } from "../requests/store.js";

/** For a query about requests, or anything joined to them, that leaves out the ones still open. */
export const OPEN_STATES_SQL = OPEN_STATES.map((state) => `'${state}'`).join(", ");

export type RequestFacts = {
  id: string;
  cls: string;
  state: RequestState;
  createdAtMs: number;
  decidedAtMs: number | null;
  /** Earned autonomy ran it, so nobody was asked. The ledger never recorded it as held, whatever became of it after. */
  ranAlone: boolean;
  /** A smaller offer on another request (F20). The first request carries the wait and the money. */
  editOf: boolean;
  /** The call's extracted amount as it was recorded, unread. Undefined when the record has none or can't be parsed. */
  amount: unknown;
  /** Whether the call had an amount at all. */
  hasAmount: boolean;
};

type Row = { id: string; class: string; state: RequestState; created_at: number; decided_at: number | null; evidence: string; was_held: number };

function factsOf(row: Row): RequestFacts {
  let evidence: { extracted?: Record<string, unknown>; editOf?: unknown } = {};
  try {
    evidence = JSON.parse(row.evidence) as typeof evidence;
  } catch {
    // Counted, with no amount and no edit. What it can't say stays unsaid.
  }
  const extracted = evidence.extracted ?? {};
  return {
    id: row.id,
    cls: row.class,
    state: row.state,
    createdAtMs: row.created_at,
    decidedAtMs: row.decided_at,
    ranAlone: row.was_held === 0,
    editOf: evidence.editOf !== undefined,
    amount: extracted.amount,
    hasAmount: "amount" in extracted,
  };
}

/** Every real request made after this time, oldest first. Drills are nobody's record. */
export function readRequestFacts(db: Db, afterMs: number): RequestFacts[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.class, r.state, r.created_at, r.decided_at, r.evidence,
              EXISTS (SELECT 1 FROM ledger l WHERE l.request_id = r.id AND l.type = 'held') AS was_held
       FROM requests r WHERE r.is_drill = 0 AND r.created_at > ? ORDER BY r.created_at, r.id`,
    )
    .all(afterMs) as Row[];
  return rows.map(factsOf);
}

export type RequestTally = {
  held: number;
  approved: number;
  denied: number;
  expired: number;
  cancelled: number;
  ran_alone: number;
  edited: number;
  outcome_unknown: number;
};

export function tallyRequests(rows: RequestFacts[]): RequestTally {
  const held = rows.filter((row) => !row.ranAlone);
  const inState = (...states: RequestState[]) => held.filter((row) => states.includes(row.state)).length;
  return {
    held: held.length,
    approved: inState("APPROVED", "EXECUTED", "GRANTED", "CONSUMED"),
    denied: inState("DENIED"),
    expired: inState("EXPIRED"),
    cancelled: inState("CANCELLED"),
    // A person can settle an unknown outcome as "it ran", and then it ran alone just the same.
    ran_alone: rows.filter((row) => row.ranAlone && (row.state === "AUTO" || row.state === "EXECUTED")).length,
    edited: inState("EDITED"),
    outcome_unknown: rows.filter((row) => row.state === "OUTCOME_UNKNOWN").length,
  };
}

/** Closed with nobody deciding. These have a closing time like any other, and it says nothing about anyone. */
const NOBODY_DECIDED: RequestState[] = ["EXPIRED", "CANCELLED"];

/** Someone looked at a held card and decided. A smaller offer's instant yes is the same decision over again. */
export function isDecision(row: RequestFacts): boolean {
  return !row.ranAlone && !row.editOf && row.decidedAtMs !== null && !NOBODY_DECIDED.includes(row.state);
}

/** The lower median from hold to decision, or null with nothing decided. */
export function medianDecisionMs(rows: RequestFacts[]): number | null {
  const waits = rows.filter(isDecision).map((row) => (row.decidedAtMs as number) - row.createdAtMs).sort((a, b) => a - b);
  return waits.length > 0 ? (waits[Math.floor((waits.length - 1) / 2)] as number) : null;
}

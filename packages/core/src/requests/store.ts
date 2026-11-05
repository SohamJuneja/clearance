/**
 * Requests and their state machine (F3):
 *   HELD -> ROUTED -> APPROVED | DENIED | EXPIRED | CANCELLED | BREAK_GLASS -> EXECUTED | GRANTED -> CONSUMED | VOIDED
 * INELIGIBLE_ANSWER and REROUTED are ledger events, not states: an ineligible answer leaves the request ROUTED.
 */
import type { Action, CanonicalCall, Clock, Flag, RequestState, Tier } from "@clearance/contracts";
import type { Db } from "../db/index.js";
import type { Ledger } from "../ledger/ledger.js";

export const TRANSITIONS: Record<RequestState, RequestState[]> = {
  HELD: ["ROUTED", "EXPIRED", "CANCELLED"],
  ROUTED: ["APPROVED", "DENIED", "EXPIRED", "CANCELLED", "BREAK_GLASS"],
  APPROVED: ["EXECUTED", "GRANTED", "VOIDED"],
  BREAK_GLASS: ["EXECUTED", "GRANTED"],
  GRANTED: ["CONSUMED", "VOIDED"],
  DENIED: [],
  EXPIRED: [],
  CANCELLED: [],
  EXECUTED: [],
  CONSUMED: [],
  VOIDED: [],
};

const DECIDED: RequestState[] = ["APPROVED", "DENIED", "EXPIRED", "CANCELLED", "BREAK_GLASS"];

export const OPEN_STATES: RequestState[] = ["HELD", "ROUTED"];

export class IllegalTransition extends Error {
  constructor(id: string, from: RequestState, to: RequestState) {
    super(`${id}: ${from} -> ${to} is not allowed`);
    this.name = "IllegalTransition";
  }
}

export type NewRequest = {
  actionId: string;
  source: Action["source"];
  vendor: Action["vendor"];
  agent: string;
  callHash: string;
  cls: string;
  target: string;
  call: CanonicalCall;
  tier: Tier;
  score: number;
  requesterIds: string[];
  agentOwnerId: string | null;
  originRoom: string | null;
  originThread: string | null;
  evidence: Record<string, unknown>;
  flags: Flag[];
  quorumRequired: number;
  expiresAtMs: number;
  isDrill?: boolean;
};

export type RequestRecord = Required<Omit<NewRequest, "isDrill">> & {
  id: string;
  state: RequestState;
  isDrill: boolean;
  createdAtMs: number;
  decidedAtMs: number | null;
  execAttempts: number;
};

type Row = {
  id: string;
  action_id: string;
  source: Action["source"];
  vendor: Action["vendor"];
  agent: string;
  call_hash: string;
  class: string;
  target: string;
  call: string;
  tier: Tier;
  score: number;
  state: RequestState;
  requester_ids: string;
  agent_owner_id: string | null;
  origin_room: string | null;
  origin_thread: string | null;
  evidence: string;
  flags: string;
  quorum_required: number;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
  exec_attempts: number;
  is_drill: number;
};

function fromRow(row: Row): RequestRecord {
  return {
    id: row.id,
    actionId: row.action_id,
    source: row.source,
    vendor: row.vendor,
    agent: row.agent,
    callHash: row.call_hash,
    cls: row.class,
    target: row.target,
    call: JSON.parse(row.call) as CanonicalCall,
    tier: row.tier,
    score: row.score,
    state: row.state,
    requesterIds: JSON.parse(row.requester_ids) as string[],
    agentOwnerId: row.agent_owner_id,
    originRoom: row.origin_room,
    originThread: row.origin_thread,
    evidence: JSON.parse(row.evidence) as Record<string, unknown>,
    flags: JSON.parse(row.flags) as Flag[],
    quorumRequired: row.quorum_required,
    createdAtMs: row.created_at,
    expiresAtMs: row.expires_at,
    decidedAtMs: row.decided_at,
    execAttempts: row.exec_attempts,
    isDrill: row.is_drill === 1,
  };
}

export class RequestStore {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly clock: Clock,
  ) {}

  private nextId(): string {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'request_seq'`).get() as
      | { value: string }
      | undefined;
    const next = Number(row?.value ?? 0) + 1;
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES ('request_seq', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
      .run(String(next));
    return `CLR-${String(next).padStart(4, "0")}`;
  }

  create(input: NewRequest): RequestRecord {
    const write = this.db.transaction((): RequestRecord => {
      const id = this.nextId();
      const now = this.clock.nowMs();
      this.db
        .prepare(
          `INSERT INTO requests (id, action_id, source, vendor, agent, call_hash, class, target, call, tier, score, state,
             requester_ids, agent_owner_id, origin_room, origin_thread, evidence, flags, quorum_required, created_at, expires_at, is_drill)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'HELD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.actionId,
          input.source,
          input.vendor,
          input.agent,
          input.callHash,
          input.cls,
          input.target,
          JSON.stringify(input.call),
          input.tier,
          input.score,
          JSON.stringify(input.requesterIds),
          input.agentOwnerId,
          input.originRoom,
          input.originThread,
          JSON.stringify(input.evidence),
          JSON.stringify(input.flags),
          input.quorumRequired,
          now,
          input.expiresAtMs,
          input.isDrill ? 1 : 0,
        );
      this.ledger.append("held", id, {
        action_id: input.actionId,
        agent: input.agent,
        vendor: input.vendor,
        class: input.cls,
        target: input.target,
        call_hash: input.callHash,
        tier: input.tier,
        score: input.score,
        flags: input.flags.map((flag) => flag.code),
        requesters: input.requesterIds,
        expires_at: new Date(input.expiresAtMs).toISOString(),
      });
      return this.require(id);
    });
    return write.immediate();
  }

  get(id: string): RequestRecord | null {
    const row = this.db.prepare(`SELECT * FROM requests WHERE id = ?`).get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  require(id: string): RequestRecord {
    const request = this.get(id);
    if (!request) throw new Error(`no request ${id}`);
    return request;
  }

  findOpen(callHash: string, agent: string): RequestRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM requests WHERE call_hash = ? AND agent = ? AND state IN ('HELD', 'ROUTED') ORDER BY created_at DESC LIMIT 1`)
      .get(callHash, agent) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  listInState(states: RequestState[]): RequestRecord[] {
    const marks = states.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM requests WHERE state IN (${marks}) ORDER BY created_at`)
      .all(...states) as Row[];
    return rows.map(fromRow);
  }

  listExpired(nowMs: number): RequestRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM requests WHERE state IN ('HELD', 'ROUTED') AND expires_at <= ? ORDER BY expires_at`)
      .all(nowMs) as Row[];
    return rows.map(fromRow);
  }

  transition(id: string, to: RequestState): RequestRecord {
    const current = this.require(id);
    if (!TRANSITIONS[current.state].includes(to)) throw new IllegalTransition(id, current.state, to);
    const decidedAt = DECIDED.includes(to) ? this.clock.nowMs() : current.decidedAtMs;
    const result = this.db
      .prepare(`UPDATE requests SET state = ?, decided_at = ? WHERE id = ? AND state = ?`)
      .run(to, decidedAt, id, current.state);
    if (result.changes !== 1) throw new IllegalTransition(id, current.state, to);
    return { ...current, state: to, decidedAtMs: decidedAt };
  }

  /** Requesters are fixed at hold time; this is for evidence filled in once routing has run. */
  updateEvidence(id: string, evidence: Record<string, unknown>): void {
    this.db.prepare(`UPDATE requests SET evidence = ? WHERE id = ?`).run(JSON.stringify(evidence), id);
  }

  noteExecutionAttempt(id: string): number {
    this.db.prepare(`UPDATE requests SET exec_attempts = exec_attempts + 1 WHERE id = ?`).run(id);
    return this.require(id).execAttempts;
  }
}

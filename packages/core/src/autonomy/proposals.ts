/**
 * Things that take more than one person to change: a promotion up the ladder (F11), a policy edit (F17).
 * A proposal opens once per subject, counts distinct people, and one no ends it. Each vote is one person's, ever.
 */
import type { Db } from "../db/index.js";

export type ProposalKind = "promotion" | "policy_change";
export type ProposalState = "open" | "signed" | "rejected" | "expired";

export type Proposal = {
  id: string;
  kind: ProposalKind;
  /** What it is about. At most one open per subject. */
  subject: string;
  state: ProposalState;
  /** The card's words and whatever applying it needs. */
  payload: Record<string, unknown> & { title: string; detail: string };
  quorum: number;
  /** People who can't sign this one: the agent's owner, or whoever it would otherwise hand power to. */
  exclude: string[];
  createdAtMs: number;
  expiresAtMs: number;
  decidedAtMs: number | null;
};

type Row = {
  id: string;
  kind: ProposalKind;
  subject: string;
  state: ProposalState;
  payload: string;
  quorum: number;
  exclude: string;
  created_at: number;
  expires_at: number;
  decided_at: number | null;
};

function fromRow(row: Row): Proposal {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    state: row.state,
    payload: JSON.parse(row.payload) as Proposal["payload"],
    quorum: row.quorum,
    exclude: JSON.parse(row.exclude) as string[],
    createdAtMs: row.created_at,
    expiresAtMs: row.expires_at,
    decidedAtMs: row.decided_at,
  };
}

export class ProposalStore {
  constructor(private readonly db: Db) {}

  private nextId(): string {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'proposal_seq'`).get() as { value: string } | undefined;
    const next = Number(row?.value ?? 0) + 1;
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES ('proposal_seq', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
      .run(String(next));
    return `PROP-${String(next).padStart(4, "0")}`;
  }

  create(input: {
    kind: ProposalKind;
    subject: string;
    payload: Proposal["payload"];
    quorum: number;
    exclude: string[];
    atMs: number;
    expiresAtMs: number;
  }): Proposal {
    const id = this.nextId();
    this.db
      .prepare(
        `INSERT INTO proposals (id, kind, subject, state, payload, quorum, exclude, created_at, expires_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
      )
      .run(id, input.kind, input.subject, JSON.stringify(input.payload), input.quorum, JSON.stringify(input.exclude), input.atMs, input.expiresAtMs);
    return this.get(id) as Proposal;
  }

  get(id: string): Proposal | null {
    const row = this.db.prepare(`SELECT * FROM proposals WHERE id = ?`).get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  all(): Proposal[] {
    return (this.db.prepare(`SELECT * FROM proposals ORDER BY created_at, id`).all() as Row[]).map(fromRow);
  }

  openFor(subject: string): Proposal | null {
    const row = this.db.prepare(`SELECT * FROM proposals WHERE subject = ? AND state = 'open' LIMIT 1`).get(subject) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  allOpen(): Proposal[] {
    return (this.db.prepare(`SELECT * FROM proposals WHERE state = 'open' ORDER BY created_at, id`).all() as Row[]).map(fromRow);
  }

  /** The open proposal of this kind, if there is one. */
  openOfKind(kind: ProposalKind): Proposal | null {
    const row = this.db.prepare(`SELECT * FROM proposals WHERE kind = ? AND state = 'open' LIMIT 1`).get(kind) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  rejectedSince(subject: string, sinceMs: number): boolean {
    return (
      this.db.prepare(`SELECT 1 FROM proposals WHERE subject = ? AND state = 'rejected' AND decided_at >= ? LIMIT 1`).get(subject, sinceMs) !==
      undefined
    );
  }

  listExpired(nowMs: number): Proposal[] {
    return (this.db.prepare(`SELECT * FROM proposals WHERE state = 'open' AND expires_at <= ?`).all(nowMs) as Row[]).map(fromRow);
  }

  setState(id: string, state: ProposalState, atMs: number): void {
    this.db.prepare(`UPDATE proposals SET state = ?, decided_at = ? WHERE id = ?`).run(state, atMs, id);
  }

  /** False when this person has already answered: a second account changes nothing. */
  vote(input: { proposalId: string; userId: string; decision: "approve" | "deny"; switchRequestId: string; atMs: number }): boolean {
    const result = this.db
      .prepare(`INSERT OR IGNORE INTO proposal_votes (proposal_id, user_id, decision, switch_request_id, at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.proposalId, input.userId, input.decision, input.switchRequestId, input.atMs);
    return result.changes === 1;
  }

  /** In the order they signed. */
  signers(id: string): string[] {
    const rows = this.db
      .prepare(`SELECT user_id FROM proposal_votes WHERE proposal_id = ? AND decision = 'approve' ORDER BY at, rowid`)
      .all(id) as { user_id: string }[];
    return rows.map((row) => row.user_id);
  }

  voters(id: string): string[] {
    const rows = this.db.prepare(`SELECT user_id FROM proposal_votes WHERE proposal_id = ?`).all(id) as { user_id: string }[];
    return rows.map((row) => row.user_id);
  }

  cardAnswered(switchRequestId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM proposal_votes WHERE switch_request_id = ? LIMIT 1`).get(switchRequestId) !== undefined;
  }
}

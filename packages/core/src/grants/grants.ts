/**
 * Grants (F3): single use, bound to one call_hash and one agent, valid for a short TTL. Consuming is an
 * IMMEDIATE transaction, so two parallel identical calls cannot both win, even across connections.
 */
import type { Clock } from "@clearance/contracts";
import { ulid } from "ulid";
import type { Db } from "../db/index.js";
import type { Ledger } from "../ledger/ledger.js";
import type { RequestStore } from "../requests/store.js";

export class GrantStore {
  constructor(
    private readonly db: Db,
    private readonly requests: RequestStore,
    private readonly ledger: Ledger,
    private readonly clock: Clock,
  ) {}

  mint(requestId: string, callHash: string, agent: string, ttlMs: number): { id: string; expiresAtMs: number } {
    const id = ulid(this.clock.nowMs());
    const expiresAtMs = this.clock.nowMs() + ttlMs;
    this.db
      .prepare(`INSERT INTO grants (id, request_id, agent, call_hash, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, requestId, agent, callHash, expiresAtMs);
    return { id, expiresAtMs };
  }

  has(callHash: string, agent: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM grants g JOIN requests r ON r.id = g.request_id
           WHERE g.call_hash = ? AND g.agent = ? AND g.consumed_at IS NULL AND g.expires_at > ? AND r.state = 'GRANTED' LIMIT 1`,
        )
        .get(callHash, agent, this.clock.nowMs()) !== undefined
    );
  }

  /** One line can need several grants. It takes them all, or none of them is spent. */
  consumeAll(callHashes: string[], agent: string, actionId: string): { requestIds: string[] } | null {
    const nothingSpent = new Error("a grant in the set is gone");
    const take = this.db.transaction((): { requestIds: string[] } => {
      const requestIds: string[] = [];
      for (const hash of callHashes) {
        const taken = this.consume(hash, agent, actionId);
        if (!taken) throw nothingSpent;
        requestIds.push(taken.requestId);
      }
      return { requestIds };
    });
    try {
      return take.immediate();
    } catch (error) {
      if (error === nothingSpent) return null;
      throw error;
    }
  }

  consume(callHash: string, agent: string, actionId: string): { requestId: string } | null {
    const take = this.db.transaction((): { requestId: string } | null => {
      const now = this.clock.nowMs();
      const grant = this.db
        .prepare(
          `SELECT g.id, g.request_id FROM grants g JOIN requests r ON r.id = g.request_id
           WHERE g.call_hash = ? AND g.agent = ? AND g.consumed_at IS NULL AND g.expires_at > ? AND r.state = 'GRANTED'
           ORDER BY g.expires_at LIMIT 1`,
        )
        .get(callHash, agent, now) as { id: string; request_id: string } | undefined;
      if (!grant) return null;
      const updated = this.db
        .prepare(`UPDATE grants SET consumed_at = ?, consumed_by_action = ? WHERE id = ? AND consumed_at IS NULL`)
        .run(now, actionId, grant.id);
      if (updated.changes !== 1) return null;
      this.requests.transition(grant.request_id, "CONSUMED");
      this.ledger.append("grant_consumed", grant.request_id, {
        grant_id: grant.id,
        call_hash: callHash,
        agent,
        action_id: actionId,
      });
      return { requestId: grant.request_id };
    });
    return take.immediate();
  }

  /** Grants past their TTL void their request, so nothing is left waiting. Returns the voided request ids. */
  voidExpired(): string[] {
    const run = this.db.transaction((): string[] => {
      const rows = this.db
        .prepare(
          `SELECT g.id, g.request_id FROM grants g JOIN requests r ON r.id = g.request_id
           WHERE g.consumed_at IS NULL AND g.expires_at <= ? AND r.state = 'GRANTED'`,
        )
        .all(this.clock.nowMs()) as { id: string; request_id: string }[];
      for (const row of rows) {
        this.requests.transition(row.request_id, "VOIDED");
        this.ledger.append("expired", row.request_id, { what: "grant", grant_id: row.id });
      }
      return rows.map((row) => row.request_id);
    });
    return run.immediate();
  }
}

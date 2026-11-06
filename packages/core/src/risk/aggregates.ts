import type { Db } from "../db/index.js";

export type AggregateRow = {
  cls: string;
  byField: string;
  key: string;
  value: number;
  agent: string;
  actionId: string;
  requestId: string | null;
  atMs: number;
};

/** Sliding-window sums for anti-structuring rules (F14). A window is a query, not a bucket. */
export class AggregateStore {
  constructor(private readonly db: Db) {}

  record(row: AggregateRow): void {
    this.db
      .prepare(
        `INSERT INTO aggregates (class, by_field, key, value, agent, action_id, request_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.cls, row.byField, row.key, row.value, row.agent, row.actionId, row.requestId, row.atMs);
  }

  /** Sum of everything still in play since `sinceMs`, exclusive. Voided rows (denied, expired) don't count. */
  sum(cls: string, byField: string, key: string, sinceMs: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(value), 0) AS total FROM aggregates
         WHERE class = ? AND by_field = ? AND key = ? AND at > ? AND voided = 0`,
      )
      .get(cls, byField, key, sinceMs) as { total: number };
    return row.total;
  }

  /** The same, leaving one request out: what the window would hold if an edit replaced that request's amount. */
  sumWithout(requestId: string, cls: string, byField: string, key: string, sinceMs: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(value), 0) AS total FROM aggregates
         WHERE class = ? AND by_field = ? AND key = ? AND at > ? AND voided = 0 AND request_id IS NOT ?`,
      )
      .get(cls, byField, key, sinceMs, requestId) as { total: number };
    return row.total;
  }

  /** How many calls this agent made in the class since `sinceMs`, and the largest. For the card's context. */
  agentActivity(agent: string, cls: string, sinceMs: number): { count: number; largest: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(MAX(value), 0) AS largest FROM aggregates
         WHERE agent = ? AND class = ? AND at > ? AND voided = 0`,
      )
      .get(agent, cls, sinceMs) as { count: number; largest: number };
    return row;
  }

  /** A denied, expired or cancelled request moved no money, so it leaves the window. */
  voidRequest(requestId: string): void {
    this.db.prepare(`UPDATE aggregates SET voided = 1 WHERE request_id = ?`).run(requestId);
  }
}

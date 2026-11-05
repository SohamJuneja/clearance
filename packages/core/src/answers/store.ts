import type { Db } from "../db/index.js";

export type AnswerDecision = "approve" | "deny";

export type AnswerRow = {
  id: number;
  request_id: string;
  switch_request_id: string;
  answered_by: string | null;
  user_id: string | null;
  decision: AnswerDecision | null;
  latency_ms: number | null;
  eligible: number;
  reason: string | null;
  at: number;
};

/** `answer` carries the id of the option chosen. We offered two; anything else is no decision. */
export function normaliseAnswer(answer: string | null | undefined): AnswerDecision | null {
  if (answer === "allow") return "approve";
  if (answer === "deny") return "deny";
  return null;
}

export class AnswerStore {
  constructor(private readonly db: Db) {}

  record(input: {
    requestId: string;
    switchRequestId: string;
    answeredBy: string | null;
    userId: string | null;
    decision: AnswerDecision | null;
    latencyMs: number;
    eligible: boolean;
    reason: string | null;
    atMs: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO answers (request_id, switch_request_id, answered_by, user_id, decision, latency_ms, eligible, reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.requestId,
        input.switchRequestId,
        input.answeredBy,
        input.userId,
        input.decision,
        input.latencyMs,
        input.eligible ? 1 : 0,
        input.reason,
        input.atMs,
      );
  }

  /** Switch redelivers outcomes until acknowledged: a card is only ever answered once here. */
  existsForCard(switchRequestId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM answers WHERE switch_request_id = ? LIMIT 1`).get(switchRequestId) !== undefined;
  }

  /** Distinct people whose approval counts, in the order they gave it. */
  countedApprovers(requestId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT user_id, MIN(id) AS first FROM answers
         WHERE request_id = ? AND eligible = 1 AND decision = 'approve' AND user_id IS NOT NULL
         GROUP BY user_id ORDER BY first`,
      )
      .all(requestId) as { user_id: string }[];
    return rows.map((row) => row.user_id);
  }

  forRequest(requestId: string): AnswerRow[] {
    return this.db.prepare(`SELECT * FROM answers WHERE request_id = ? ORDER BY id`).all(requestId) as AnswerRow[];
  }
}

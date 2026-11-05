import type { Db } from "../db/index.js";
import type { PastAnswer } from "../rubberstamp/signals.js";

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
  fast: number;
  signals: string | null;
  t_min_ms: number | null;
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
    fast?: boolean;
    signals?: string[];
    tMinMs?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO answers (request_id, switch_request_id, answered_by, user_id, decision, latency_ms, eligible, reason, at, fast, signals, t_min_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.fast ? 1 : 0,
        input.signals ? JSON.stringify(input.signals) : null,
        input.tMinMs ?? null,
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

  /** Whether any counted approval on this request was a fast one. */
  anyFast(requestId: string): boolean {
    return (
      this.db.prepare(`SELECT 1 FROM answers WHERE request_id = ? AND eligible = 1 AND decision = 'approve' AND fast = 1 LIMIT 1`).get(requestId) !==
      undefined
    );
  }

  /** This person's real decisions, newest first. Drills are not part of anyone's record. */
  recentDecisions(userId: string, limit: number): PastAnswer[] {
    const rows = this.db
      .prepare(
        `SELECT a.decision, a.latency_ms, a.t_min_ms, a.at FROM answers a JOIN requests r ON r.id = a.request_id
         WHERE a.user_id = ? AND a.eligible = 1 AND a.decision IS NOT NULL AND r.is_drill = 0
         ORDER BY a.id DESC LIMIT ?`,
      )
      .all(userId, limit) as { decision: string; latency_ms: number | null; t_min_ms: number | null; at: number }[];
    return rows.map((row) => ({
      decision: row.decision,
      latencyMs: row.latency_ms ?? 0,
      tMinMs: row.t_min_ms ?? 0,
      atMs: row.at,
    }));
  }

  /** When this person approved real requests lately. */
  approvalTimes(userId: string, sinceMs: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT a.at FROM answers a JOIN requests r ON r.id = a.request_id
         WHERE a.user_id = ? AND a.eligible = 1 AND a.decision = 'approve' AND r.is_drill = 0 AND a.at >= ?`,
      )
      .all(userId, sinceMs) as { at: number }[];
    return rows.map((row) => row.at);
  }

  /** Who answered this class's real requests since then, one entry per answer. */
  answerers(cls: string, sinceMs: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT a.user_id FROM answers a JOIN requests r ON r.id = a.request_id
         WHERE r.class = ? AND r.is_drill = 0 AND a.eligible = 1 AND a.user_id IS NOT NULL AND a.at > ?`,
      )
      .all(cls, sinceMs) as { user_id: string }[];
    return rows.map((row) => row.user_id);
  }

  /** How many times this person has typed the wrong value on this request. */
  wrongConfirmations(requestId: string, userId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM answers WHERE request_id = ? AND user_id = ? AND reason = 'wrong_confirmation'`)
      .get(requestId, userId) as { count: number };
    return row.count;
  }

  /** People who used up their tries, so they cannot approve this request any other way. */
  failedConfirmations(requestId: string, tries: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT user_id FROM answers WHERE request_id = ? AND reason = 'wrong_confirmation' AND user_id IS NOT NULL
         GROUP BY user_id HAVING COUNT(*) >= ?`,
      )
      .all(requestId, tries) as { user_id: string }[];
    return rows.map((row) => row.user_id);
  }

  forRequest(requestId: string): AnswerRow[] {
    return this.db.prepare(`SELECT * FROM answers WHERE request_id = ? ORDER BY id`).all(requestId) as AnswerRow[];
  }
}

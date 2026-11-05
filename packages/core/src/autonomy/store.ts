import type { Db } from "../db/index.js";
import { percentile95 } from "./promotion.js";

export type Level = "L0" | "L1" | "L2" | "L3";
const ORDER: Level[] = ["L0", "L1", "L2", "L3"];

/** How far back "normal" for a bucket reaches. A week's seed fits inside it. */
const ANOMALY_WINDOW_MS = 30 * 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

export function capLevel(level: Level, max: Level): Level {
  return ORDER.indexOf(level) <= ORDER.indexOf(max) ? level : max;
}

export function levelAllowsWithoutHuman(level: Level): boolean {
  return level === "L2" || level === "L3";
}

/** The ladder per (agent, class, bucket). F11 builds promotion on top; L0 is the default. */
export class AutonomyStore {
  constructor(private readonly db: Db) {}

  levelFor(agent: string, cls: string, bucket: string): Level {
    const row = this.db
      .prepare(`SELECT level FROM autonomy WHERE agent = ? AND class = ? AND bucket = ?`)
      .get(agent, cls, bucket) as { level: Level } | undefined;
    return row?.level ?? "L0";
  }

  setLevel(agent: string, cls: string, bucket: string, level: Level, atMs: number): void {
    this.db
      .prepare(
        `INSERT INTO autonomy (agent, class, bucket, level, since) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (agent, class, bucket) DO UPDATE SET level = excluded.level, since = excluded.since`,
      )
      .run(agent, cls, bucket, level, atMs);
  }

  /** When this rung began. Evidence from before a promotion or a demotion doesn't count again. */
  since(agent: string, cls: string, bucket: string): number | null {
    const row = this.db
      .prepare(`SELECT since FROM autonomy WHERE agent = ? AND class = ? AND bucket = ?`)
      .get(agent, cls, bucket) as { since: number } | undefined;
    return row?.since ?? null;
  }

  /** F11's normal range: the 95th percentile of amounts that went through this bucket. Null with too little to go on. */
  ceiling(agent: string, cls: string, bucket: string, nowMs: number): number | null {
    const rows = this.db
      .prepare(
        `SELECT amount FROM bucket_events
         WHERE agent = ? AND class = ? AND bucket = ? AND at >= ? AND amount IS NOT NULL AND outcome IN ('approved', 'auto')`,
      )
      .all(agent, cls, bucket, nowMs - ANOMALY_WINDOW_MS) as { amount: number }[];
    return percentile95(rows.map((row) => row.amount));
  }

  /** What has run by itself in this bucket in the last day: the sum of amounts, or a count of calls that have none. */
  spentToday(agent: string, cls: string, bucket: string, nowMs: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(amount, 1)), 0) AS spent FROM bucket_events
         WHERE agent = ? AND class = ? AND bucket = ? AND at > ? AND synthetic = 0 AND outcome = 'auto'`,
      )
      .get(agent, cls, bucket, nowMs - DAY_MS) as { spent: number };
    return row.spent;
  }

  all(): { agent: string; class: string; bucket: string; level: Level; since: number }[] {
    return this.db.prepare(`SELECT agent, class, bucket, level, since FROM autonomy`).all() as {
      agent: string;
      class: string;
      bucket: string;
      level: Level;
      since: number;
    }[];
  }
}

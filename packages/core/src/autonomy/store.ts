import type { Db } from "../db/index.js";

export type Level = "L0" | "L1" | "L2" | "L3";
const ORDER: Level[] = ["L0", "L1", "L2", "L3"];

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

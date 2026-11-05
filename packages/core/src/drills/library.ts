/** The flaw library (F9) and the rate. No randomness: a request and a policy always roll the same way. */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { sha256Hex } from "../hash.js";

const FlawSchema = z
  .object({
    id: z.string().min(1),
    class: z.string().min(1),
    flag: z.string().min(1),
    /** "the payout destination was added 3 minutes before the request": said after "The flaw:". */
    explain: z.string().min(1),
    /** "the new destination": said after "the flaw was". */
    caught: z.string().min(1),
    agent: z.string().min(1),
    endpoint: z.string().min(1),
    args: z.record(z.unknown()).default({}),
    /** What the agent is shown saying, for flaws that are about its words. */
    said: z.string().optional(),
    asked_by: z.string().optional(),
    /** The synthetic systems of record this flaw reads, by lookup kind then id. */
    world: z.record(z.record(z.record(z.unknown()))).default({}),
    extra_flags: z.array(z.object({ code: z.string(), text: z.string() }).strict()).default([]),
  })
  .strict();
export type Flaw = z.infer<typeof FlawSchema>;

const LibrarySchema = z.object({ flaws: z.array(FlawSchema).min(1) }).strict();

export function loadFlaws(path: string): Flaw[] {
  const parsed = LibrarySchema.safeParse(parse(readFileSync(path, "utf8")));
  if (parsed.success) return parsed.data.flaws;
  const issue = parsed.error.issues[0];
  throw new Error(`${path}: ${issue?.path.join(".")}: ${issue?.message}`);
}

/** A fraction of requests, decided by a hash, so it needs no randomness and replays the same. */
/** CLEARANCE_DRILL_RATE, from 0 to 1. Unset or blank means the policy's rate. A value it can't read stops the start. */
export function drillRateFromEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error(`CLEARANCE_DRILL_RATE must be a number from 0 to 1, not "${value}"`);
  return rate;
}

export function rollsDrill(requestId: string, policyHash: string, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const roll = Number.parseInt(sha256Hex(`${requestId}:${policyHash}`).slice(0, 8), 16) / 2 ** 32;
  return roll < rate;
}

export type DrillRow = {
  id: string;
  request_id: string;
  flaw_id: string;
  user_id: string;
  result: "caught" | "missed" | "expired" | "not_sent" | null;
  latency_ms: number | null;
  at: number;
};

/** Results go to the person and, as totals only, to the team. */
export class DrillStore {
  constructor(private readonly db: Db) {}

  add(input: { id: string; requestId: string; flawId: string; userId: string; atMs: number }): void {
    this.db
      .prepare(`INSERT INTO drills (id, request_id, flaw_id, user_id, at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.id, input.requestId, input.flawId, input.userId, input.atMs);
  }

  byRequest(requestId: string): DrillRow | null {
    const row = this.db.prepare(`SELECT * FROM drills WHERE request_id = ?`).get(requestId) as DrillRow | undefined;
    return row ?? null;
  }

  setResult(requestId: string, result: NonNullable<DrillRow["result"]>, latencyMs: number | null): void {
    this.db.prepare(`UPDATE drills SET result = ?, latency_ms = ? WHERE request_id = ?`).run(result, latencyMs, requestId);
  }

  /** Oldest first, leaving out drills that never reached anyone. */
  forPerson(userId: string): DrillRow[] {
    return this.db
      .prepare(`SELECT * FROM drills WHERE user_id = ? AND (result IS NULL OR result != 'not_sent') ORDER BY at, id`)
      .all(userId) as DrillRow[];
  }

  sentSince(userId: string, sinceMs: number): number {
    return this.forPerson(userId).filter((row) => row.at > sinceMs).length;
  }

  summary(userId: string): { sent: number; caught: number; missed: number; expired: number; catch_rate: number | null } {
    const rows = this.forPerson(userId);
    const count = (result: DrillRow["result"]) => rows.filter((row) => row.result === result).length;
    const caught = count("caught");
    const missed = count("missed");
    return {
      sent: rows.length,
      caught,
      missed,
      expired: count("expired"),
      catch_rate: caught + missed > 0 ? caught / (caught + missed) : null,
    };
  }
}

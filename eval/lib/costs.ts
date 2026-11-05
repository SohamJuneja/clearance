/**
 * Agent-run spend, tracked in eval/costs.json. An experiment asks before it spends and records what it
 * spent. Past CLEARANCE_EVAL_SPEND_CAP_USD it's refused, and a cap nobody set or nobody can read counts
 * as no permission to spend, the same fail-closed answer the product gives.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { REPO_ROOT, setting } from "./paths.ts";

export const COSTS_PATH = join(REPO_ROOT, "eval/costs.json");
export const CAP_SETTING = "CLEARANCE_EVAL_SPEND_CAP_USD";

const EntrySchema = z.object({
  at: z.string(),
  experiment: z.string().min(1),
  usd: z.number().nonnegative(),
  note: z.string().optional(),
});
export type CostEntry = z.infer<typeof EntrySchema>;

const CostsSchema = z.object({ entries: z.array(EntrySchema) });

/** The human needs to see this message: it's what goes in HUMAN.md when the cap is reached. */
export class SpendCapError extends Error {
  override readonly name = "SpendCapError";
}

export interface CostOptions {
  path?: string;
  /** The cap in dollars. Default: from the environment or `.env`. */
  capUsd?: number;
}

export function readCosts(path: string = COSTS_PATH): CostEntry[] {
  if (!existsSync(path)) return [];
  const parsed = CostsSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new SpendCapError(`${path} can't be read as a cost log, so spend can't be checked`);
  }
  return parsed.data.entries;
}

export function totalSpend(entries: CostEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.usd, 0);
}

function readCap(options: CostOptions): number {
  if (options.capUsd !== undefined) return options.capUsd;
  const raw = setting(CAP_SETTING);
  const cap = Number(raw);
  if (raw === undefined || !Number.isFinite(cap) || cap < 0) {
    throw new SpendCapError(
      `${CAP_SETTING} is ${raw === undefined ? "not set" : "not a number"}, so no spend is allowed`,
    );
  }
  return cap;
}

/** Refuses if spending `nextUsd` more would pass the cap. Call it before a paid run. */
export function ensureWithinCap(nextUsd = 0, options: CostOptions = {}): void {
  const cap = readCap(options);
  const spent = totalSpend(readCosts(options.path));
  if (spent + nextUsd > cap) {
    throw new SpendCapError(
      `spend cap reached: $${spent.toFixed(2)} spent and $${nextUsd.toFixed(2)} more asked for, cap $${cap.toFixed(2)}. ` +
        `Stop and ask in HUMAN.md before passing it.`,
    );
  }
}

/**
 * Records what a run spent. It's written even when it passes the cap, because that money is gone and a
 * log that left it out would let the next run through. Then it refuses, so the caller stops.
 */
export function recordCost(
  entry: { experiment: string; usd: number; note?: string },
  options: CostOptions = {},
): void {
  const path = options.path ?? COSTS_PATH;
  const entries = readCosts(path);
  entries.push(EntrySchema.parse({ at: new Date().toISOString(), ...entry }));
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial`;
  writeFileSync(partial, `${JSON.stringify({ entries }, null, 2)}\n`);
  renameSync(partial, path);
  ensureWithinCap(0, options);
}

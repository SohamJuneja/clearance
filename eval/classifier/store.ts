/** Reads core's `actions` table, read-only, with Node's own SQLite, and keeps E2's calls for E3. */
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ActionRow } from "./metrics.ts";

export function readActions(dbPath: string): ActionRow[] {
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const columns = db.prepare("PRAGMA table_info(actions)").all() as unknown as { name: string }[];
    const wouldDecide = columns.some((column) => column.name === "would_decide")
      ? "would_decide"
      : "NULL AS would_decide";
    return db
      .prepare(
        `SELECT id, at, source, vendor, agent, kind, class, decision, request_id, raw, ${wouldDecide} FROM actions ORDER BY at, id`,
      )
      .all() as unknown as ActionRow[];
  } finally {
    db.close();
  }
}

/** Core's columns. A call's id is a ULID, so ids from different runs can't collide. */
const CALL_COLUMNS = [
  "id",
  "at",
  "source",
  "vendor",
  "agent",
  "kind",
  "class",
  "tier",
  "score",
  "call_hash",
  "decision",
  "step",
  "request_id",
  "raw",
  "would_decide",
  "action_json",
];

export interface RunName {
  vendor: string;
  condition: string;
  intent: string;
  repeat: number;
}

const nameOf = (run: RunName): string =>
  `${run.vendor} ${run.condition} ${run.intent} #${run.repeat}`;

/**
 * Copies a run's calls out of core's database, which the next reset deletes, into E3's corpus. Returns how many were
 * new. Calls already kept stay as they were.
 */
export function keepCalls(fromDb: string, intoDb: string, run: RunName): number {
  if (!existsSync(fromDb)) return 0;
  const from = new DatabaseSync(fromDb, { readOnly: true });
  let rows: Record<string, string | number | null>[];
  try {
    rows = from
      .prepare(`SELECT ${CALL_COLUMNS.join(", ")} FROM actions`)
      .all() as unknown as typeof rows;
  } finally {
    from.close();
  }
  if (rows.length === 0) return 0;
  mkdirSync(dirname(intoDb), { recursive: true });
  const into = new DatabaseSync(intoDb);
  try {
    into.exec(
      `CREATE TABLE IF NOT EXISTS actions (${CALL_COLUMNS.map((name) =>
        name === "id" ? "id TEXT PRIMARY KEY" : name,
      ).join(", ")}, e2_run TEXT NOT NULL)`,
    );
    const insert = into.prepare(
      `INSERT OR IGNORE INTO actions (${CALL_COLUMNS.join(", ")}, e2_run)
       VALUES (${CALL_COLUMNS.map(() => "?").join(", ")}, ?)`,
    );
    let added = 0;
    into.exec("BEGIN IMMEDIATE");
    for (const row of rows) {
      const values = CALL_COLUMNS.map((name) => row[name] ?? null);
      added += Number(insert.run(...values, nameOf(run)).changes);
    }
    into.exec("COMMIT");
    return added;
  } finally {
    into.close();
  }
}

export type CallKeeper = ((run: RunName) => void) & { summary: () => string };

/**
 * `keepCalls` for a live E2. A failure here costs E3 one run's calls, which isn't worth stopping E2 for, but nobody
 * should find that out afterwards, so it warns at once and again at the end.
 */
export function callKeeper(options: {
  from: string;
  into: string;
  print: (line: string) => void;
}): CallKeeper {
  let kept = 0;
  let failed = 0;
  const keep = (run: RunName): void => {
    try {
      kept += keepCalls(options.from, options.into, run);
    } catch (error) {
      failed += 1;
      options.print(
        `WARNING: couldn't keep ${nameOf(run)}'s calls for E3: ${(error as Error).message}`,
      );
    }
  };
  return Object.assign(keep, {
    summary: () => {
      const total = `${kept} call${kept === 1 ? "" : "s"} kept for E3 in ${options.into}`;
      if (failed === 0) return total;
      return `WARNING: ${failed} run${failed === 1 ? "'s" : "s'"} calls were not kept. ${total}`;
    },
  });
}

export const RETIRED_PREFIX = "earlier: ";

/**
 * When a condition is run again, its old calls stop speaking for those runs, so shadow mode's prediction reads only the
 * new ones. They stay in the corpus with their ids, because people's labels point at them.
 */
export function retireCalls(intoDb: string, vendor: string, conditions: readonly string[]): number {
  if (!existsSync(intoDb)) return 0;
  const db = new DatabaseSync(intoDb);
  try {
    let changed = 0;
    const update = db.prepare("UPDATE actions SET e2_run = ? || e2_run WHERE e2_run LIKE ?");
    for (const condition of conditions) {
      changed += Number(update.run(RETIRED_PREFIX, `${vendor} ${condition} %`).changes);
    }
    return changed;
  } finally {
    db.close();
  }
}

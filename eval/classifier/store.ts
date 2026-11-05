/** Reads core's `actions` table, read-only, with Node's own SQLite. */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ActionRow } from "./metrics.ts";

export function readActions(dbPath: string): ActionRow[] {
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT id, at, source, vendor, agent, kind, class, decision, request_id, raw FROM actions ORDER BY at, id",
      )
      .all() as unknown as ActionRow[];
  } finally {
    db.close();
  }
}

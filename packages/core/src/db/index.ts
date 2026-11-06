import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/** Columns added after the first release of a table. A database from before them gets them on open. */
const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  ["routes", "confirm_field", "TEXT"],
  ["people", "friction", "TEXT"],
  ["drills", "at", "INTEGER NOT NULL DEFAULT 0"],
  ["answers", "fast", "INTEGER NOT NULL DEFAULT 0"],
  ["answers", "signals", "TEXT"],
  ["answers", "t_min_ms", "INTEGER"],
  ["actions", "would_decide", "TEXT"],
  ["actions", "action_json", "TEXT"],
  ["policy_versions", "text", "TEXT"],
  ["activity", "last_message_id", "TEXT"],
];

function addMissingColumns(db: Database.Database): void {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((existing) => existing.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

/** Open (creating if needed) the Clearance database in WAL mode and apply the schema. */
export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  addMissingColumns(db);
  return db;
}

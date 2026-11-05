import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { buildSeed, type Seed } from "./seed";

export type AcmeDb = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, city TEXT NOT NULL, default_destination TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL, items TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_customer ON orders(customer_id);
CREATE TABLE IF NOT EXISTS destinations (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, added_at TEXT NOT NULL, seeded INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS destinations_customer ON destinations(customer_id);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, order_id TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS services (name TEXT PRIMARY KEY, owner TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS service_envs (
  service TEXT NOT NULL, env TEXT NOT NULL, live_version TEXT, previous_version TEXT, PRIMARY KEY (service, env)
);
CREATE TABLE IF NOT EXISTS ci (version TEXT PRIMARY KEY, failing TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pulls (
  number INTEGER PRIMARY KEY, repo TEXT NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL, changes INTEGER NOT NULL,
  files TEXT NOT NULL, checks TEXT NOT NULL, diff TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, rows INTEGER NOT NULL, content TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS email_templates (id TEXT PRIMARY KEY, subject TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS refunds (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, order_id TEXT NOT NULL, customer_id TEXT NOT NULL,
  amount INTEGER NOT NULL, destination TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deploys (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, service TEXT NOT NULL, env TEXT NOT NULL,
  version TEXT NOT NULL, previous_version TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rollbacks (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, service TEXT NOT NULL, env TEXT NOT NULL,
  from_version TEXT, to_version TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL,
  body TEXT NOT NULL, attachments TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deleted_records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, record_id TEXT NOT NULL, row TEXT NOT NULL, deleted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS merges (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, number INTEGER UNIQUE NOT NULL, repo TEXT NOT NULL, sha TEXT NOT NULL, merged_at TEXT NOT NULL
);
`;

const ALL_TABLES = [
  "meta", "customers", "orders", "destinations", "tickets", "services", "service_envs", "ci", "pulls", "files",
  "email_templates", "refunds", "deploys", "rollbacks", "outbox", "deleted_records", "merges",
];

/** Tables whose AUTOINCREMENT counters must restart so ids repeat between demo takes. */
const SEQUENCED_TABLES = ["refunds", "deploys", "rollbacks", "outbox", "deleted_records", "merges"];

function insertSeed(db: AcmeDb, seed: Seed): void {
  const many = <T>(sql: string, rows: T[], bind: (row: T) => unknown[]) => {
    const statement = db.prepare(sql);
    for (const row of rows) statement.run(...bind(row));
  };
  db.prepare("INSERT INTO meta (key, value) VALUES ('seeded_at', ?)").run(seed.seededAt);
  many("INSERT INTO customers VALUES (?,?,?,?,?)", seed.customers, (c) => [c.id, c.name, c.email, c.city, c.default_destination]);
  many("INSERT INTO orders VALUES (?,?,?,?,?)", seed.orders, (o) => [o.id, o.customer_id, o.total, o.status, JSON.stringify(o.items)]);
  many("INSERT INTO destinations VALUES (?,?,?,1)", seed.destinations, (d) => [d.id, d.customer_id, d.added_at]);
  many("INSERT INTO tickets VALUES (?,?,?,?,?)", seed.tickets, (t) => [t.id, t.customer_id, t.order_id, t.subject, t.body]);
  many("INSERT INTO services VALUES (?,?)", seed.services, (s) => [s.name, s.owner]);
  many("INSERT INTO service_envs VALUES (?,?,?,?)", seed.serviceEnvs, (e) => [e.service, e.env, e.live_version, e.previous_version]);
  many("INSERT INTO ci VALUES (?,?)", seed.ci, (c) => [c.version, JSON.stringify(c.failing)]);
  many("INSERT INTO pulls VALUES (?,?,?,?,?,?,?,?)", seed.pulls, (p) => [
    p.number, p.repo, p.title, p.author, p.changes, JSON.stringify(p.files), JSON.stringify(p.checks), p.diff,
  ]);
  many("INSERT INTO files VALUES (?,?,?)", seed.files, (f) => [f.name, f.rows, f.content]);
  many("INSERT INTO email_templates VALUES (?,?,?)", seed.templates, (t) => [t.id, t.subject, t.body]);
}

/** Wipes every table and writes a fresh seed dated `nowMs`, atomically. */
export function resetDb(db: AcmeDb, nowMs: number): void {
  const seed = buildSeed(nowMs);
  db.transaction(() => {
    for (const table of ALL_TABLES) db.prepare(`DELETE FROM ${table}`).run();
    const sequences = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get();
    if (sequences) {
      const clear = db.prepare("DELETE FROM sqlite_sequence WHERE name = ?");
      for (const table of SEQUENCED_TABLES) clear.run(table);
    }
    insertSeed(db, seed);
  })();
}

/** Opens the database, creating the schema, and seeds it the first time only. */
export function openDb(dbPath: string, nowMs: number): AcmeDb {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'seeded_at'").get()) resetDb(db, nowMs);
  return db;
}

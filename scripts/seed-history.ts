/**
 * `pnpm seed:history`: writes the synthetic 7-day history E6 and SC11 start from into Clearance's database.
 * Fixed seed, so the same rows relative to now on every run. Every row is labelled synthetic, the API counts them
 * apart from real ones, and the promotion card says "synthetic history". The ledger is not touched.
 * Safe to re-run: it replaces earlier synthetic rows and leaves real ones alone.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HISTORY_SEED, seedSyntheticHistory } from "../packages/core/src/autonomy/history.ts";
import { openDatabase } from "../packages/core/src/db/index.ts";

export function seedHistory(dbPath: string, nowMs: number, seed = HISTORY_SEED): { events: number; refunds: number; seed: number } {
  const db = openDatabase(dbPath);
  try {
    return seedSyntheticHistory(db, seed, nowMs);
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataDir = resolve(process.env.CLEARANCE_DATA_DIR ?? "data");
  const dbPath = resolve(process.env.CLEARANCE_DB_PATH ?? resolve(dataDir, "clearance.sqlite"));
  const result = seedHistory(dbPath, Date.now());
  console.log(`seed-history: wrote ${result.events} SYNTHETIC events (${result.refunds} refunds, seed ${result.seed}) to ${dbPath}`);
}

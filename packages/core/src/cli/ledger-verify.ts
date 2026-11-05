/**
 * `pnpm ledger:verify [db path]`. Exit 0 when the chain holds, 1 naming the first bad row, 2 when the
 * database cannot be opened. Opens read-only, so it can run beside a live core.
 */
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { verifyLedger } from "../ledger/ledger.js";

export function runLedgerVerify(dbPath: string): { code: number; output: string } {
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    return { code: 2, output: `cannot open ${dbPath}: ${(error as Error).message}` };
  }
  try {
    const result = verifyLedger(db);
    if (result.ok) return { code: 0, output: `ledger ok: ${result.count} entries, head ${result.head}` };
    return {
      code: 1,
      output: `ledger BROKEN at seq ${result.firstBad?.seq}: ${result.firstBad?.reason} (${result.count} good entries before it)`,
    };
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dbPath = process.argv[2] ?? process.env.CLEARANCE_DB_PATH ?? "./data/clearance.sqlite";
  const { code, output } = runLedgerVerify(dbPath);
  console.log(output);
  process.exit(code);
}

/**
 * `pnpm demo:reset`: put the demo world back to its starting state between takes (PLAN 8.7).
 * Prints the elapsed time and exits non-zero if anything failed or it took longer than 10 s.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEMO_RESET_BUDGET_MS = 10_000;

/** Long enough for any healthy service, short enough that one stuck call cannot eat the budget. */
const REQUEST_TIMEOUT_MS = 4_000;

export type ClearanceResetContext = { clearanceDbPath: string };
export type ClearanceResetResult = { done: boolean; note: string };

/**
 * ─────────────────────────────── LEAD: FILL THIS IN ───────────────────────────────
 * Resets Clearance's own state. Left unfilled on purpose because core's API and main.ts are not
 * merged yet. When they are, this should:
 *   1. Clear core's database at `ctx.clearanceDbPath`. Core holds it open, so either ask a running
 *      core to reset through an API, or stop it first, then remove the file with -wal and -shm.
 *   2. Do any Switch cleanup: open approval cards, room documents, the ledger mirror.
 *   3. Restore the demo clock (CLEARANCE_TIME_SCALE) if a take changed it.
 * Throw on failure, and return { done: true, note } only when all of it really happened.
 * Until then this reports done: false, and the script warns on every run.
 * ──────────────────────────────────────────────────────────────────────────────────
 */
export async function resetClearanceState(_ctx: ClearanceResetContext): Promise<ClearanceResetResult> {
  return { done: false, note: "hook not filled in yet" };
}

export type DemoResetOptions = {
  acmeUrl: string;
  adminKey: string;
  clearanceDbPath?: string;
  clearance?: (ctx: ClearanceResetContext) => Promise<ClearanceResetResult>;
  log?: (line: string) => void;
  now?: () => number;
  fetchImpl?: typeof fetch;
};

export type DemoResetResult = { ok: boolean; elapsedMs: number; clearance: ClearanceResetResult };

async function resetAcme(acmeUrl: string, adminKey: string, fetchImpl: typeof fetch): Promise<void> {
  const call = async (method: string, path: string): Promise<Response> => {
    let res: Response;
    try {
      res = await fetchImpl(`${acmeUrl}${path}`, {
        method,
        headers: { "x-acme-admin-key": adminKey },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`cannot reach Acme at ${acmeUrl}: ${(error as Error).message}`);
    }
    if (!res.ok) throw new Error(`Acme answered ${method} ${path} with HTTP ${res.status}`);
    return res;
  };

  await call("POST", "/admin/reset");

  // Trust the state, not the status code: a take recorded on a dirty world is wasted.
  const state = (await (await call("GET", "/state")).json()) as Record<string, unknown>;
  const leftovers = ["refunds", "deploys", "rollbacks", "outbox", "deleted_records", "merges", "destinations_added"].filter(
    (key) => !Array.isArray(state[key]) || (state[key] as unknown[]).length > 0,
  );
  if (state.money_out !== 0 || leftovers.length > 0) {
    throw new Error(`Acme did not reset: money_out=${String(state.money_out)}, not empty: ${leftovers.join(", ") || "none"}`);
  }
}

export async function runDemoReset(options: DemoResetOptions): Promise<DemoResetResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => performance.now());
  const clearanceDbPath = options.clearanceDbPath ?? "./data/clearance.sqlite";

  if (!options.adminKey) throw new Error("ACME_ADMIN_KEY is not set: add it to .env (see .env.example)");

  const started = now();
  await resetAcme(options.acmeUrl, options.adminKey, options.fetchImpl ?? fetch);
  log(`demo-reset: Acme reseeded (${options.acmeUrl})`);

  const clearance = await (options.clearance ?? resetClearanceState)({ clearanceDbPath });
  if (clearance.done) {
    log(`demo-reset: Clearance state reset (${clearance.note})`);
  } else {
    log(`demo-reset: WARNING Clearance state was NOT reset, ${clearanceDbPath} is untouched (${clearance.note})`);
  }

  const elapsedMs = now() - started;
  const withinBudget = elapsedMs <= DEMO_RESET_BUDGET_MS;
  log(`demo-reset: done in ${(elapsedMs / 1000).toFixed(2)} s`);
  if (!withinBudget) log(`demo-reset: FAILED, over the ${DEMO_RESET_BUDGET_MS / 1000} s budget`);
  return { ok: withinBudget, elapsedMs, clearance };
}

async function main(): Promise<void> {
  const envFile = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const result = await runDemoReset({
    acmeUrl: process.env.ACME_URL ?? "http://127.0.0.1:7800",
    adminKey: process.env.ACME_ADMIN_KEY ?? "",
    clearanceDbPath: process.env.CLEARANCE_DB_PATH ?? "./data/clearance.sqlite",
  });
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`demo-reset: FAILED: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}

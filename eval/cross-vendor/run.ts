/**
 * `pnpm eval:vendors`, E2: the same 20 prompts through every agent vendor (PLAN 10.3).
 *
 *   pnpm eval:vendors --dry-run                  what would run, what's blocked, what it would cost. No agent starts.
 *   pnpm eval:vendors --go                       the real runs. Also needs CLEARANCE_EVAL_E2_GO=1.
 *     --claude-model haiku                       the model Claude's agents are set to; recorded in the output
 *     --parallel 3                               agent sessions at once, at most 4
 *     --usd-per-run 0.05                         the estimate checked against the cap before each run
 *
 * Spend goes in eval/costs.json and the run refuses to pass CLEARANCE_EVAL_SPEND_CAP_USD. A vendor with no
 * login, or no agent, is `blocked` in the output, never zero. Writes eval/out/vendors.json after every run,
 * so an interrupted night keeps what it has.
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readCosts, totalSpend } from "../lib/costs.ts";
import { REPO_ROOT, setting } from "../lib/paths.ts";
import { defaultUrls } from "../lib/world.ts";
import { buildAvailability, createLiveDriver, readCanary, vendorProblems } from "./driver.ts";
import { executePlan } from "./execute.ts";
import {
  type AvailabilityMap,
  buildPlan,
  checkParallel,
  CONDITIONS,
  loadIntents,
  type RunResult,
  summarise,
  VENDORS,
} from "./plan.ts";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const print = (line: string): void => void process.stdout.write(`${line}\n`);
const RISKY_RUNS_PER_VENDOR = 20;

export const DEFAULT_CLAUDE_MODEL = "haiku";
/** An estimate, and labelled one everywhere it's written: Switch doesn't report what a run cost. */
export const DEFAULT_USD_PER_RUN = 0.05;

export interface VendorArgs {
  dryRun: boolean;
  go: boolean;
  claudeModel: string;
  parallel: number;
  usdPerRun: number;
}

export function parseVendorArgs(argv: string[]): VendorArgs {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    dryRun: argv.includes("--dry-run"),
    go: argv.includes("--go"),
    claudeModel: value("--claude-model") ?? DEFAULT_CLAUDE_MODEL,
    parallel: checkParallel(Number(value("--parallel") ?? 1)),
    usdPerRun: Number(value("--usd-per-run") ?? DEFAULT_USD_PER_RUN),
  };
}

export function renderOutput(
  results: RunResult[],
  availability: AvailabilityMap,
  args: VendorArgs,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    experiment: "E2",
    ...summarise(results, availability, RISKY_RUNS_PER_VENDOR),
    runs: results.length,
    claude_model: args.claudeModel,
    usd_per_run_estimate: args.usdPerRun,
    availability,
    measured_at: new Date().toISOString(),
    ...extra,
    per_run: results,
  };
}

async function coreHealth(coreUrl: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${coreUrl}/v1/health`, {
      headers: { authorization: `Bearer ${setting("CLEARANCE_INTERNAL_TOKEN") ?? ""}` },
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function printAvailability(
  availability: AvailabilityMap,
  plan: ReturnType<typeof buildPlan>,
): void {
  for (const vendor of VENDORS) {
    for (const condition of CONDITIONS) {
      const count = plan.filter(
        (run) => run.vendor === vendor && run.condition === condition,
      ).length;
      if (count === 0) continue;
      const state = availability[vendor][condition];
      const said = state.status === "ready" ? "ready" : `BLOCKED: ${state.reason}`;
      print(
        `  ${vendor.padEnd(9)} ${condition.padEnd(9)} ${String(count).padStart(4)} runs  ${said}`,
      );
    }
  }
}

async function main(): Promise<number> {
  const args = parseVendorArgs(process.argv.slice(2).filter((arg) => arg !== "--"));
  const intents = loadIntents(join(here, "intents.yaml"));
  const plan = buildPlan(intents);
  const urls = defaultUrls();
  // A dry run leaves the shared stack alone: it doesn't so much as ask core how it is.
  const health = args.go ? await coreHealth(urls.core) : undefined;
  const availability = buildAvailability(await vendorProblems(), health);

  print(
    `E2 plan: ${plan.length} runs, ${intents.length} intents, Claude model ${args.claudeModel}`,
  );
  printAvailability(availability, plan);
  const runnable = plan.filter((run) => availability[run.vendor][run.condition].status === "ready");
  const projected = runnable.length * args.usdPerRun;
  const spent = totalSpend(readCosts());
  const cap = setting("CLEARANCE_EVAL_SPEND_CAP_USD") ?? "unset";
  if (health === undefined)
    print("  The stack wasn't checked, so C may also be blocked if core is down.");
  print(
    `  ${runnable.length} can run now. At an estimated $${args.usdPerRun} a run: $${projected.toFixed(2)}. Spent so far $${spent.toFixed(2)}, cap $${cap}.`,
  );

  if (args.dryRun || !args.go) {
    print(
      args.dryRun
        ? "Dry run: no agent started, nothing written."
        : "Nothing started. Pass --dry-run to look, or --go to run.",
    );
    return 0;
  }
  if (process.env.CLEARANCE_EVAL_E2_GO !== "1") {
    print("--go starts real agents. Set CLEARANCE_EVAL_E2_GO=1 once logins are in and SC3 passes.");
    return 1;
  }

  const driver = createLiveDriver({
    acmeUrl: urls.acme,
    coreUrl: urls.core,
    mattermostUrl: urls.mattermost,
    adminKey: setting("ACME_ADMIN_KEY") ?? "",
    internalToken: setting("CLEARANCE_INTERNAL_TOKEN") ?? "",
    canary: readCanary(),
    remoteRepo: (agent) =>
      setting(`CLEARANCE_E2_REMOTE_${agent.toUpperCase().replace(/-/g, "_")}`) ?? "",
    reset: async () => {
      await execFileAsync(process.execPath, ["--import", "tsx", "scripts/demo-reset.ts"], {
        cwd: REPO_ROOT,
        timeout: 60_000,
      });
    },
  });

  const directory = join(REPO_ROOT, "eval/out");
  mkdirSync(directory, { recursive: true });
  const outFile = join(directory, "vendors.json");
  const results: RunResult[] = [];
  const save = (extra: Record<string, unknown> = {}): void =>
    writeFileSync(
      outFile,
      `${JSON.stringify(renderOutput(results, availability, args, extra), null, 2)}\n`,
    );
  const outcome = await executePlan(plan, {
    driver,
    availability,
    usdPerRun: args.usdPerRun,
    parallel: args.parallel,
    print,
    onResult: (result) => {
      results.push(result);
      save();
    },
  });
  save(outcome.stoppedByCap ? { stopped_by_cap: outcome.stoppedByCap } : {});
  if (outcome.stoppedByCap) {
    print(`STOPPED: ${outcome.stoppedByCap}`);
    return 1;
  }
  print(`wrote ${outFile}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (status) => process.exit(status),
    (error: unknown) => {
      process.stderr.write(`eval:vendors failed: ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}

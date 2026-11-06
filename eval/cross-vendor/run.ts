/**
 * `pnpm eval:vendors`, E2: the same 20 prompts through every agent vendor (PLAN 10.3).
 *
 *   pnpm eval:vendors --dry-run                  what would run, what's blocked, what it would cost. No agent starts.
 *   pnpm eval:vendors --probe                    two prompts per agent, to see the setup works. Isn't E2, and isn't in its results.
 *   pnpm eval:vendors --go                       the real runs. Also needs CLEARANCE_EVAL_E2_GO=1.
 *     --vendor opencode                          one vendor's runs: replaces that vendor's in the file and keeps the others'
 *     --claude-model haiku                       the model Claude's agents are set to; recorded in the output
 *     --usd-per-run 0.05                         the estimate checked against the cap before each run
 *
 * scripts/setup-e2.ts sets up what the runs need. Runs go one at a time: each resets the one shared world, and scores on
 * what changed in it. They take the shared stack for as long as they last, so nothing else can record or run on it.
 *
 * Spend goes in eval/costs.json and the run refuses to pass CLEARANCE_EVAL_SPEND_CAP_USD. A vendor with no
 * login, or no agent, is `blocked` in the output, never zero. Writes eval/out/vendors.json after every run,
 * so an interrupted night keeps what it has.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCosts, totalSpend } from "../lib/costs.ts";
import { REPO_ROOT, setting } from "../lib/paths.ts";
import { defaultUrls } from "../lib/world.ts";
import { defaultWorkspacesDir } from "../../scripts/gateway-owner.ts";
import { agentRefusal } from "../../scripts/model-refusal.ts";
import {
  AGENTS,
  buildAvailability,
  coreHealth,
  createLiveDriver,
  readCanary,
  remoteKey,
  setupProblem,
  vendorProblems,
} from "./driver.ts";
import { executePlan } from "./execute.ts";
import { prepareRun, restoreWorld } from "./live-reset.ts";
import {
  type AvailabilityMap,
  buildPlan,
  type PlannedRun,
  checkParallel,
  CONDITIONS,
  loadIntents,
  type RunResult,
  type VendorName,
  summarise,
  VENDORS,
} from "./plan.ts";

const here = dirname(fileURLToPath(import.meta.url));
const print = (line: string): void => void process.stdout.write(`${line}\n`);
const RISKY_RUNS_PER_VENDOR = 20;

export const DEFAULT_CLAUDE_MODEL = "haiku";
/** An estimate, and labelled one everywhere it's written: Switch doesn't report what a run cost. */
export const DEFAULT_USD_PER_RUN = 0.05;

export interface VendorArgs {
  dryRun: boolean;
  go: boolean;
  probe: boolean;
  claudeModel: string;
  parallel: number;
  usdPerRun: number;
  /** One vendor's runs only. Its results replace that vendor's in the file, and the others' stay. */
  vendor?: VendorName;
}

export function parseVendorArgs(argv: string[]): VendorArgs {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const vendor = value("--vendor");
  if (vendor !== undefined && !(VENDORS as readonly string[]).includes(vendor)) {
    throw new Error(`--vendor takes one of ${VENDORS.join(", ")}`);
  }
  return {
    ...(vendor ? { vendor: vendor as VendorName } : {}),
    dryRun: argv.includes("--dry-run"),
    go: argv.includes("--go"),
    probe: argv.includes("--probe"),
    claudeModel: value("--claude-model") ?? DEFAULT_CLAUDE_MODEL,
    parallel: checkParallel(Number(value("--parallel") ?? 1)),
    usdPerRun: Number(value("--usd-per-run") ?? DEFAULT_USD_PER_RUN),
  };
}

function openCodeModel(): string | undefined {
  const chosen = join(REPO_ROOT, "data/opencode-model.json");
  if (setting("CLEARANCE_OPENCODE_MODEL")) return setting("CLEARANCE_OPENCODE_MODEL");
  return existsSync(chosen) ? (JSON.parse(readFileSync(chosen, "utf8")) as { model?: string }).model : undefined;
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
    // OpenCode's free models differ in what they'll do by themselves, so a count means little without knowing which ran.
    ...(openCodeModel() ? { opencode_model: openCodeModel() } : {}),
    usd_per_run_estimate: args.usdPerRun,
    availability,
    measured_at: new Date().toISOString(),
    ...extra,
    per_run: results,
  };
}

/** Results from an earlier run for the vendors this one isn't running. A vendor's runs are only ever replaced whole. */
export function keptResults(previous: unknown, vendor: VendorName | undefined): RunResult[] {
  if (!vendor) return [];
  const runs = (previous as { per_run?: RunResult[] } | null)?.per_run;
  return Array.isArray(runs) ? runs.filter((run) => run.vendor !== vendor) : [];
}

/** A vendor left out of this run, with nothing kept for it, reads as not run. It must never read as a clean zero. */
export function availabilityForRun(
  availability: AvailabilityMap,
  vendor: VendorName | undefined,
  kept: RunResult[],
): AvailabilityMap {
  if (!vendor) return availability;
  const out = structuredClone(availability);
  for (const other of VENDORS) {
    if (other === vendor) continue;
    for (const condition of CONDITIONS) {
      const hasRuns = kept.some((run) => run.vendor === other && run.condition === condition);
      if (!hasRuns && out[other][condition].status === "ready") {
        out[other][condition] = { status: "blocked", reason: `not run yet: this run was --vendor ${vendor}` };
      }
    }
  }
  return out;
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

/** The two prompts that lean on the setup, once for each agent that can run. */
const PROBED = new Set(["read-env", "force-push"]);

export function probePlan(plan: PlannedRun[]): PlannedRun[] {
  return plan.filter((run) => run.repeat === 1 && PROBED.has(run.intent.id));
}

async function main(): Promise<number> {
  const args = parseVendorArgs(process.argv.slice(2).filter((arg) => arg !== "--"));
  const intents = loadIntents(join(here, "intents.yaml"));
  const plan = buildPlan(intents).filter((run) => !args.vendor || run.vendor === args.vendor);
  const urls = defaultUrls();
  // A dry run leaves the shared stack alone: it doesn't so much as ask core how it is.
  const live = args.go || args.probe;
  const health = live
    ? await coreHealth(urls.core, setting("CLEARANCE_INTERNAL_TOKEN") ?? "")
    : undefined;
  const canary = readCanary();
  const remoteOf = (agent: string): string => setting(remoteKey(agent)) ?? "";
  const availability = buildAvailability(await vendorProblems(), health, (agent) =>
    setupProblem(agent, {
      workspaces: defaultWorkspacesDir(),
      canary,
      remote: remoteOf(agent),
    }),
  );

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

  if (args.dryRun || !live) {
    print(
      args.dryRun
        ? "Dry run: no agent started, nothing written."
        : "Nothing started. Pass --dry-run to look, or --go to run.",
    );
    return 0;
  }
  if (args.go && process.env.CLEARANCE_EVAL_E2_GO !== "1") {
    print("--go starts real agents. Set CLEARANCE_EVAL_E2_GO=1 once logins are in and SC3 passes.");
    return 1;
  }
  if (args.parallel !== 1) {
    print(
      "Runs can't overlap: each one resets the one shared world, and scores on what changed in it. Drop --parallel.",
    );
    return 1;
  }

  const driver = createLiveDriver({
    acmeUrl: urls.acme,
    coreUrl: urls.core,
    mattermostUrl: urls.mattermost,
    adminKey: setting("ACME_ADMIN_KEY") ?? "",
    internalToken: setting("CLEARANCE_INTERNAL_TOKEN") ?? "",
    canary,
    remoteRepo: remoteOf,
    modelRefusal: (agent, sinceMs) => agentRefusal(agent, { sinceMs })?.reason ?? null,
    reset: (planned, agent, room) => prepareRun(planned, agent, room, canary, remoteOf(agent)),
  });

  const directory = join(REPO_ROOT, "eval/out");
  mkdirSync(directory, { recursive: true });
  // A probe has its own file, so it can never be read as E2.
  const outFile = join(directory, args.probe && !args.go ? "vendors-probe.json" : "vendors.json");
  const kept = keptResults(existsSync(outFile) ? (JSON.parse(readFileSync(outFile, "utf8")) as unknown) : null, args.vendor);
  const results: RunResult[] = [...kept];
  const reported = availabilityForRun(availability, args.vendor, kept);
  const save = (extra: Record<string, unknown> = {}): void =>
    writeFileSync(
      outFile,
      `${JSON.stringify(renderOutput(results, reported, args, extra), null, 2)}\n`,
    );
  const agents = [
    ...new Set(
      runnable.flatMap((run) => {
        const agent = AGENTS[run.vendor][run.condition];
        return agent ? [agent] : [];
      }),
    ),
  ];
  const outcome = await executePlan(args.go ? plan : probePlan(plan), {
    driver,
    availability,
    usdPerRun: args.usdPerRun,
    parallel: args.parallel,
    print,
    experiment: args.go ? "E2" : "E2-probe",
    onResult: (result) => {
      results.push(result);
      save();
    },
  }).finally(() => restoreWorld(agents, remoteOf));
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

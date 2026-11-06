/**
 * `pnpm demo:run SC3` plays one scene from PLAN 8.7 through Mattermost and says what passed.
 *
 *   pnpm demo:run SC3            one scenario
 *   pnpm demo:run SC3 SC4        several, in order
 *   pnpm demo:run all            every scenario
 *   pnpm demo:run --list         what exists, with prompts
 *   pnpm demo:run SC3 --record   also capture each persona's browser to docs/media/raw/
 *   --no-reset                   skip scripts/demo-reset.ts
 *   --agent-timeout <seconds>    how long to wait for an agent (default 180)
 *
 * Exit status: 0 all passed, 1 something failed or was blocked, 2 the command itself was wrong.
 */
import { exec, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { REPO_ROOT, setting } from "../eval/lib/paths.ts";
import { SERVICE_LABEL, type ServiceName } from "../eval/lib/world.ts";
import {
  type Recorder,
  runScenario,
  type RunOptions,
  type ScenarioResult,
  type ServiceControl,
} from "./demo/runner.ts";
import { serviceCommand } from "./demo/services.ts";
import { findScenario, SCENARIOS } from "./scenarios/index.ts";

const execShell = promisify(exec);

interface Args {
  ids: string[];
  list: boolean;
  record: boolean;
  reset: boolean;
  agentTimeoutMs?: number;
}

function usage(message: string): never {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    "usage: pnpm demo:run <SC1..SC14|all> [--record] [--no-reset] [--agent-timeout <s>] | --list\n",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ids: [], list: false, record: false, reset: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") continue;
    else if (arg === "--list") args.list = true;
    else if (arg === "--record") args.record = true;
    else if (arg === "--no-reset") args.reset = false;
    else if (arg === "--agent-timeout") {
      const seconds = Number(argv[++i]);
      if (!Number.isFinite(seconds) || seconds <= 0)
        usage("--agent-timeout takes a number of seconds");
      args.agentTimeoutMs = seconds * 1000;
    } else if (arg.startsWith("--")) usage(`unknown option ${arg}`);
    else args.ids.push(arg);
  }
  return args;
}

function list(): void {
  for (const scenario of SCENARIOS) {
    const star = scenario.inVideo ? "*" : " ";
    process.stdout.write(`${star} ${scenario.id.padEnd(5)} ${scenario.title}\n`);
    if (scenario.prompt) {
      process.stdout.write(
        `        ${scenario.prompt.by} in #${scenario.prompt.room}: "${scenario.prompt.text}"\n`,
      );
    }
  }
  process.stdout.write("\n* is in the video (PLAN 12).\n");
}

/** Runs scripts/demo-reset.ts, which a teammate owns. Its absence is a reason to stop, not to guess. */
function resetWorld(): Promise<void> {
  const script = join(REPO_ROOT, "scripts/demo-reset.ts");
  if (!existsSync(script)) {
    return Promise.reject(
      new Error("scripts/demo-reset.ts isn't here yet. Pass --no-reset to run without it"),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", script], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-500);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`demo-reset exited ${code}: ${stderr.trim()}`)),
    );
  });
}

/** scripts/services.sh, unless the environment says otherwise. */
const servicesFromEnvironment: ServiceControl = {
  stop: (service) => runServiceCommand(service, "STOP"),
  start: (service) => runServiceCommand(service, "START"),
};

async function runServiceCommand(service: ServiceName, verb: "STOP" | "START"): Promise<void> {
  const command = serviceCommand(service, verb, setting);
  if (!command)
    throw new Error(
      `set CLEARANCE_${service.toUpperCase()}_${verb}_CMD to say how to ${verb.toLowerCase()} ${SERVICE_LABEL[service]}`,
    );
  await execShell(command, { cwd: REPO_ROOT, timeout: 60_000 });
}

function saveRun(result: ScenarioResult): void {
  const directory = join(REPO_ROOT, "eval/out/demo");
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(
    join(directory, `${result.id}-${stamp}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    list();
    return 0;
  }
  if (args.ids.length === 0) usage("say which scenario to run");

  const chosen = args.ids.flatMap((id) => {
    if (id.toLowerCase() === "all") return SCENARIOS;
    const scenario = findScenario(id);
    if (!scenario)
      usage(`no scenario ${id}. Known: ${SCENARIOS.map((known) => known.id).join(", ")}`);
    return [scenario];
  });

  let recorder: Recorder | undefined;
  if (args.record) {
    // Loaded only here, so a plain run doesn't need a browser anywhere near it.
    const { createRecorder } = await import("./video/capture.ts");
    recorder = createRecorder();
  }

  const options: RunOptions = {
    recorder,
    reset: args.reset ? resetWorld : undefined,
    services: servicesFromEnvironment,
    agentTimeoutMs: args.agentTimeoutMs,
    timeScale: Number(setting("CLEARANCE_TIME_SCALE") ?? 1),
  };

  const results: ScenarioResult[] = [];
  for (const scenario of chosen) {
    const result = await runScenario(scenario, options);
    results.push(result);
    saveRun(result);
  }

  process.stdout.write("\nsummary\n");
  for (const result of results) {
    const reason = result.blockedBecause ? `  ${result.blockedBecause}` : "";
    process.stdout.write(`  ${result.verdict.toUpperCase().padEnd(8)}${result.id}${reason}\n`);
  }
  return results.every((result) => result.verdict === "pass") ? 0 : 1;
}

main().then(
  (status) => process.exit(status),
  (error: unknown) => {
    process.stderr.write(`demo-run failed: ${(error as Error).message}\n`);
    process.exit(1);
  },
);

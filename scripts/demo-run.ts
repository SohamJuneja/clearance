/**
 * `pnpm demo:run SC3` plays one scene from PLAN 8.7 through Mattermost and says what passed.
 *
 *   pnpm demo:run SC3            one scenario
 *   pnpm demo:run SC3 SC4        several, in order
 *   pnpm demo:run all            every numbered scenario
 *   pnpm demo:run SC2T           ticket T-77 on the baseline, which isn't a numbered row of PLAN 8.7
 *   pnpm demo:run --list         what exists, with prompts
 *   pnpm demo:run SC3 --record   also capture each persona's browser to docs/media/raw/
 *   --no-reset                   skip scripts/demo-reset.ts
 *   --no-fresh                   keep the room and the agent's memory of it. By default each take starts in a new
 *                                room with new sessions, and the old channel stays, archived, as <room>-take-<when>
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
  type WorldSetup,
} from "./demo/runner.ts";
import { freshRoom, setBaseline } from "./demo/fresh-room.ts";
import { greetClearance, personaTokens } from "./demo/greet.ts";
import { archiveStrayRooms } from "./demo/stray-rooms.ts";
import { serviceCommand } from "./demo/services.ts";
import { EXTRA_SCENARIOS, findScenario, SCENARIOS } from "./scenarios/index.ts";
import { OWNERS } from "./setup-agents.ts";

const execShell = promisify(exec);

interface Args {
  ids: string[];
  list: boolean;
  record: boolean;
  reset: boolean;
  fresh: boolean;
  agentTimeoutMs?: number;
}

function usage(message: string): never {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    "usage: pnpm demo:run <SC1..SC14|SC2T|all> [--record] [--no-reset] [--no-fresh] [--agent-timeout <s>] | --list\n",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ids: [], list: false, record: false, reset: true, fresh: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") continue;
    else if (arg === "--list") args.list = true;
    else if (arg === "--record") args.record = true;
    else if (arg === "--no-reset") args.reset = false;
    else if (arg === "--no-fresh") args.fresh = false;
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
  for (const scenario of [...SCENARIOS, ...EXTRA_SCENARIOS]) {
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

function runToEnd(
  what: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-500);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${what} exited ${code}: ${stderr.trim()}`)),
    );
  });
}

/**
 * Runs scripts/demo-reset.ts, which a teammate owns, then whatever the scene needs after it. Its absence is a reason
 * to stop, not to guess. The services restart inside the reset, and a value already in their environment wins over
 * `.env`, so that's how a scene's environment reaches them.
 */
async function resetWorld(setup: WorldSetup): Promise<void> {
  const script = join(REPO_ROOT, "scripts/demo-reset.ts");
  if (!existsSync(script)) {
    throw new Error("scripts/demo-reset.ts isn't here yet. Pass --no-reset to run without it");
  }
  const env = { ...process.env, ...setup.env };
  await runToEnd("demo-reset", "pnpm", ["exec", "tsx", script], env);
  for (const name of setup.afterReset) await runToEnd(name, "pnpm", [name], env);
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

/** How the baseline scenes differ. SC14 is staged, and says so: Sam answers because anyone may. */
const BASELINE: Record<string, { autoMode: boolean; anyoneMayAnswer: boolean }> = {
  SC1: { autoMode: true, anyoneMayAnswer: false },
  SC2: { autoMode: false, anyoneMayAnswer: false },
  SC2T: { autoMode: false, anyoneMayAnswer: false },
  SC14: { autoMode: false, anyoneMayAnswer: true },
};

/**
 * What every take starts from: a new room and new sessions, then the world reset, then each person's hello to
 * Clearance. In that order, because the reset restarts core, and core has to be there to hear the room and the hellos.
 */
async function startTake(id: string, room: string | undefined, setup: WorldSetup, args: Args): Promise<void> {
  const log = (line: string) => process.stdout.write(`    ${line}\n`);
  const baseline = BASELINE[id];
  if (baseline) await setBaseline(baseline.autoMode, baseline.anyoneMayAnswer, log);
  if (args.fresh && room) await freshRoom(room, log);
  // Or the agent's next hold needs two approvers: see scripts/demo/stray-rooms.ts.
  await archiveStrayRooms(Object.keys(OWNERS), log);
  if (args.reset) await resetWorld(setup);
  await greetClearance({
    mattermostUrl: setting("MATTERMOST_URL") ?? "http://127.0.0.1:8065",
    tokens: personaTokens(REPO_ROOT),
    log,
  });
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
    services: servicesFromEnvironment,
    agentTimeoutMs: args.agentTimeoutMs,
    timeScale: Number(setting("CLEARANCE_TIME_SCALE") ?? 1),
  };

  const results: ScenarioResult[] = [];
  for (const scenario of chosen) {
    const result = await runScenario(scenario, {
      ...options,
      reset: (setup) => startTake(scenario.id, scenario.room, setup, args),
    });
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

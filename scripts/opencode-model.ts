/**
 * Which model OpenCode's agents run. The free models change and run out, so no name in a template can be promised.
 *
 *   CLEARANCE_OPENCODE_MODEL   a model to use, as provider/model. Nothing is tried.
 *   unset                      try the free models, use the first that answers and calls a tool, and remember it.
 *
 *   pnpm exec tsx scripts/opencode-model.ts check   says what it knows and changes nothing. Exit 1 if `pick` has work
 *   pnpm exec tsx scripts/opencode-model.ts pick    does that work. Finding no model isn't a failure: it says so
 *
 * The probe runs in a fence of its own (scripts/fence-probe.sh), since a third-party model drives tools there, with its
 * own home, so it can't touch a running agent's state. It proves a tool call with a random token in a file: the only way
 * to reply with it is to read the file. A model that can answer but not call tools is no use to an agent.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, rootEnv } from "./gateway-owner.ts";
import { agentRefusal, limitIn, OPENCODE_AGENTS, refusalLine, type Refusal, TOOLS } from "./model-refusal.ts";

export const MODEL_SETTING = "CLEARANCE_OPENCODE_MODEL";
export const KEY_SETTING = "OPENCODE_PROVIDER_KEY";
const PROBE_MACHINE = "clearance-opencode-probe";
const LIST_MS = 60_000;
const MODELS_PER_TRY_MS = 40_000;
/** Models that answer do so in seconds, and a judge is waiting. */
const WHOLE_PROBE_MS = 180_000;
const AUTH_FILE = ".local/share/opencode/auth.json";

const memoryPath = (root: string = ROOT): string => join(root, "data/opencode-model.json");

export interface Attempt {
  model: string;
  result: string;
}
export interface Choice {
  /** Null when none of them answered. */
  model: string | null;
  at: string;
  tried: Attempt[];
}

function setting(name: string): string {
  const fromProcess = process.env[name]?.trim();
  if (fromProcess) return fromProcess;
  try {
    return rootEnv()[name]?.trim() ?? "";
  } catch {
    return "";
  }
}

export function remembered(root: string = ROOT): Choice | null {
  try {
    return JSON.parse(readFileSync(memoryPath(root), "utf8")) as Choice;
  } catch {
    return null;
  }
}

/** The model OpenCode's agents should run, or null when nothing has been chosen and the template's name stands. */
export function chosenOpenCodeModel(root: string = ROOT, read: (name: string) => string = setting): string | null {
  return read(MODEL_SETTING) || remembered(root)?.model || null;
}

/**
 * What `opencode models <provider> --verbose` lists that's free and can call tools. A model's name on its own line, then
 * its details as JSON. Free means it costs nothing by OpenCode's own numbers, not that its name says so: big-pickle's
 * doesn't.
 */
export function freeModels(verbose: string): string[] {
  const text = verbose.replace(/\x1b\[[0-9;]*m/g, "");
  const parts = text.split(/^(\S+\/\S+)[ \t]*$/m);
  const models: string[] = [];
  for (let at = 1; at < parts.length; at += 2) {
    try {
      const details = JSON.parse(parts[at + 1]!) as {
        status?: string;
        cost?: { input?: number; output?: number };
        capabilities?: { toolcall?: boolean };
      };
      const free = details.cost?.input === 0 && details.cost?.output === 0;
      if (free && details.capabilities?.toolcall && details.status !== "deprecated") models.push(parts[at]!);
    } catch {
      // Not a model's details, so not something to try.
    }
  }
  return models;
}

/** Proof of a real tool call: the token came back from a completed tool, and the model then said it in its reply. */
export function provedToolCall(stdout: string, token: string): boolean {
  let read = false;
  let said = false;
  for (const line of stdout.split("\n")) {
    if (!line.includes(token)) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        part?: { text?: string; state?: { status?: string; output?: string } };
      };
      if (event.type === "tool_use" && event.part?.state?.status === "completed") read = true;
      if (event.type === "text" && event.part?.text?.includes(token)) said = true;
    } catch {
      // Not one of OpenCode's events, so it proves nothing.
    }
  }
  return read && said;
}

export interface Run {
  stdout: string;
  /** Why it stopped early, if the log said the model was refusing. */
  refusal: string | null;
  timedOut: boolean;
}

/** Runs a command, and ends it as soon as its log says the model is refusing, since it would only retry until the timeout. */
export function runWatching(
  command: string,
  args: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.env ? { env: options.env } : {}),
    });
    let stdout = "";
    let refusal: string | null = null;
    let timedOut = false;
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const found = limitIn(chunk.toString());
      if (found && !refusal) {
        refusal = found;
        stop();
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ stdout, refusal, timedOut });
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout, refusal, timedOut });
    });
  });
}

export interface ProbeIo {
  list(): Promise<string>;
  /** Tries a model, in a folder holding a file with this token in it. */
  attempt(model: string, token: string): Promise<Run>;
  print(line: string): void;
  now?(): number;
}

/** The first free model that answers and calls a tool, or none, with what each one did. */
export async function pickFreeModel(io: ProbeIo, wholeProbeMs: number = WHOLE_PROBE_MS): Promise<Choice> {
  const now = io.now ?? Date.now;
  const started = now();
  const models = freeModels(await io.list());
  const tried: Attempt[] = [];
  if (models.length === 0) {
    io.print("  OpenCode listed no free models it can use. That can be the network, and a rerun asks again");
    return { model: null, at: new Date(now()).toISOString(), tried };
  }
  io.print(`  trying OpenCode's free models, ${models.length} listed, each with a small prompt and a tool to call`);
  for (const model of models) {
    if (now() - started > wholeProbeMs) {
      tried.push({ model, result: "not tried, out of time" });
      continue;
    }
    const token = `probe-${randomBytes(12).toString("hex")}`;
    const run = await io.attempt(model, token);
    const result = provedToolCall(run.stdout, token)
      ? "answered and called a tool"
      : run.refusal
        ? `refusing: ${run.refusal}`
        : run.timedOut
          ? "no answer in time"
          : "no proof of a tool call";
    tried.push({ model, result });
    io.print(`    ${model}: ${result}`);
    if (result === "answered and called a tool") return { model, at: new Date(now()).toISOString(), tried };
  }
  return { model: null, at: new Date(now()).toISOString(), tried };
}

const LOST =
  "OpenCode's agents can't run until one does, so the OpenCode scene is what's lost. Claude's agents and the rest of the demo still work.";

const when = (iso: string): string => iso.slice(11, 16);

function modelRefusing(model: string | null, sinceMs: number): { agent: string; refusal: Refusal } | null {
  for (const agent of Object.keys(OPENCODE_AGENTS)) {
    const refusal = agentRefusal(agent, { sinceMs, ...(model ? { model } : {}) });
    if (refusal) return { agent, refusal };
  }
  return null;
}

export interface CheckState {
  model: string;
  keySet: boolean;
  noFence: boolean;
  remembered: Choice | null;
  /** The machines with no key where one is set, or holding one that was taken out of .env. */
  authProblems: string[];
  refusing: { agent: string; refusal: Refusal } | null;
}

/** What `check` says, and whether `pick` has anything to do. Says the same things `pick` would, and changes nothing. */
export function checkLines(state: CheckState): { lines: string[]; done: boolean } {
  const lines: string[] = [];
  let done = true;
  const refusingLine = state.refusing ? refusalLine(state.refusing.agent, state.refusing.refusal) : null;
  for (const problem of state.authProblems) {
    lines.push(`  todo  ${problem}`);
    done = false;
  }
  if (state.model) {
    const provider = state.model.split("/")[0]!;
    if (!state.model.includes("/")) {
      lines.push(`  warn  ${MODEL_SETTING} is "${state.model}", and OpenCode needs provider/model, like anthropic/claude-haiku-5-5`);
    } else if (state.keySet) {
      lines.push(`  ok    OpenCode's agents use ${state.model}, from ${MODEL_SETTING}, with ${KEY_SETTING}`);
      if (state.noFence) lines.push(`  warn  with --no-fence OpenCode uses this host's own login, not ${KEY_SETTING}: opencode auth login`);
    } else if (provider !== "opencode") {
      lines.push(`  warn  OpenCode's agents use ${state.model}, and ${KEY_SETTING} is blank, so they can't sign in to ${provider}`);
    } else {
      lines.push(`  ok    OpenCode's agents use ${state.model}, from ${MODEL_SETTING}`);
    }
    if (refusingLine) lines.push(`  warn  ${refusingLine}. Change ${MODEL_SETTING}, then run just demo`);
    return { lines, done };
  }
  if (state.keySet) {
    lines.push(`  warn  ${KEY_SETTING} is set and ${MODEL_SETTING} isn't, so nothing uses the key. Set a model like anthropic/claude-haiku-5-5`);
  }
  const memory = state.remembered;
  if (!memory) {
    lines.push("  todo  no OpenCode model chosen yet: just demo tries the free ones");
    return { lines, done: false };
  }
  if (!memory.model) {
    lines.push(`  warn  no free OpenCode model answered at ${when(memory.at)}. ${LOST}`);
    lines.push("        just demo tries them again");
    return { lines, done: false };
  }
  if (refusingLine) {
    lines.push(`  warn  ${refusingLine}. just demo tries the others`);
    return { lines, done: false };
  }
  lines.push(`  ok    OpenCode's agents use ${memory.model}, which answered and called a tool at ${when(memory.at)}`);
  return { lines, done };
}

export function authFile(machine: string): string {
  return join(TOOLS, "homes", machine, AUTH_FILE);
}

/** Whether each machine's auth file is as it should be. Looks at which provider it names, and never prints a key. */
function authProblems(model: string, keySet: boolean, noFence: boolean): string[] {
  if (noFence) return [];
  const problems: string[] = [];
  for (const machine of Object.values(OPENCODE_AGENTS)) {
    const file = authFile(machine);
    if (!keySet) {
      if (existsSync(file)) problems.push(`${machine} still has a key that's gone from .env, and just demo removes it`);
      continue;
    }
    if (!model.includes("/")) continue;
    let good = false;
    try {
      const provider = model.split("/")[0]!;
      const held = JSON.parse(readFileSync(file, "utf8")) as Record<string, { key?: string }>;
      good = Boolean(held[provider]?.key) && (statSync(file).mode & 0o777) === 0o600;
    } catch {
      good = false;
    }
    if (!good) problems.push(`${machine} doesn't have ${KEY_SETTING} yet, and just demo gives it`);
  }
  return problems;
}

function checkState(sinceMs: number): CheckState {
  const model = setting(MODEL_SETTING);
  const keySet = Boolean(setting(KEY_SETTING));
  const noFence = process.env.CLEARANCE_NO_FENCE === "1";
  const memory = remembered();
  return {
    model,
    keySet,
    noFence,
    remembered: memory,
    authProblems: authProblems(model, keySet, noFence),
    refusing: modelRefusing(model || memory?.model || null, sinceMs),
  };
}

/** What the fence's script needs, and none of what .env put in this process's environment. */
function probeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["HOME", "PATH", "USER", "LANG", "VOLTA_HOME", "CLEARANCE_TOOLS", "CLEARANCE_NO_FENCE", "CLEARANCE_BWRAP", "SWITCH_BRIDGE_URL"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return { ...env, CLEARANCE_ROOT: ROOT };
}

function realProbe(print: (line: string) => void): ProbeIo & { cleanUp(): void } {
  const script = join(ROOT, "scripts/fence-probe.sh");
  const home = join(TOOLS, "homes", PROBE_MACHINE);
  const prompt =
    "Use your read tool to read the file probe.txt in the current directory, then reply with exactly what it contains and nothing else.";
  return {
    print,
    list: async () =>
      (
        await runWatching("bash", [script, "opencode", "models", "opencode", "--refresh", "--verbose"], {
          timeoutMs: LIST_MS,
          env: probeEnv(),
        })
      ).stdout,
    attempt: (model, token) => {
      mkdirSync(join(home, "work"), { recursive: true });
      writeFileSync(join(home, "work/probe.txt"), `${token}\n`);
      return runWatching(
        "bash",
        [script, "opencode", "run", "-m", model, "--format", "json", "--print-logs", "--log-level", "ERROR", prompt],
        { timeoutMs: MODELS_PER_TRY_MS, env: probeEnv() },
      );
    },
    // Nothing of it is wanted again, and the next try starts from a clean home.
    cleanUp: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(join(TOOLS, `controller-data-${PROBE_MACHINE.replace("clearance-", "")}`), { recursive: true, force: true });
    },
  };
}

/** Looks back this far for a refusal: a limit from yesterday says nothing about now. */
const REFUSAL_WINDOW_MS = 15 * 60_000;

async function pick(): Promise<void> {
  const state = checkState(Date.now() - REFUSAL_WINDOW_MS);
  const usable = state.model || (state.remembered?.model && !state.refusing);
  if (usable) {
    for (const line of checkLines({ ...state, authProblems: [] }).lines) console.log(line);
    return;
  }
  if (state.keySet) console.log(`  warn  ${KEY_SETTING} is set and ${MODEL_SETTING} isn't, so nothing uses the key. Set a model like anthropic/claude-haiku-5-5`);
  if (state.refusing) console.log(`  warn  ${refusalLine(state.refusing.agent, state.refusing.refusal)}`);
  const probe = realProbe(console.log);
  let choice: Choice;
  try {
    choice = await pickFreeModel(probe);
  } finally {
    probe.cleanUp();
  }
  mkdirSync(dirname(memoryPath()), { recursive: true });
  writeFileSync(memoryPath(), `${JSON.stringify(choice, null, 2)}\n`);
  if (choice.model) {
    console.log(`  ok    OpenCode's agents will use ${choice.model}, which answered and called a tool`);
    return;
  }
  console.log(`  warn  no free OpenCode model answered. ${LOST}`);
  console.log(`        To use your own: ${MODEL_SETTING} and ${KEY_SETTING} in .env, then just demo. Or just demo later: free models come back`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const what = process.argv[2];
  if (what === "pick") {
    await pick();
  } else if (what === "check") {
    const { lines, done } = checkLines(checkState(Date.now() - REFUSAL_WINDOW_MS));
    for (const line of lines) console.log(line);
    process.exitCode = done ? 0 : 1;
  } else {
    console.error("usage: opencode-model.ts check | pick");
    process.exitCode = 2;
  }
}

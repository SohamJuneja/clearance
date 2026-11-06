/**
 * When a model refuses, OpenCode retries and the room shows "Working…" and then nothing: no error and no card. All that
 * says why is OpenCode's own log, in the machine's fenced home. This reads it, so the demo can say what happened instead
 * of timing out. Reads only: it never changes anything an agent uses.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TOOLS = process.env.CLEARANCE_TOOLS ?? join(homedir(), ".local/share/clearance-tools");

/** Each machine runs one of these, so a machine's log is that agent's. scripts/fence.sh holds the other half. */
export const OPENCODE_AGENTS: Record<string, string> = {
  "ops-agent": "clearance-alex-open",
  "ops-agent-vanilla": "clearance-priya-open-base",
};

const LOG = ".local/share/opencode/log/opencode.log";
/** Enough for what a demo did lately. The log only grows, and this runs on every check. */
const TAIL_BYTES = 256 * 1024;

const LIMITS: [RegExp, string][] = [
  [/free usage limit/i, "free usage limit"],
  [/credit balance|insufficient[ _](credit|balance|funds|quota)|exceeded your (current )?quota/i, "out of credit"],
  [/usage limit|rate.?limit|too many requests/i, "usage or rate limit"],
];
/** Only from the log, where it's the model's provider talking. An agent saying "unauthorized" may be quoting Acme. */
const KEY_REFUSED: [RegExp, string][] = [
  [/invalid.{0,12}(api.?key|x-api-key)|authentication.?error|unauthorized/i, "its key was refused"],
];

const match = (rules: [RegExp, string][], text: string): string | null =>
  rules.find(([pattern]) => pattern.test(text))?.[1] ?? null;

/** Why, if what an agent said is its model refusing. For the words in a room, which can be about anything else. */
export function limitIn(words: string): string | null {
  return match(LIMITS, words);
}

export interface Refusal {
  reason: string;
  model: string;
  atMs: number;
}

/** The latest refusal in a log's text, at or after `sinceMs`, for `model` if it's given. */
export function lastRefusal(log: string, options: { sinceMs: number; model?: string | null }): Refusal | null {
  let found: Refusal | null = null;
  for (const line of log.split("\n")) {
    if (!line.includes("level=ERROR") || !line.includes('message="stream error"')) continue;
    const reason = match(LIMITS, line) ?? match(KEY_REFUSED, line);
    if (!reason) continue;
    const atMs = Date.parse(/timestamp=(\S+)/.exec(line)?.[1] ?? "");
    if (!Number.isFinite(atMs) || atMs < options.sinceMs) continue;
    const provider = /providerID=(\S+)/.exec(line)?.[1] ?? "";
    const model = `${provider}/${/modelID=(\S+)/.exec(line)?.[1] ?? ""}`;
    if (options.model && options.model !== model) continue;
    if (!found || atMs >= found.atMs) found = { reason, model, atMs };
  }
  return found;
}

function tail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** A machine's own log. With --no-fence there's no fenced home, so sessions log in the real one. */
function logOf(agent: string): string | null {
  const machine = OPENCODE_AGENTS[agent];
  if (!machine) return null;
  for (const path of [join(TOOLS, "homes", machine, LOG), join(homedir(), LOG)]) {
    if (existsSync(path)) return path;
  }
  return null;
}

export function agentRefusal(agent: string, options: { sinceMs: number; model?: string | null }): Refusal | null {
  const path = logOf(agent);
  if (!path) return null;
  try {
    return lastRefusal(tail(path), options);
  } catch {
    // A log we can't read says nothing either way, and this only ever adds a line to a report.
    return null;
  }
}

export function refusalLine(agent: string, refusal: Refusal): string {
  return `${agent}: this agent's model is refusing: ${refusal.reason} (${refusal.model})`;
}

/** One line for each OpenCode agent whose model has refused since then. */
export function modelRefusals(sinceMs: number): string[] {
  return Object.keys(OPENCODE_AGENTS).flatMap((agent) => {
    const refusal = agentRefusal(agent, { sinceMs });
    return refusal ? [refusalLine(agent, refusal)] : [];
  });
}

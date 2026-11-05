/**
 * `clearance-hook codex|cursor`: vendor hook payload on stdin, decision JSON on stdout.
 *
 * Runs on every tool call, so it has no dependencies beyond Node and starts under Node's own type
 * stripping. Both vendors can fail open if a hook stalls, so it never waits long and every failure
 * here is a deny.
 *
 * What was measured against Codex 0.160 (spikes/RESULTS-vendors.md): a JSON deny with exit 0 blocks,
 * and a crash, bad output or a hang all fail open. So `.codex/hooks.json` wraps this command as
 * `timeout 2 ... || { echo reason >&2; exit 2; }`. Every deny here is therefore exit 0, or the
 * wrapper would fire too and pile its own text on the real reason. Exit 2 is left for the wrapper.
 *
 * Cursor (from its docs, not yet run): allow is JSON with exit 0, deny is exit 2, which blocks even
 * if the JSON is not read.
 *
 * Neither vendor passes our env to hook commands under Switch, so the token comes from
 * `.clearance/hook-token`, which setup writes into the agent's directory.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type HookResult = { stdout: string; stderr: string; exitCode: number };
export type HookEnv = Record<string, string | undefined>;
type CodexEvent = "PreToolUse" | "PermissionRequest";
type HookVendor = "codex" | "cursor";

const DEFAULT_CORE_URL = "http://127.0.0.1:7700";
/** Under the 2 s the Codex wrapper allows, so the reason given is ours and not the wrapper's. */
const DEFAULT_TIMEOUT_MS = 1500;

const DENIED = "Clearance denied this call and nothing ran:";
const NO_TOKEN = `${DENIED} no hook token was found.`;
const UNREADABLE = `${DENIED} it could not read the hook payload.`;
const UNAVAILABLE = `${DENIED} the approval service could not answer. Do not try another way.`;
const USAGE: HookResult = {
  stdout: "",
  stderr: "usage: clearance-hook codex|cursor\n",
  exitCode: 2,
};
const NO_OPINION: HookResult = { stdout: "", stderr: "", exitCode: 0 };

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const json = (value: unknown) => `${JSON.stringify(value)}\n`;

const isVendor = (value: string | undefined): value is HookVendor =>
  value === "codex" || value === "cursor";

function parseOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function eventOf(payload: unknown): CodexEvent {
  return asObject(payload)?.hook_event_name === "PermissionRequest"
    ? "PermissionRequest"
    : "PreToolUse";
}

/** Switch's own room tools never go through Clearance, so an outage cannot silence the agent. */
function isSwitchTool(payload: unknown): boolean {
  const tool = asObject(payload)?.tool_name;
  return typeof tool === "string" && tool.startsWith("mcp__switch__");
}

function codexDeny(event: CodexEvent, reason: string): HookResult {
  const hookSpecificOutput =
    event === "PermissionRequest"
      ? {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny", message: reason },
        }
      : {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        };
  return { stdout: json({ hookSpecificOutput }), stderr: "", exitCode: 0 };
}

function cursorDeny(reason: string): HookResult {
  return {
    stdout: json({ permission: "deny", user_message: reason, agent_message: reason }),
    stderr: `${reason}\n`,
    exitCode: 2,
  };
}

function deny(vendor: HookVendor, payload: unknown, reason: string): HookResult {
  return vendor === "codex" ? codexDeny(eventOf(payload), reason) : cursorDeny(reason);
}

function fromCodexAnswer(event: CodexEvent, answer: unknown): HookResult {
  const body = asObject(answer);
  const specific = asObject(body?.hookSpecificOutput);
  if (event === "PermissionRequest") {
    const decision = asObject(specific?.decision);
    if (specific?.hookEventName === "PermissionRequest") {
      if (decision?.behavior === "allow") {
        return { stdout: json(answer), stderr: "", exitCode: 0 };
      }
      if (decision?.behavior === "deny" && typeof decision.message === "string") {
        return codexDeny(event, decision.message);
      }
    }
    return codexDeny(event, UNAVAILABLE);
  }
  if (body && Object.keys(body).length === 0) return NO_OPINION;
  if (
    specific?.hookEventName === "PreToolUse" &&
    specific.permissionDecision === "deny" &&
    typeof specific.permissionDecisionReason === "string"
  ) {
    return codexDeny(event, specific.permissionDecisionReason);
  }
  return codexDeny(event, UNAVAILABLE);
}

function fromCursorAnswer(answer: unknown): HookResult {
  const body = asObject(answer);
  if (body?.permission === "allow") return { stdout: json(answer), stderr: "", exitCode: 0 };
  if (body?.permission === "deny" && typeof body.agent_message === "string") {
    return cursorDeny(body.agent_message);
  }
  return cursorDeny(UNAVAILABLE);
}

/** Reads the first .clearance/hook-token walking up from `start`. */
function tokenFromFile(start: string): string | undefined {
  let current = resolve(start);
  for (;;) {
    try {
      const token = readFileSync(join(current, ".clearance", "hook-token"), "utf8").trim();
      if (token) return token;
    } catch {
      // Not here. Keep walking.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function hookTimeoutMs(env: HookEnv): number {
  const value = Number(env.CLEARANCE_HOOK_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/** Stdin did not close in time. Whatever arrived only decides the format of the deny. */
export function stdinTimedOut(vendorArg: string | undefined, partial: string): HookResult {
  if (!isVendor(vendorArg)) return USAGE;
  return deny(vendorArg, parseOrUndefined(partial), UNREADABLE);
}

/** Never throws. */
export async function runHook(
  vendorArg: string | undefined,
  stdin: string,
  env: HookEnv,
  cwd: string = process.cwd(),
): Promise<HookResult> {
  if (!isVendor(vendorArg)) return USAGE;
  const payload = parseOrUndefined(stdin);
  if (!asObject(payload)) return deny(vendorArg, payload, UNREADABLE);
  if (vendorArg === "codex" && isSwitchTool(payload)) return NO_OPINION;
  const token = env.CLEARANCE_HOOK_TOKEN || tokenFromFile(cwd);
  if (!token) return deny(vendorArg, payload, NO_TOKEN);

  try {
    const base = (env.CLEARANCE_CORE_URL ?? DEFAULT_CORE_URL).replace(/\/+$/, "");
    const res = await fetch(`${base}/v1/hooks/${vendorArg}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: stdin,
      redirect: "error",
      signal: AbortSignal.timeout(hookTimeoutMs(env)),
    });
    if (res.status !== 200) return deny(vendorArg, payload, UNAVAILABLE);
    const answer: unknown = JSON.parse(await res.text());
    return vendorArg === "codex"
      ? fromCodexAnswer(eventOf(payload), answer)
      : fromCursorAnswer(answer);
  } catch {
    return deny(vendorArg, payload, UNAVAILABLE);
  }
}

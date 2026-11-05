/**
 * Shared pieces of the vendor adapters. Adapters are pure: a payload and a context go in, Actions
 * come out, and anything they cannot read is a PayloadError, which the hook route turns into a deny.
 */
import { posix } from "node:path";
import type { Action, Vendor } from "@clearance/contracts";

/** `agent` comes from the working directory, resolved by the caller; never from the payload. */
export type AdapterContext = { agent: string; id: string; at: string };

/** A hold is a deny here: hooks answer at once and the agent retries after approval. */
export type HookOutcome = { decision: "allow" | "deny"; reason: string };

export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadError";
  }
}

export interface VendorAdapter<Output = unknown> {
  vendor: Vendor;
  /** The directory that identifies the agent. Never throws; undefined when the payload has none. */
  cwd(payload: unknown): string | undefined;
  /**
   * The agent's name, when the vendor says so directly. Set means the agent is this name or nobody:
   * the directory is not consulted. Never throws.
   */
  agentType?(payload: unknown): string | undefined;
  /** One Action per thing the call touches. Throws PayloadError when it cannot tell what that is. */
  toActions(payload: unknown, ctx: AdapterContext): Action[];
  /** The vendor's own answer. Never throws: it must be able to deny from an unreadable payload. */
  respond(outcome: HookOutcome, payload: unknown): Output;
  /**
   * Set when a vendor fires two events for one call, so the second can reuse the first's allow
   * instead of asking `check` again and spending a single-use grant twice.
   */
  pairedEvent?(payload: unknown): { event: string; scope: string } | undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Resolves `..` first, so `src/../.claude/x` cannot pass as `src/`, then makes the path relative
 * to the working directory when it is inside it, because policy rules are written relative
 * (`^src/`). A path outside stays absolute.
 */
export function normalizePath(path: string, cwd?: string): string {
  if (!cwd) return posix.normalize(path);
  const root = posix.normalize(cwd).replace(/\/+$/, "");
  const absolute = posix.normalize(path.startsWith("/") ? path : `${root}/${path}`);
  if (absolute === root) return ".";
  return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute;
}

export function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) throw new PayloadError(`missing ${what}`);
  return value;
}

/** A command is normally a string. An argv array is joined so patterns still see all of it. */
export function requireCommand(value: unknown): string {
  if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string")) {
    return value.join(" ");
  }
  return requireString(value, "command");
}

/** `mcp__server__tool`, where the tool part may itself contain `__`. */
export function parseMcpName(name: string): { server: string; tool: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? { server: match[1]!, tool: match[2]! } : undefined;
}

/** Every file an apply_patch touches, in order, including a rename's destination. */
export function patchPaths(patch: unknown): string[] {
  const text = requireString(patch, "patch text");
  const paths = [...text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)]
    .map((match) => match[1]!.trim())
    .filter((path) => path.length > 0);
  if (paths.length === 0) throw new PayloadError("could not read the files in this patch");
  return [...new Set(paths)];
}

/** A search reads whatever its pattern matches, so `**\/.env*` has to reach the `.env` rules. */
export function searchTarget(path: unknown, pattern: unknown): string {
  const dir = typeof path === "string" && path.length > 0 ? path : ".";
  if (typeof pattern !== "string" || pattern.length === 0) return dir;
  return pattern.startsWith("/") ? pattern : posix.join(dir, pattern);
}

export type CallInfo = {
  vendor: Vendor;
  ctx: AdapterContext;
  raw: unknown;
  cwd?: string;
  sessionId?: string;
  claim?: string;
};

function base(info: CallInfo, id: string) {
  return {
    id,
    at: info.ctx.at,
    source: "hook" as const,
    vendor: info.vendor,
    agent: { name: info.ctx.agent, ...(info.cwd ? { cwd: info.cwd } : {}) },
    ...(info.sessionId ? { session: { vendorSessionId: info.sessionId } } : {}),
    raw: info.raw,
    ...(info.claim ? { agentClaim: info.claim } : {}),
  };
}

export function shellAction(info: CallInfo, command: string): Action[] {
  return [{ ...base(info, info.ctx.id), kind: "shell", shell: { command } }];
}

export function fileActions(
  info: CallInfo,
  kind: "file_write" | "file_read",
  paths: string[],
): Action[] {
  return paths.map((path, index) => ({
    ...base(info, index === 0 ? info.ctx.id : `${info.ctx.id}.${index}`),
    kind,
    file: { path: normalizePath(path, info.cwd) },
  }));
}

export function httpAction(info: CallInfo, url: string): Action[] {
  return [{ ...base(info, info.ctx.id), kind: "http", http: { method: "GET", url } }];
}

export function mcpAction(info: CallInfo, server: string, tool: string, args: unknown): Action[] {
  return [{ ...base(info, info.ctx.id), kind: "mcp", mcp: { server, tool, args } }];
}

/** Action kinds have no "other". Tools with no rule stay visible to core under this server name. */
export const BUILTIN_SERVER = "builtin";

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

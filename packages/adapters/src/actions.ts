/**
 * Shared pieces of the vendor adapters. Adapters are pure: a payload and a context go in, Actions
 * come out, and anything they cannot read is a PayloadError, which the hook route turns into a deny.
 */
import { posix } from "node:path";
import { canonicalJson, type Action, type Vendor } from "@clearance/contracts";

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

/** What a write would do to a file. An approval is bound to all of it, so nothing that changes the result is left out. */
export type Written = { content?: string; replaces?: string };

const textOf = (value: unknown): string | undefined =>
  value === undefined || value === null
    ? undefined
    : typeof value === "string"
      ? value
      : canonicalJson(value);

/**
 * For a tool with a field of new text. Everything else in its input goes in `replaces`, so a field a later version adds
 * still counts, except the path, which is the Action's own, and the description, which is only the agent's claim.
 */
export function writtenBy(
  input: Record<string, unknown>,
  fields: { content: string; path: string },
): Written {
  const { [fields.content]: content, [fields.path]: _path, description: _claim, ...rest } = input;
  const text = textOf(content);
  return {
    ...(text !== undefined ? { content: text } : {}),
    ...(Object.keys(rest).length > 0 ? { replaces: canonicalJson(rest) } : {}),
  };
}

/** Several edits to one file. The new text of each is what gets shown; all of it is bound. */
export function writtenByEdits(
  input: Record<string, unknown>,
  newText: string,
): Written {
  const edits = Array.isArray(input.edits) ? input.edits : [];
  const text = edits
    .map((edit) => asRecord(edit)?.[newText])
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return { content: text, replaces: canonicalJson(input.edits ?? null) };
}

/** Each file in a patch: what it adds is what gets shown, and its whole section is bound. */
export function writtenByPatch(patch: unknown): (path: string) => Written {
  const text = requireString(patch, "patch text");
  const sections = new Map<string, Written>();
  const headers = [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: .*$/gm)];
  headers.forEach((header, index) => {
    const start = header.index;
    const end = headers[index + 1]?.index ?? text.length;
    const section = text.slice(start, end).replace(/^\*\*\* End Patch\s*$/m, "");
    const added = section
      .split("\n")
      .filter((line) => line.startsWith("+"))
      .map((line) => line.slice(1));
    const written: Written = {
      ...(added.length > 0 ? { content: added.join("\n") } : {}),
      replaces: section,
    };
    for (const match of section.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) {
      sections.set(match[1]!.trim(), written);
    }
  });
  return (path) => sections.get(path) ?? { content: text };
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

/** `workdir` is the vendor's own argument for where to run it, which changes what the line means. */
export function shellAction(info: CallInfo, command: string, workdir?: string): Action[] {
  return [
    {
      ...base(info, info.ctx.id),
      kind: "shell",
      shell: { command, ...(workdir ? { workdir } : {}) },
    },
  ];
}

export function fileActions(
  info: CallInfo,
  kind: "file_write" | "file_read",
  paths: string[],
  written: (path: string) => Written = () => ({}),
): Action[] {
  return paths.map((path, index) => {
    const what = written(path);
    return {
      ...base(info, index === 0 ? info.ctx.id : `${info.ctx.id}.${index}`),
      kind,
      file: { path: normalizePath(path, info.cwd) },
      ...(Object.keys(what).length > 0 ? { written: what } : {}),
    };
  });
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

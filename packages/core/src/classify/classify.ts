/**
 * Turns an Action into what the policy's matchers read, and answers the matching questions.
 * Pure: no IO, no clock. Shell lines are split into sub-commands by ./shell.ts first, and each of those is a call.
 */
import { posix } from "node:path";
import { canonicalJson, type Action } from "@clearance/contracts";
import { previewOf } from "../format.js";
import { sha256Hex } from "../hash.js";
import type { CompiledClass, CompiledMatch, CompiledPolicy, MatchKind } from "../policy/load.js";
import { fetchStaysOnGate } from "./fetch.js";
import { readsOutside } from "./reads.js";
import { parseShell, type SubCommand } from "./shell.js";

export type NormalCall = {
  kind: MatchKind;
  /** What patterns run against: the effective command, the normalised path, `METHOD url`, the endpoint, the tool. */
  subject: string;
  /** Also tried: a file path as the agent wrote it, or a command with its wrappers still on. */
  rawSubject?: string;
  /** Also tried, for a command running somewhere other than the tree's root: its arguments as paths from the root. */
  resolvedSubject?: string;
  /** A file path from where the call really runs, when that isn't the tree's root. What "outside" is judged on. */
  resolvedPath?: string;
  server?: string;
  target: string;
  args: Record<string, unknown>;
  /** What a grant is also bound to, beyond `args`. Absent when `args` already says it all. */
  bound?: Record<string, unknown>;
  /** True when `args` are the call's own structured arguments (gate, MCP), not just the command text. */
  structured: boolean;
  /** A sub-command's words and what came before them, so a helper can read arguments instead of a line of text. */
  words?: string[];
  wrappers?: string[];
};

function objectArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return value === undefined ? {} : { value };
}

/** `post /acme/refunds/?x=1` and `POST //acme/refunds` are both `POST /acme/refunds`. */
export function normaliseEndpoint(endpoint: string): string {
  const match = /^\s*(\S+)\s+(.*?)\s*$/.exec(endpoint);
  if (!match) return endpoint.trim();
  const [, method = "", rest = ""] = match;
  let path = rest.split(/[?#]/, 1)[0] ?? "";
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/$/, "");
  return `${method.toUpperCase()} ${path}`;
}

/** Collapses `..` and makes paths inside the agent's working directory relative. */
export function normalisePath(path: string, cwd?: string): string {
  const normal = posix.normalize(path);
  if (cwd && normal.startsWith("/")) {
    const root = posix.normalize(cwd).replace(/\/$/, "");
    if (normal === root) return ".";
    if (normal.startsWith(`${root}/`)) return normal.slice(root.length + 1);
  }
  return normal;
}

const serverName = (name: string): string => name.replace(/-/g, "_");

/**
 * The three spellings of one tool become one: `refund_customer` on a server, `mcp__clearance_gate__refund_customer`,
 * and OpenCode's `clearance_gate_refund_customer`. OpenCode names have no separator of their own, so they are only
 * read against the servers the policy knows; everyone else's server name is taken as given.
 */
export function normaliseMcp(
  server: string,
  tool: string,
  vendor: Action["vendor"],
  policy: CompiledPolicy,
): { server: string; tool: string } {
  const full = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (full) return { server: serverName(full[1] as string), tool: full[2] as string };
  const known = policy.defaults.known_mcp_servers.map(serverName).sort((a, b) => b.length - a.length);
  const named = serverName(server);
  if (vendor === "opencode" && !known.includes(named) || named === "builtin") {
    for (const flat of [`${named}_${tool}`, tool]) {
      const owner = known.find((candidate) => candidate !== "builtin" && flat.startsWith(`${candidate}_`));
      if (owner) return { server: owner, tool: flat.slice(owner.length + 1) };
    }
  }
  return { server: named, tool };
}

/** The call an Action describes, or null when the Action is missing the part its kind needs. */
export function normaliseCall(action: Action, policy: CompiledPolicy): NormalCall | null {
  switch (action.kind) {
    case "shell":
      if (!action.shell) return null;
      return {
        kind: "shell",
        subject: action.shell.command,
        target: "shell",
        args: { command: action.shell.command },
        structured: false,
        ...boundTo({ ...cwdBinding(shellDirectory(action)), ...workdirBinding(action) }),
      };
    case "file_write":
    case "file_read": {
      if (!action.file) return null;
      return fileCall(action.kind, action.file.path, action.agent.cwd, action.kind === "file_write" ? whatIsWritten(action.written) : {});
    }
    case "http": {
      if (!action.http) return null;
      const line = `${action.http.method.toUpperCase()} ${action.http.url}`;
      return {
        kind: "http",
        subject: line,
        target: line,
        args: { method: action.http.method.toUpperCase(), url: action.http.url, body: action.http.body },
        structured: false,
      };
    }
    case "mcp": {
      if (!action.mcp) return null;
      const { server, tool } = normaliseMcp(action.mcp.server, action.mcp.tool, action.vendor, policy);
      return {
        kind: "mcp",
        subject: tool,
        server,
        target: `${server}/${tool}`,
        args: objectArgs(action.mcp.args),
        structured: true,
      };
    }
    case "business": {
      if (!action.business) return null;
      const endpoint = normaliseEndpoint(action.business.endpoint);
      return { kind: "gate", subject: endpoint, target: endpoint, args: action.business.args, structured: true };
    }
    default:
      return null;
  }
}

/** Binds an approval to what would be written, so it can't be spent on writing something else to that path. */
function whatIsWritten(written: Action["written"]): Record<string, unknown> {
  const { content, replaces } = written ?? {};
  if (content === undefined && replaces === undefined) return {};
  return {
    content_sha256: sha256Hex(canonicalJson({ content, replaces })),
    ...(content !== undefined ? { preview: previewOf(content), chars: content.length } : {}),
  };
}

const boundTo = (bound: Record<string, unknown>): Pick<NormalCall, "bound"> =>
  Object.keys(bound).length > 0 ? { bound } : {};

const cwdBinding = (cwd: string | undefined): Record<string, unknown> => (cwd ? { cwd } : {});

/**
 * The directory a shell line runs in: the tool's own argument when it has one, on top of the agent's. `~` stays as it is:
 * it's somewhere else, wherever that turns out to be.
 */
export function shellDirectory(action: Action): string | undefined {
  const { workdir } = action.shell ?? {};
  const base = action.agent.cwd;
  if (!workdir) return base ? cleanDirectory(base) : undefined;
  if (workdir.startsWith("~")) return cleanDirectory(workdir);
  return cleanDirectory(base ? posix.resolve(base, workdir) : workdir);
}

const cleanDirectory = (path: string): string => posix.normalize(path).replace(/(.)\/+$/, "$1");

/** The agent's own directory, which everything is judged against. */
export const agentTree = (action: Action): string | undefined => (action.agent.cwd ? cleanDirectory(action.agent.cwd) : undefined);

/** Set when the tool ran it somewhere other than the agent's directory, so the card can say where. */
export function workdirBinding(action: Action): Record<string, unknown> {
  const directory = shellDirectory(action);
  return directory && directory !== agentTree(action) ? { workdir: directory } : {};
}

/**
 * The tool's own directory, read as the `cd` it is. So it gets exactly what a `cd` there gets: the deny classes read its
 * text, and one leaving the agent's directory is held. Nothing when it's where the agent is.
 */
export function workdirAsCd(action: Action): SubCommand[] {
  const directory = shellDirectory(action);
  const tree = agentTree(action);
  if (!directory || directory === tree) return [];
  const inside = tree ? posix.relative(tree, directory) : "";
  const shown = inside && !inside.startsWith("..") && !directory.startsWith("~") ? inside : directory;
  return parseShell(`cd '${shown.replace(/'/g, "'\\''")}'`).commands;
}

/** A path from the directory it's really relative to. One that's absolute, or only known at run time, says for itself. */
function resolvedFrom(path: string, directory: string): string {
  if (/^(\/|~|\$)/.test(path)) return path;
  return directory.startsWith("/") ? posix.resolve(directory, path) : posix.join(directory, path);
}

/** Where a sub-command really runs: where the line runs, then its `cd`s. Undefined when only the shell knows. */
export function commandDirectory(command: SubCommand, place: ShellPlace): string | undefined {
  if (command.directory === null) return undefined;
  if (!place.cwd) return command.directory || undefined;
  return command.directory ? cleanDirectory(resolvedFrom(command.directory, place.cwd)) : place.cwd;
}

/** A command's arguments as paths from the tree's root, so a rule about a path can read them wherever the command runs. */
function resolvedSubjectOf(command: SubCommand, place: ShellPlace): string | undefined {
  const directory = commandDirectory(command, place);
  if (!directory || directory === place.tree) return undefined;
  const from = place.tree ? normalisePath(directory, place.tree) : directory;
  const [name, ...args] = command.words;
  const paths = args.map((word) =>
    word.startsWith("-") || word.includes("://") || command.dynamic.includes(word) ? word : resolvedFrom(word, from),
  );
  return [name, ...paths].join(" ");
}

/** `extra` carries the rest of what the call is bound to. A relative path means nothing without its directory. */
export function fileCall(
  kind: "file_write" | "file_read",
  path: string,
  cwd: string | undefined,
  extra: Record<string, unknown> = {},
  directory?: string,
): NormalCall {
  const moved = directory !== undefined && directory !== (cwd && cleanDirectory(cwd));
  const resolvedPath = moved ? resolvedFrom(path, directory) : undefined;
  return {
    kind,
    subject: normalisePath(resolvedPath ?? path, cwd),
    rawSubject: path,
    ...(resolvedPath ? { resolvedPath } : {}),
    target: path,
    args: { path },
    structured: false,
    ...boundTo({ ...(path.startsWith("/") ? {} : cwdBinding(cwd && cleanDirectory(cwd))), ...extra }),
  };
}

/** Where a sub-command runs: the directory, and the whole line, for a command that depends on more of it than its words. */
export type ShellPlace = { cwd?: string | undefined; line?: string | undefined; tree?: string | undefined; workdir?: Record<string, unknown> };

/** `cd` to where it already is changes nothing, and agents write it out of habit, so it doesn't count against a grant. */
function setupThatMatters(setup: string[][], cwd: string | undefined): string[][] {
  if (!cwd) return setup;
  return setup.filter(([name, target, ...rest]) => !(name === "cd" && target !== undefined && rest.length === 0 && posix.resolve(cwd, target) === cwd));
}

/** One sub-command as a call. A grant binds to its canonical form, plus whatever that form can't say. */
export function subCommandCall(command: SubCommand, place: ShellPlace = {}): NormalCall {
  const setup = setupThatMatters(command.setup, place.cwd);
  const resolvedSubject = resolvedSubjectOf(command, place);
  return {
    kind: "shell",
    subject: command.effective,
    rawSubject: command.canonical,
    ...(resolvedSubject ? { resolvedSubject } : {}),
    target: "shell",
    args: { command: command.canonical },
    structured: false,
    words: command.words,
    wrappers: command.wrappers,
    ...boundTo({
      ...(command.boundWords ? { words: command.boundWords } : {}),
      ...(setup.length > 0 ? { setup } : {}),
      ...cwdBinding(place.cwd),
      ...place.workdir,
      ...(command.boundToLine && place.line !== undefined ? { line: place.line } : {}),
      ...(command.repeats ? { repeats: true } : {}),
    }),
  };
}

function mcpNames(call: NormalCall): string[] {
  const { server, subject: tool } = call;
  return [tool, `${server}/${tool}`, `${server}_${tool}`, `mcp__${server}__${tool}`];
}

function mcpMatches(entry: CompiledMatch, call: NormalCall): boolean {
  if (entry.pattern.startsWith("^")) return mcpNames(call).some((name) => entry.re.test(name));
  return entry.re.test(entry.pattern.includes("/") ? `${call.server}/${call.subject}` : call.subject);
}

export function matches(entry: CompiledMatch, call: NormalCall): boolean {
  if (entry.kind !== call.kind) return false;
  if (call.kind === "mcp") return mcpMatches(entry, call);
  if (entry.re.test(call.subject)) return true;
  if (call.resolvedSubject !== undefined && entry.re.test(call.resolvedSubject)) return true;
  return call.rawSubject !== undefined && entry.re.test(call.rawSubject);
}

/** A safe rule reads the normalised form only: `src/../../etc/passwd` is not under src/. */
export function isSafe(call: NormalCall, policy: CompiledPolicy): boolean {
  return policy.safe.some((entry) => {
    if (entry.kind !== call.kind) return false;
    return call.kind === "mcp" ? mcpMatches(entry, call) : entry.re.test(call.subject);
  });
}

export function denyingClass(call: NormalCall, policy: CompiledPolicy): CompiledClass | null {
  return policy.classes.find((cls) => cls.deny && cls.match.some((entry) => matches(entry, call))) ?? null;
}

export function isKnownMcpServer(call: NormalCall, policy: CompiledPolicy): boolean {
  return policy.defaults.known_mcp_servers.map(serverName).includes(call.server ?? "");
}

export type ClassHit = { cls: CompiledClass; viaGate: boolean };

/** First matching class wins (classes are ordered). `viaGate` means this hook call will reach the gate as is. */
export function firstClass(call: NormalCall, policy: CompiledPolicy): ClassHit | null {
  for (const cls of policy.classes) {
    if (cls.deny) continue;
    const hits = cls.match.filter((entry) => matches(entry, call));
    if (hits.length === 0) continue;
    return { cls, viaGate: hits.some((entry) => entry.viaGate && reachesGate(call, policy)) };
  }
  return null;
}

function reachesGate(call: NormalCall, policy: CompiledPolicy): boolean {
  if (call.kind === "shell") return true; // The entry's pattern is anchored to the CLI itself, by load.ts.
  if (call.kind === "mcp") return policy.defaults.gate_mcp_servers.map(serverName).includes(call.server ?? "");
  return false;
}

/** A read that leaves the agent's own directory, by the words of the path. It outranks the safe list. */
export function leavesAgentDir(call: NormalCall, cwd: string | undefined, policy: CompiledPolicy): boolean {
  return call.kind === "file_read" && readsOutside(call.resolvedPath ?? call.rawSubject ?? call.subject, cwd, policy.defaults.readable_outside ?? []);
}

/** PLAN 7.3 step 6. Every gate write is protected by construction; the rest comes from the policy. */
export function isProtected(call: NormalCall, policy: CompiledPolicy): boolean {
  if (call.kind === "gate") return true;
  // A fetch that only goes to the gate is fine, because the gate holds what it needs to. Regexes can't tell the
  // request's host from text that mentions it, so this one question is answered by reading the arguments.
  if (call.kind === "shell" && fetchStaysOnGate(call.words ?? [], call.wrappers ?? [], policy.defaults.gate_hosts ?? [])) return false;
  return policy.protected.some((entry) => matches(entry, call));
}

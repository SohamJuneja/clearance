/**
 * Loads policy and team YAML. Everything that can be wrong with a file is reported as
 * `file:line:col: path: message`, and a bad policy refuses to start (F1).
 */
import { readFileSync } from "node:fs";
import type { Tier } from "@clearance/contracts";
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Document, type ParsedNode } from "yaml";
import type { ZodError, ZodType, ZodTypeDef } from "zod";
import { F11_CRITERIA, type Criteria } from "../autonomy/promotion.js";
import type { Level } from "../autonomy/store.js";
import { sha256Hex } from "../hash.js";
import { compileExpression, ExpressionError, type CompiledExpression } from "./expr.js";
import {
  PolicyFileSchema,
  TeamFileSchema,
  type ApproverRef,
  type MatchEntry,
  type PolicyFile,
  type TeamFile,
} from "./schema.js";

type Path = (string | number)[];

export class PolicyLoadError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly line: number,
    readonly col: number,
  ) {
    super(message);
    this.name = "PolicyLoadError";
  }
}

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(text: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(text);
  if (!match) throw new Error(`bad duration: ${text}`);
  return Number(match[1]) * (DURATION_UNITS[match[2] as string] as number);
}

// ── Position-aware YAML handling ─────────────────────────────────────────────

class YamlSource {
  readonly doc: Document.Parsed<ParsedNode>;
  private readonly lines = new LineCounter();

  constructor(
    text: string,
    readonly file: string,
  ) {
    this.doc = parseDocument(text, { lineCounter: this.lines, prettyErrors: true });
    const first = this.doc.errors[0];
    if (first) {
      const pos = first.linePos?.[0] ?? { line: 1, col: 1 };
      throw new PolicyLoadError(`${file}:${pos.line}:${pos.col}: ${first.message.split("\n")[0]}`, file, pos.line, pos.col);
    }
  }

  /** The line of a key for a map path, of the item for a sequence path; the deepest that exists. */
  position(path: Path): { line: number; col: number } {
    let node: unknown = this.doc.contents;
    let offset = 0;
    for (const segment of path) {
      if (isMap(node)) {
        const pair = node.items.find((item) => isScalar(item.key) && String(item.key.value) === String(segment));
        if (!pair) break;
        offset = (pair.key as { range?: number[] }).range?.[0] ?? offset;
        node = pair.value;
      } else if (isSeq(node)) {
        const item = node.items[Number(segment)] as { range?: number[] } | undefined;
        if (!item) break;
        offset = item.range?.[0] ?? offset;
        node = item;
      } else {
        break;
      }
    }
    return this.lines.linePos(offset);
  }

  fail(path: Path, message: string): PolicyLoadError {
    const { line, col } = this.position(path);
    return new PolicyLoadError(`${this.file}:${line}:${col}: ${path.join(".")}: ${message}`, this.file, line, col);
  }

  parseWith<T>(schema: ZodType<T, ZodTypeDef, unknown>): T {
    const parsed = schema.safeParse(this.doc.toJS());
    if (parsed.success) return parsed.data;
    throw this.fromZod(parsed.error);
  }

  private fromZod(error: ZodError): PolicyLoadError {
    const issue = error.issues[0];
    if (!issue) return this.fail([], "invalid file");
    if (issue.code === "unrecognized_keys") {
      const key = issue.keys[0] as string;
      return this.fail([...issue.path, key], `unknown key "${key}"`);
    }
    return this.fail(issue.path, issue.message);
  }
}

// ── Compiled policy ──────────────────────────────────────────────────────────

export type MatchKind = "gate" | "mcp" | "shell" | "file_write" | "file_read" | "http";

export type CompiledMatch = { kind: MatchKind; pattern: string; re: RegExp; viaGate: boolean };

export type CompiledRule = { when: CompiledExpression; points: number; flag?: string; why?: string; skipIfUnknown?: boolean };

export type CompiledAggregate = {
  sum: string;
  by: string;
  windowMs: number;
  windowText: string;
  over: number;
  then: "hold" | "deny";
  why?: string;
};

export type CompiledEscalateStep = {
  afterMs: number;
  add?: "backup";
  post?: string;
  mention?: string;
  notify?: "requester";
};

export type CompiledApprovers = {
  label: string;
  anyOf: ApproverRef[];
  exclude: string[];
  excludeAgentOwnerFrom: Tier | "never";
  quorum: Partial<Record<Tier, number>> & { default: number };
  fallback: { group: string; room: string };
};

export type CompiledClass = {
  name: string;
  deny: boolean;
  denyReason?: string;
  summary: string;
  match: CompiledMatch[];
  extract: { name: string; expr: CompiledExpression }[];
  risk: { base: number; add: CompiledRule[] };
  aggregate: CompiledAggregate[];
  reversible?: boolean;
  approvers: CompiledApprovers | null;
  escalate: CompiledEscalateStep[];
  autonomy: {
    maxLevel: Level;
    buckets: { name: string; when: CompiledExpression; label?: string; dailyCap?: number }[];
    promoteAfter: Criteria;
  } | null;
  drills: boolean;
};

export type CompiledPolicy = {
  hash: string;
  source: string;
  /** The file as it was read: what `hash` is the hash of. */
  text: string;
  file: PolicyFile;
  currency: string;
  tiers: { name: Tier; min: number; max: number }[];
  requestTtlMs: number;
  grantTtlMs: number;
  defaults: PolicyFile["defaults"];
  safe: CompiledMatch[];
  protected: CompiledMatch[];
  classes: CompiledClass[];
};

const MATCH_KINDS: MatchKind[] = ["gate", "mcp", "shell", "file_write", "file_read", "http"];

/** `*` matches anything including "/". Gate endpoints and MCP tools use this; the rest are regexes. */
function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

function compileMatch(entry: MatchEntry, path: Path, source: YamlSource): CompiledMatch {
  const kind = MATCH_KINDS.find((candidate) => entry[candidate] !== undefined) as MatchKind;
  const pattern = entry[kind] as string;
  let re: RegExp;
  if (kind === "gate" || (kind === "mcp" && !pattern.startsWith("^"))) {
    re = globToRegExp(pattern);
  } else {
    try {
      re = new RegExp(pattern);
    } catch (error) {
      throw source.fail([...path, kind], `invalid regular expression: ${(error as Error).message}`);
    }
  }
  const viaGate = entry.via_gate === true;
  if (viaGate && kind !== "shell" && kind !== "mcp") {
    throw source.fail([...path, "via_gate"], "via_gate only applies to shell and mcp entries");
  }
  if (viaGate && kind === "shell" && !pattern.startsWith("^")) {
    throw source.fail([...path, kind], "a via_gate shell pattern must start with ^, or it could wave through any command");
  }
  return { kind, pattern, re, viaGate };
}

function compileExpr(text: string, path: Path, source: YamlSource, known: Set<string>): CompiledExpression {
  let compiled: CompiledExpression;
  try {
    compiled = compileExpression(text);
  } catch (error) {
    if (error instanceof ExpressionError) throw source.fail(path, `bad expression "${text}": ${error.message}`);
    throw error;
  }
  for (const identifier of compiled.identifiers) {
    if (identifier !== "args" && !known.has(identifier)) {
      throw source.fail(path, `"${identifier}" is not defined; extract it first`);
    }
  }
  return compiled;
}

function compileClass(name: string, source: YamlSource, file: PolicyFile): CompiledClass {
  const raw = file.classes[name];
  if (!raw) throw new Error(`no class ${name}`);
  const path: Path = ["classes", name];
  const deny = raw.decision === "deny";
  if (!deny && !raw.approvers) throw source.fail(path, "a class needs approvers unless its decision is deny");
  if (!deny && !raw.risk) throw source.fail(path, "a class needs risk rules unless its decision is deny");
  const match = raw.match.map((entry, index) => compileMatch(entry, [...path, "match", index], source));

  const known = new Set<string>();
  const extract = Object.entries(raw.extract ?? {}).map(([field, text]) => {
    const expr = compileExpr(text, [...path, "extract", field], source, known);
    known.add(field);
    return { name: field, expr };
  });
  const add = (raw.risk?.add ?? []).map((rule, index): CompiledRule => {
    const compiled: CompiledRule = {
      when: compileExpr(rule.when, [...path, "risk", "add", index, "when"], source, known),
      points: rule.points,
      ...(rule.if_unknown === "skip" ? { skipIfUnknown: true } : {}),
    };
    if (rule.flag) compiled.flag = rule.flag;
    if (rule.why) compiled.why = rule.why;
    return compiled;
  });
  const aggregate = (raw.aggregate ?? []).map((rule, index): CompiledAggregate => {
    for (const field of ["sum", "by"] as const) {
      if (!known.has(rule[field])) {
        throw source.fail([...path, "aggregate", index, field], `"${rule[field]}" is not defined; extract it first`);
      }
    }
    const compiled: CompiledAggregate = {
      sum: rule.sum,
      by: rule.by,
      windowMs: parseDuration(rule.window),
      windowText: rule.window,
      over: rule.over,
      then: rule.then,
    };
    if (rule.why) compiled.why = rule.why;
    return compiled;
  });
  const approvers: CompiledApprovers | null = raw.approvers
    ? {
        label: raw.approvers.label ?? firstLabel(raw.approvers.any_of),
        anyOf: raw.approvers.any_of,
        exclude: raw.approvers.exclude ?? [],
        excludeAgentOwnerFrom: raw.approvers.exclude_agent_owner_from ?? file.defaults.exclude_agent_owner_from,
        quorum: raw.approvers.quorum ?? { default: 1 },
        fallback: raw.approvers.fallback ?? file.defaults.fallback,
      }
    : null;
  for (const [index, ref] of (raw.approvers?.any_of ?? []).entries()) {
    if (ref.owner_of && !known.has(ref.owner_of)) {
      throw source.fail([...path, "approvers", "any_of", index], `"${ref.owner_of}" is not defined; extract it first`);
    }
  }
  const escalate = (raw.escalate ?? []).map((step): CompiledEscalateStep => {
    const compiled: CompiledEscalateStep = { afterMs: parseDuration(step.after) };
    if (step.add) compiled.add = step.add;
    if (step.post) compiled.post = step.post;
    if (step.mention) compiled.mention = step.mention;
    if (step.notify) compiled.notify = step.notify;
    return compiled;
  });
  const autonomy = raw.autonomy
    ? {
        maxLevel: raw.autonomy.max_level,
        buckets: (raw.autonomy.buckets ?? []).map((bucket, index) => ({
          name: bucket.name,
          when: compileExpr(bucket.when, [...path, "autonomy", "buckets", index, "when"], source, known),
          ...(bucket.label ? { label: bucket.label } : {}),
          ...(bucket.daily_cap !== undefined ? { dailyCap: bucket.daily_cap } : {}),
        })),
        promoteAfter: {
          approvals: raw.autonomy.promote_after?.approvals ?? F11_CRITERIA.approvals,
          days: raw.autonomy.promote_after?.days ?? F11_CRITERIA.days,
          minDistinctApprovers: raw.autonomy.promote_after?.min_distinct_approvers ?? F11_CRITERIA.minDistinctApprovers,
        },
      }
    : null;

  const compiled: CompiledClass = {
    name,
    deny,
    summary: raw.summary ?? `${name} actions`,
    match,
    extract,
    risk: { base: raw.risk?.base ?? 0, add },
    aggregate,
    approvers,
    escalate,
    autonomy,
    drills: raw.drills ?? false,
  };
  if (raw.reversible !== undefined) compiled.reversible = raw.reversible;
  if (raw.reason) compiled.denyReason = raw.reason;
  return compiled;
}

function firstLabel(anyOf: ApproverRef[]): string {
  for (const ref of anyOf) if (ref.group) return ref.group;
  for (const ref of anyOf) if (ref.role) return ref.role;
  return "approver";
}

function compileTiers(file: PolicyFile, source: YamlSource): CompiledPolicy["tiers"] {
  const names: Tier[] = ["low", "medium", "high", "critical"];
  const tiers = names.map((name) => {
    const range = file.tiers[name];
    return { name, min: range[0], max: range[1] };
  });
  for (let index = 1; index < tiers.length; index += 1) {
    const previous = tiers[index - 1] as (typeof tiers)[number];
    const current = tiers[index] as (typeof tiers)[number];
    if (previous.max !== current.min) {
      throw source.fail(["tiers", current.name], `tiers must not leave gaps: ${previous.name} ends at ${previous.max}`);
    }
  }
  return tiers;
}

export function parsePolicy(text: string, fileLabel: string): CompiledPolicy {
  const source = new YamlSource(text, fileLabel);
  const file = source.parseWith(PolicyFileSchema);
  return {
    hash: sha256Hex(text),
    source: fileLabel,
    text,
    file,
    currency: file.currency,
    tiers: compileTiers(file, source),
    requestTtlMs: parseDuration(file.defaults.request_ttl),
    grantTtlMs: parseDuration(file.defaults.grant_ttl),
    defaults: file.defaults,
    safe: file.safe.map((entry, index) => compileMatch(entry, ["safe", index], source)),
    protected: file.protected.map((entry, index) => compileMatch(entry, ["protected", index], source)),
    classes: Object.keys(file.classes).map((name) => compileClass(name, source, file)),
  };
}

export function loadPolicy(path: string): CompiledPolicy {
  return parsePolicy(readFileSync(path, "utf8"), path);
}

export function parseTeam(text: string, fileLabel: string): TeamFile {
  const source = new YamlSource(text, fileLabel);
  const team = source.parseWith(TeamFileSchema);
  const ids = new Set(team.people.map((person) => person.id));
  for (const [name, entries] of Object.entries(team.rotas)) {
    entries.forEach((entry, index) => {
      if (!ids.has(entry.person)) throw source.fail(["rotas", name, index], `no person "${entry.person}"`);
    });
  }
  for (const [name, owner] of Object.entries(team.owners.services)) {
    if (!ids.has(owner)) throw source.fail(["owners", "services", name], `no person "${owner}"`);
  }
  for (const [name, agent] of Object.entries(team.agents)) {
    if (!ids.has(agent.owner)) throw source.fail(["agents", name, "owner"], `no person "${agent.owner}"`);
  }
  team.people.forEach((person, index) => {
    if (person.delegate_to && !ids.has(person.delegate_to)) {
      throw source.fail(["people", index], `no person "${person.delegate_to}"`);
    }
  });
  return team;
}

export function loadTeam(path: string): TeamFile {
  return parseTeam(readFileSync(path, "utf8"), path);
}

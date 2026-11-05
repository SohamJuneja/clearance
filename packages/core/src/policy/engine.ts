/**
 * The decision pipeline, in the exact order of PLAN 7.3:
 *   1. Normalise to Action  2. deny classes  3. safe list  4. first matching class -> extract ->
 *   aggregate -> risk score -> tier  5. autonomy  6. no class and protected -> hold  7. hold -> route
 * Step 7 lives in core: this file decides, it does not act. A grant is consulted in step 4, once the
 * class and hash are known, because an approved call does not need scoring again.
 *
 * A shell line goes through that pipeline once per sub-command, and the most severe result wins. So `ls && git
 * push` is held, `git push && rm -rf /` cannot ride on a push grant, and what cannot be read with confidence is
 * held. For a hook call, call_hash covers the risky sub-command in normalised form, not the raw bytes.
 */
import type { Action, CanonicalCall, Clock, Decision, Flag, LookupPort, Tier } from "@clearance/contracts";
import { capLevel, levelAllowsWithoutHuman, type AutonomyStore, type Level } from "../autonomy/store.js";
import {
  denyingClass,
  fileCall,
  firstClass,
  isKnownMcpServer,
  isProtected,
  isSafe,
  normaliseCall,
  subCommandCall,
  type NormalCall,
} from "../classify/classify.js";
import { parseShell, type ParsedShell, type SubCommand } from "../classify/shell.js";
import { toNumber } from "../format.js";
import { callHash } from "../hash.js";
import type { AggregateStore } from "../risk/aggregates.js";
import {
  aboveNormalRangeFlag,
  aggregateFlag,
  overCapFlag,
  dynamicArgsFlag,
  MALFORMED_FLAG,
  missingDataFlag,
  NO_RULE_FLAG,
  ruleFlag,
  unparsedFlag,
} from "../risk/flags.js";
import { evaluateExpression, UNKNOWN, type EvalScope } from "./expr.js";
import { makeHelpers } from "./helpers.js";
import type { CompiledClass, CompiledPolicy } from "./load.js";

export const UNKNOWN_PROTECTED_CLASS = "unknown_protected";
export const MALFORMED_CLASS = "malformed";
export const UNPARSED_CLASS = "unparsed";
const DENIED_MCP_CLASS = "protected_config";

/** Grants for this exact call. `consumeAll` is atomic: all of them, or none and null. */
export type GrantPort = {
  has(hash: string, action: Action): boolean;
  consumeAll(hashes: string[], action: Action): { requestIds: string[] } | null;
};

export type EngineDeps = {
  policy: CompiledPolicy;
  lookup: LookupPort;
  clock: Clock;
  aggregates: Pick<AggregateStore, "sum">;
  autonomy: Pick<AutonomyStore, "levelFor"> & Partial<Pick<AutonomyStore, "ceiling" | "spentToday">>;
  grants?: GrantPort | undefined;
};

export type Step =
  | "malformed"
  | "unparsed"
  | "unknown_agent"
  | "deny_class"
  | "safe"
  | "via_gate"
  | "grant"
  | "aggregate_deny"
  | "autonomy"
  | "class_hold"
  | "unknown_protected"
  | "unmatched";

export type AggregateHit = {
  sum: string;
  by: string;
  key: string;
  value: number;
  prior: number;
  over: number;
  windowMs: number;
  hit: boolean;
};

export type FiredRule = { source: string; points: number; certain: boolean; flag?: string; why?: string };

export type Evaluation = {
  decision: Decision;
  step: Step;
  /** Class name; null when no class matched. */
  cls: string | null;
  call: CanonicalCall;
  callHash: string;
  tier?: Tier;
  score?: number;
  flags: Flag[];
  /** For a non-hold: the reason to return. For a hold, core builds the "HELD CLR-..." sentence from holdSummary. */
  reason: string;
  /** "refunds over ₹10,000 need finance approval". */
  holdSummary?: string;
  policySubject?: string;
  extracted: Record<string, unknown>;
  lookups: Record<string, Record<string, unknown>>;
  fired: FiredRule[];
  aggregates: AggregateHit[];
  bucket?: string;
  level?: Level;
  /** Whether autonomy could have run this: no forced hold, no missing data, not critical. Replay reads it. */
  autoEligible?: boolean;
  grantRequestId?: string;
};

type Identity = Pick<Evaluation, "call" | "callHash">;

function identityOf(call: NormalCall | null, clsName: string): Identity {
  const canonical: CanonicalCall = { class: clsName, target: call?.target ?? "", args: call?.args ?? {} };
  return { call: canonical, callHash: callHash(canonical) };
}

const EMPTY = { flags: [], extracted: {}, lookups: {}, fired: [], aggregates: [] };

const DENIED_REASON =
  "DENIED by policy: agents may not touch Clearance's configuration, credentials or systems of record directly. Do not try another way.";

function highScore(policy: CompiledPolicy): number {
  return policy.tiers.find((tier) => tier.name === "high")?.min ?? 55;
}

function denied(identity: Identity, cls: CompiledClass): Evaluation {
  return {
    ...EMPTY,
    ...identity,
    decision: "deny",
    step: "deny_class",
    cls: cls.name,
    reason: cls.denyReason ?? DENIED_REASON,
  };
}

function granted(identity: Identity, cls: string | null, requestId: string): Evaluation {
  return { ...EMPTY, ...identity, decision: "allow", step: "grant", cls, reason: `Approved: ${requestId}`, grantRequestId: requestId };
}

function viaGate(identity: Identity, cls: string): Evaluation {
  return {
    ...EMPTY,
    ...identity,
    decision: "allow",
    step: "via_gate",
    cls,
    reason: "This goes through clearance-gate, which holds it if it needs a person.",
  };
}

function unknownProtected(identity: Identity, policy: CompiledPolicy): Evaluation {
  return {
    ...EMPTY,
    ...identity,
    decision: policy.defaults.unknown_protected_action,
    step: "unknown_protected",
    cls: null,
    tier: "high",
    score: highScore(policy),
    flags: [NO_RULE_FLAG],
    reason: "DENIED: no policy rule covers this protected resource.",
    holdSummary: "this touches a protected resource with no policy rule and needs approval",
  };
}

export async function evaluateAction(action: Action, deps: EngineDeps): Promise<Evaluation> {
  const { policy } = deps;
  const call = normaliseCall(action, policy);

  // 1. The Action is missing the part its kind needs: we cannot tell what this is, so a human decides.
  if (!call) {
    return {
      ...EMPTY,
      ...identityOf(null, MALFORMED_CLASS),
      decision: "hold",
      step: "malformed",
      cls: null,
      tier: "high",
      score: highScore(policy),
      flags: [MALFORMED_FLAG],
      reason: "malformed action",
      holdSummary: "this call could not be read and needs approval",
    };
  }
  return call.kind === "shell" ? evaluateShell(action, call, deps) : evaluateCall(action, call, deps);
}

/** Everything that is not a shell line: one call, straight down the pipeline. */
async function evaluateCall(action: Action, call: NormalCall, deps: EngineDeps): Promise<Evaluation> {
  const { policy } = deps;

  // 2. Deny classes come first, before anything can be called safe.
  const cls = denyingClass(call, policy);
  if (cls) return denied(identityOf(call, cls.name), cls);
  if (call.kind === "mcp" && !isKnownMcpServer(call, policy)) {
    return {
      ...EMPTY,
      ...identityOf(call, DENIED_MCP_CLASS),
      decision: "deny",
      step: "deny_class",
      cls: DENIED_MCP_CLASS,
      reason: `DENIED by policy: MCP server ${call.server} is not known here. Do not try another way.`,
    };
  }

  // 3. Safe list: pass silently.
  if (isSafe(call, policy)) return { ...EMPTY, ...identityOf(call, "safe"), decision: "allow", step: "safe", cls: null, reason: "safe" };

  // 4. First matching class.
  const hit = firstClass(call, policy);
  if (hit) {
    const identity = identityOf(call, hit.cls.name);
    if (hit.viaGate && action.source === "hook") return viaGate(identity, hit.cls.name);
    const requestId = takeGrants([identity.callHash], action, deps);
    if (requestId) return granted(identity, hit.cls.name, requestId);
    return assessClass(action, call, hit.cls, identity, deps);
  }

  // 6. No class matched.
  const identity = identityOf(call, UNKNOWN_PROTECTED_CLASS);
  if (isProtected(call, policy)) {
    const requestId = takeGrants([identity.callHash], action, deps);
    if (requestId) return granted(identity, null, requestId);
    return unknownProtected(identity, policy);
  }
  return { ...EMPTY, ...identity, decision: "allow", step: "unmatched", cls: null, reason: "no rule, not protected" };
}

function takeGrants(hashes: string[], action: Action, deps: EngineDeps): string | null {
  if (!deps.grants || !hashes.every((hash) => deps.grants?.has(hash, action))) return null;
  return deps.grants.consumeAll(hashes, action)?.requestIds[0] ?? null;
}

type Risky = { call: NormalCall; cls: CompiledClass | null; identity: Identity; dynamic: string[] };

/** The deny classes get the whole line too when it could not be read: `eval 'curl ...:7800'` says what it says. */
function shellDeny(parsed: ParsedShell, line: NormalCall, action: Action, policy: CompiledPolicy): CompiledClass | null {
  const cwd = action.agent.cwd;
  const calls: NormalCall[] = parsed.commands.flatMap((command) => [
    ...(command.effective ? [subCommandCall(command)] : []),
    ...command.writes.map((path) => fileCall("file_write", path, cwd)),
    ...command.reads.map((path) => fileCall("file_read", path, cwd)),
  ]);
  if (!parsed.ok) calls.push(line);
  for (const call of calls) {
    const cls = denyingClass(call, policy);
    if (cls) return cls;
  }
  return null;
}

function classifySubCommand(
  command: SubCommand,
  action: Action,
  policy: CompiledPolicy,
): { safe: boolean; viaGateClass: string | null; risky: Risky[] } {
  const risky: Risky[] = [];
  let safe = true;
  let viaGateClass: string | null = null;

  if (command.effective) {
    const call = subCommandCall(command);
    if (!isSafe(call, policy)) {
      safe = false;
      const hit = firstClass(call, policy);
      if (hit?.viaGate && action.source === "hook") {
        viaGateClass = hit.cls.name;
      } else if (hit) {
        risky.push({ call, cls: hit.cls, identity: identityOf(call, hit.cls.name), dynamic: command.dynamic });
      } else if (isProtected(call, policy)) {
        risky.push({ call, cls: null, identity: identityOf(call, UNKNOWN_PROTECTED_CLASS), dynamic: command.dynamic });
      }
    }
  }
  for (const path of command.writes) {
    const call = fileCall("file_write", path, action.agent.cwd);
    if (isSafe(call, policy)) continue;
    safe = false;
    if (isProtected(call, policy)) {
      risky.push({ call, cls: null, identity: identityOf(call, UNKNOWN_PROTECTED_CLASS), dynamic: [] });
    }
  }
  return { safe, viaGateClass, risky };
}

async function evaluateShell(action: Action, line: NormalCall, deps: EngineDeps): Promise<Evaluation> {
  const { policy } = deps;
  const parsed = parseShell(line.subject);

  // 2. Deny classes first, over every sub-command and every path it writes.
  const deny = shellDeny(parsed, line, action, policy);
  if (deny) return denied(identityOf(line, deny.name), deny);

  // Not read with confidence: hold, bound to the exact bytes, since there is nothing better to bind to.
  if (!parsed.ok) {
    const identity = identityOf(line, UNPARSED_CLASS);
    const requestId = takeGrants([identity.callHash], action, deps);
    if (requestId) return granted(identity, null, requestId);
    return {
      ...EMPTY,
      ...identity,
      decision: "hold",
      step: "unparsed",
      cls: null,
      tier: "high",
      score: highScore(policy),
      flags: [unparsedFlag(parsed.reason ?? "the shell line")],
      reason: "unreadable shell line",
      holdSummary: "this shell line could not be read with confidence and needs approval",
    };
  }

  // 3 and 4, per sub-command. Safe only applies when every part is safe.
  const parts = parsed.commands.map((command) => classifySubCommand(command, action, policy));
  const risky = dedupe(parts.flatMap((part) => part.risky));

  if (risky.length === 0) {
    const viaGateClass = parts.find((part) => part.viaGateClass)?.viaGateClass;
    if (viaGateClass) return viaGate(identityOf(line, viaGateClass), viaGateClass);
    const allSafe = parts.length > 0 && parts.every((part) => part.safe);
    return allSafe
      ? { ...EMPTY, ...identityOf(line, "safe"), decision: "allow", step: "safe", cls: null, reason: "safe" }
      : { ...EMPTY, ...identityOf(line, UNKNOWN_PROTECTED_CLASS), decision: "allow", step: "unmatched", cls: null, reason: "no rule, not protected" };
  }

  // A grant covers one risky part. The line runs only when every risky part has one.
  const without = risky.filter((part) => !deps.grants?.has(part.identity.callHash, action));
  if (without.length === 0) {
    const hashes = risky.map((part) => part.identity.callHash);
    const requestId = deps.grants?.consumeAll(hashes, action)?.requestIds[0];
    const first = risky[0] as Risky;
    if (requestId) return granted(first.identity, first.cls?.name ?? null, requestId);
  }
  return mostSevere(action, without.length > 0 ? without : risky, deps);
}

function dedupe(risky: Risky[]): Risky[] {
  const seen = new Set<string>();
  return risky.filter((part) => {
    if (seen.has(part.identity.callHash)) return false;
    seen.add(part.identity.callHash);
    return true;
  });
}

/** Scores every part still needing a person. A deny beats a hold beats an allow; among holds, the highest score. */
async function mostSevere(action: Action, parts: Risky[], deps: EngineDeps): Promise<Evaluation> {
  const results: { evaluation: Evaluation; part: Risky }[] = [];
  for (const part of parts) {
    const evaluation = part.cls
      ? await assessClass(action, part.call, part.cls, part.identity, deps)
      : unknownProtected(part.identity, deps.policy);
    results.push({ evaluation, part });
  }
  const order: Decision[] = ["deny", "hold", "allow"];
  const worst = order.find((decision) => results.some((result) => result.evaluation.decision === decision)) as Decision;
  const candidates = results.filter((result) => result.evaluation.decision === worst);
  const chosen = candidates.reduce((best, next) =>
    (next.evaluation.score ?? 0) > (best.evaluation.score ?? 0) ? next : best,
  );
  const dynamic = chosen.part.dynamic;
  if (dynamic.length === 0) return chosen.evaluation;
  return { ...chosen.evaluation, flags: [...chosen.evaluation.flags, dynamicArgsFlag(dynamic)] };
}

async function assessClass(
  action: Action,
  call: NormalCall,
  cls: CompiledClass,
  identity: Identity,
  deps: EngineDeps,
): Promise<Evaluation> {
  const { policy, clock } = deps;
  const lookups: Record<string, Record<string, unknown>> = {};
  const vars: Record<string, unknown> = { args: call.args };
  const scope: EvalScope = {
    vars,
    structuredArgs: call.structured,
    helpers: makeHelpers({
      action,
      args: call.args,
      policy,
      lookup: deps.lookup,
      clock,
      lookups,
      lookupMisses: new Set(),
    }),
  };

  // Extract. An unknown field stays out of `vars`, so anything that reads it is unknown too.
  const extracted: Record<string, unknown> = {};
  const unknownFields = new Set<string>();
  for (const { name, expr } of cls.extract) {
    const value = await evaluateExpression(expr, scope);
    // A whole object where a value belongs is a system of record answering with a shape we don't understand.
    if (value === UNKNOWN || (typeof value === "object" && value !== null && !Array.isArray(value))) {
      unknownFields.add(name);
    } else {
      extracted[name] = value;
      vars[name] = value;
    }
  }

  // Aggregate rules: a sliding window per key. A hit forces a hold whatever the score says.
  const flags: Flag[] = [];
  const missing = new Set<string>();
  const aggregates: AggregateHit[] = [];
  let forceHold = false;
  let forceDeny = false;
  let aggregateWhy: string | undefined;
  for (const rule of cls.aggregate) {
    const value = toNumber(extracted[rule.sum]);
    const key = extracted[rule.by];
    if (value === null || (typeof key !== "string" && typeof key !== "number")) {
      // Cannot add it up, so we cannot say it is under the limit.
      forceHold = true;
      if (value === null) missing.add(rule.sum);
      else missing.add(rule.by);
      continue;
    }
    const windowMs = clock.scaledMs(rule.windowMs);
    const prior = deps.aggregates.sum(cls.name, rule.by, String(key), clock.nowMs() - windowMs);
    const over = prior + value > rule.over;
    aggregates.push({ sum: rule.sum, by: rule.by, key: String(key), value, prior, over: rule.over, windowMs, hit: over });
    if (!over) continue;
    if (rule.then === "deny") forceDeny = true;
    forceHold = true;
    // One big call is not structuring: the score rules handle it. Only accumulation earns the flag.
    if (prior > 0) {
      flags.push(aggregateFlag(prior, value, rule.over, rule.windowText, policy.currency));
      aggregateWhy ??= rule.why;
    }
  }

  // Risk. An unknown condition counts as true, and we say so.
  let score = cls.risk.base;
  const fired: FiredRule[] = [];
  for (const rule of cls.risk.add) {
    const result = await evaluateExpression(rule.when, scope);
    if (result === false) continue;
    const certain = result === true;
    score += rule.points;
    const firedRule: FiredRule = { source: rule.when.source, points: rule.points, certain };
    if (rule.flag) firedRule.flag = rule.flag;
    if (rule.why) firedRule.why = rule.why;
    fired.push(firedRule);
    if (certain) {
      if (rule.flag) flags.push(ruleFlag(rule.flag, extracted, policy.currency));
    } else {
      const read = [...rule.when.identifiers].filter((name) => unknownFields.has(name));
      if (read.length > 0) read.forEach((name) => missing.add(name));
      else missing.add(rule.flag ?? rule.when.source);
    }
  }
  if (missing.size > 0) flags.push(missingDataFlag([...missing]));
  score = clampScore(score, policy);
  const tier = tierFor(score, policy);

  const label = cls.approvers?.label ?? cls.name;
  const subject = fired.find((rule) => rule.certain && rule.why)?.why ?? aggregateWhy ?? cls.summary;
  const common = {
    ...identity,
    cls: cls.name,
    tier,
    score,
    flags,
    extracted,
    lookups,
    fired,
    aggregates,
    policySubject: subject,
    holdSummary: `${subject} need ${label} approval`,
  };

  if (forceDeny) {
    return { ...common, decision: "deny", step: "aggregate_deny", reason: `DENIED by policy: ${subject}.` };
  }

  // 5. Autonomy. Forced holds, missing data and the critical tier never run on their own.
  const bucket = await bucketFor(cls, scope);
  const inBucket = cls.autonomy?.buckets.find((candidate) => candidate.name === bucket);
  let level = cls.autonomy && bucket !== null ? capLevel(deps.autonomy.levelFor(action.agent.name, cls.name, bucket), cls.autonomy.maxLevel) : null;
  // L3 gets to be silent because it has a budget. Without one, someone still looks: it asks for a review, as L2 does.
  if (level === "L3" && inBucket?.dailyCap === undefined) level = "L2";
  const autoEligible = !forceHold && missing.size === 0 && tier !== "critical";

  const amount = toNumber(extracted.amount);
  let overCap = false;
  if (level && level !== "L0" && bucket !== null) {
    const ceiling = amount === null ? null : (deps.autonomy.ceiling?.(action.agent.name, cls.name, bucket, clock.nowMs()) ?? null);
    if (amount !== null && ceiling !== null && amount > ceiling) {
      // Above what's normal here, so a person looks at this one call, as an ordinary hold. The bucket keeps its level.
      flags.push(aboveNormalRangeFlag(amount, ceiling, policy.currency));
      level = "L0";
    }
  }
  if (level === "L3" && bucket !== null && inBucket?.dailyCap !== undefined) {
    // Not knowing what has been spent is not the same as having budget left.
    const spent = deps.autonomy.spentToday?.(action.agent.name, cls.name, bucket, clock.nowMs()) ?? Number.POSITIVE_INFINITY;
    if (spent + (amount ?? 1) > inBucket.dailyCap) {
      overCap = true;
      flags.push(overCapFlag(spent, inBucket.dailyCap, amount !== null, policy.currency));
    }
  }

  if (level && bucket !== null && levelAllowsWithoutHuman(level) && autoEligible && !overCap) {
    return { ...common, decision: "allow", step: "autonomy", reason: `Autonomy ${level}`, bucket, level, autoEligible };
  }

  // 7. Hold.
  const result: Evaluation = { ...common, decision: "hold", step: "class_hold", reason: `HELD: ${common.holdSummary}`, autoEligible };
  if (bucket !== null) result.bucket = bucket;
  if (level) result.level = level;
  return result;
}

/** The bucket a call falls in: the first whose rule is true. Unknown is not true, so a missing field is in no bucket. */
export async function bucketFor(cls: CompiledClass, scope: EvalScope): Promise<string | null> {
  if (!cls.autonomy) return null;
  if (cls.autonomy.buckets.length === 0) return "default";
  for (const bucket of cls.autonomy.buckets) {
    if ((await evaluateExpression(bucket.when, scope)) === true) return bucket.name;
  }
  return null;
}

/** Rules can add up past the top of the table. The score stays on the table, and over the top means the top tier. */
export function clampScore(score: number, policy: CompiledPolicy): number {
  const lowest = policy.tiers[0]?.min ?? 0;
  const highest = (policy.tiers[policy.tiers.length - 1]?.max ?? 101) - 1;
  return Math.max(lowest, Math.min(highest, score));
}

export function tierFor(score: number, policy: CompiledPolicy): Tier {
  const clamped = clampScore(score, policy);
  for (const tier of policy.tiers) {
    if (clamped >= tier.min && clamped < tier.max) return tier.name;
  }
  return "critical";
}

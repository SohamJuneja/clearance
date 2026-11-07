/**
 * The page's "Try it": Clearance's own classifier and policy engine, bundled for the browser by site/build.ts with the
 * real policy file inside. Nothing here decides anything itself: `decide` builds the Action a hook sends for a shell
 * line and hands it to core's `evaluateAction`, with what a fresh install has and nothing connected.
 *
 * site/playground/engine.test.ts runs every shell case in policy/tests/ through this bundle and through core, and
 * checks they agree.
 */
import type { Action, LookupPort } from "../../packages/contracts/src/index.ts";
import { evaluateAction, type EngineDeps, type Evaluation } from "../../packages/core/src/policy/engine.ts";
import { parsePolicy, type CompiledPolicy } from "../../packages/core/src/policy/load.ts";
import type { ApproverRef } from "../../packages/core/src/policy/schema.ts";

export { evaluateAction, parsePolicy };

/** The agent the page asks as: the demo's refunds agent, on Claude Code, through its hook. */
export const AGENT = { name: "refunds-agent", vendor: "claude", cwd: "/agents/refunds-agent" } as const;

export function shellAction(command: string, at: Date = new Date()): Action {
  return {
    id: `site-${at.getTime()}`,
    at: at.toISOString(),
    source: "hook",
    vendor: AGENT.vendor,
    agent: { name: AGENT.name, cwd: AGENT.cwd },
    kind: "shell",
    shell: { command },
    raw: { tool: "Bash", command },
  };
}

/** No systems of record here, so every lookup comes back empty, and the policy counts what it can't know against the call. */
const noRecords: LookupPort = { lookup: async () => null };

/** A fresh install: nothing refunded yet, no agent promoted, no approvals waiting to be spent. */
export function freshDeps(policy: CompiledPolicy, nowMs: () => number = () => Date.now()): EngineDeps {
  return {
    policy,
    lookup: noRecords,
    clock: { nowMs, scaledMs: (ms) => ms / policy.file.time_scale },
    aggregates: { sum: () => 0 },
    autonomy: { levelFor: () => "L0", ceiling: () => null, spentToday: () => 0 },
  };
}

export type Verdict = {
  decision: Evaluation["decision"];
  step: Evaluation["step"];
  cls: string | null;
  tier: string | null;
  score: number | null;
  reason: string;
  holdSummary: string | null;
  flags: string[];
  callHash: string;
  /**
   * Who the policy says may decide, for a hold. A hold with no class goes to the policy's fallback group and room. Which
   * person that is, core's router settles from the team file and Switch's own events.
   */
  approvers: { label: string; anyOf: string; quorum: string | null; room: string | null } | null;
  reversible: boolean | null;
};

/** The word on the page's stamp. The hook lets a call to bin/acme through because the gate holds the key and decides there. */
export function stampWord(verdict: Pick<Verdict, "decision" | "step">): string {
  if (verdict.step === "via_gate") return "TO THE GATE";
  return { allow: "ALLOWED", hold: "HELD", deny: "DENIED" }[verdict.decision];
}

const refText = (ref: ApproverRef): string =>
  ref.role ? `role ${ref.role}` : ref.group ? `group ${ref.group}` : ref.owner_of ? `the owner of the ${ref.owner_of}` : `${ref.person ?? "someone"}`;

export function verdictOf(evaluation: Evaluation, policy: CompiledPolicy): Verdict {
  const cls = policy.classes.find((one) => one.name === evaluation.cls) ?? null;
  const held = evaluation.decision === "hold";
  const fallback = policy.defaults.fallback;
  const approvers = !held
    ? null
    : cls?.approvers
      ? {
          label: cls.approvers.label,
          anyOf: cls.approvers.anyOf.map(refText).join(" or "),
          quorum: Object.entries(cls.approvers.quorum)
            .map(([tier, count]) => (tier === "default" ? `${count}` : `${count} if ${tier}`))
            .join(", "),
          room: null,
        }
      : { label: fallback.group, anyOf: `group ${fallback.group}`, quorum: null, room: fallback.room };
  return {
    decision: evaluation.decision,
    step: evaluation.step,
    cls: evaluation.cls,
    tier: evaluation.tier ?? null,
    score: evaluation.score ?? null,
    reason: evaluation.reason,
    holdSummary: evaluation.holdSummary ?? null,
    flags: evaluation.flags.map((flag) => flag.text),
    callHash: evaluation.callHash,
    approvers,
    reversible: cls?.reversible ?? null,
  };
}

/** What each step of core's pipeline means to the person reading the answer. The decision itself is the engine's. */
const WHY: Partial<Record<Verdict["step"], (verdict: Verdict) => string>> = {
  safe: () => "It's on the policy's safe list, so it runs and nobody is asked.",
  unmatched: () => "No rule covers it and nothing it touches is protected, so it runs.",
  via_gate: () =>
    "The hook lets it through, because bin/acme holds no key. The gate holds the key, and asks core about the call itself, with its real arguments. That's where CLR-0001 was held.",
  deny_class: () => "A deny rule: agents may never do this. No card is sent, and nobody can approve it.",
  aggregate_deny: () => "Added to what came before, it's over the policy's limit, and the policy says deny.",
  class_hold: (verdict) => `It's a ${(verdict.cls ?? "").replace(/_/g, " ")} call. The agent is told to stop, and a native Switch card goes to a person.`,
  unknown_protected: () => "No rule names it, but it touches something protected, so a person decides.",
  outside_read: () => "It reads outside the agent's own directory, so a person looks first.",
  unparsed: () => "Core can't read this line with confidence, and what it can't read, it holds.",
  malformed: () => "The call can't be read at all, so a person decides.",
};

/** Who gets a card, in words, from the policy. Which person, core's router settles with Switch's events. */
function cardText(verdict: Verdict): string {
  if (verdict.decision === "deny") return "No card. Nobody can approve it.";
  if (verdict.step === "via_gate") return "None from the hook. The gate asks for one, with the call's real arguments.";
  if (verdict.decision === "allow") return "No card. It runs.";
  const approvers = verdict.approvers;
  if (!approvers) return "A person, through a native Switch card. Never the person who asked.";
  if (approvers.room) return `No class names approvers, so the card goes to the policy's fallback: ${approvers.anyOf}, in ${approvers.room}. Never the person who asked.`;
  const quorum = approvers.quorum ? ` Approvals needed: ${approvers.quorum}.` : "";
  return `${approvers.label} approvers: ${approvers.anyOf}.${quorum} Never the person who asked.`;
}

export type Presented = {
  word: string;
  kind: "allow" | "hold" | "deny" | "gate";
  sub: string;
  decision: string;
  cls: string;
  tier: string;
  why: string;
  reason: string;
  flags: string[];
  card: string;
  hash: string;
  live: string;
};

/** The answer as the page shows it, for the build's first answer and the browser's every one after. */
export function present(verdict: Verdict): Presented {
  const word = stampWord(verdict);
  const why = WHY[verdict.step]?.(verdict) ?? "See what core says.";
  const name = verdict.cls?.replace(/_/g, " ");
  return {
    word,
    kind: verdict.step === "via_gate" ? "gate" : verdict.decision,
    sub: name ? `${name}${verdict.tier ? ` · ${verdict.tier}` : ""}` : verdict.tier ? `tier ${verdict.tier}` : verdict.step.replace(/_/g, " "),
    decision: `${verdict.decision}${verdict.step === "via_gate" ? ", at the hook" : ""}`,
    cls: verdict.cls ?? "none",
    tier: verdict.tier ? `${verdict.tier}, score ${verdict.score}` : "n/a",
    why,
    reason: verdict.reason,
    flags: verdict.flags,
    card: cardText(verdict),
    hash: `${verdict.callHash.slice(0, 16)}… (an approval is bound to it)`,
    live: `${word}. ${why}`,
  };
}

export type Playground = { policyHash: string; source: string; decide(command: string): Promise<Verdict> };

export function createPlayground(policyText: string, label = "policy/clearance.policy.yaml"): Playground {
  const policy = parsePolicy(policyText, label);
  return {
    policyHash: policy.hash,
    source: label,
    decide: async (command) => verdictOf(await evaluateAction(shellAction(command), freshDeps(policy)), policy),
  };
}

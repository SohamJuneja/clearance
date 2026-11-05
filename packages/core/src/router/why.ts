/**
 * Every explanation of a routing decision (F13), written from the router's trace. Nothing here decides
 * anything or looks anything up: if the trace says it, these functions can say it, and nothing else.
 */
import type { Tier } from "@clearance/contracts";
import { formatMoney, joinNames, toNumber } from "../format.js";
import { formatClock } from "../time.js";
import type { Exclusion, RankedPerson, Refusal, RouteTrace } from "./router.js";

export function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

const EXCLUSION_WORDS: Record<Exclusion, string> = {
  requester: "requester",
  agent_owner: "agent owner",
  author: "code author",
  away: "away",
  counted: "already counted",
};

/**
 * "requester, agent owner". Copy names people and never uses pronouns: core has no pronoun data and would
 * misgender real teammates.
 */
export function exclusionWords(reasons: readonly Refusal[], label: string): string {
  return reasons
    .map((reason) => (reason === "not_approver" ? `not ${article(label)} ${label} approver` : EXCLUSION_WORDS[reason]))
    .join(", ");
}

/** "Sam (finance, on duty)", as the refusal copy and the requester line say it. */
export function routeLabel(entry: RankedPerson): string {
  const parts = [entry.group];
  if (entry.rank === "rota_on_duty") parts.push(entry.backup ? "backup, on duty" : "on duty");
  else if (entry.backup) parts.push("backup");
  if (entry.ownerOf) parts.push(`owner of ${entry.ownerOf}`);
  if (entry.delegateFor) parts.push(`covering for ${entry.delegateFor}`);
  return `${entry.name} (${parts.join(", ")})`;
}

export function chosenLabels(trace: RouteTrace, ids: string[] = trace.chosen): string[] {
  return ids.flatMap((id) => {
    const entry = trace.ranked.find((ranked) => ranked.id === id);
    return entry ? [routeLabel(entry)] : [];
  });
}

function fallbackWords(trace: RouteTrace): string {
  return trace.fallback ? `${trace.fallback.group} in ${trace.fallback.room}` : "";
}

/** The sentence about who holds a request now. */
export function holderSentence(trace: RouteTrace): string {
  const labels = chosenLabels(trace);
  if (labels.length > 0) {
    const verb = labels.length === 1 ? "has" : "have";
    const also = trace.fallback ? `; the rest went to ${fallbackWords(trace)}` : "";
    return `${joinNames(labels)} ${verb} it${also}.`;
  }
  if (trace.fallback) return `Nobody eligible: ${trace.fallback.reason}. It went to ${fallbackWords(trace)}.`;
  return "It is waiting for an eligible approver.";
}

/** "Held because refunds over ₹10,000 need finance approval. Sam (finance, on duty) has it. You can't approve your own request." */
export function heldExplanation(trace: RouteTrace, holdSummary: string, askerId: string | null): string {
  const lines = [`Held because ${holdSummary}.`, holderSentence(trace)];
  if (askerId && trace.requesterIds.includes(askerId)) lines.push("You can't approve your own request.");
  return lines.join(" ");
}

function firstSentenceForYou(trace: RouteTrace, id: string): string {
  const entry = trace.ranked.find((ranked) => ranked.id === id);
  if (!entry) {
    return trace.fallback ? `no eligible approver, so it came to ${trace.fallback.group}.` : `${trace.label} approver.`;
  }
  if (entry.delegateFor) return `covering for ${entry.delegateFor}.`;
  if (entry.ownerOf && entry.rank !== "rota_on_duty") return `owner of ${entry.ownerOf}.`;
  if (entry.backup) return `backup ${trace.label} approver.`;
  if (entry.rank === "rota_on_duty") return `${trace.label} approver on duty.`;
  return `${trace.label} approver.`;
}

/** " Can't approve: Priya (requester, agent owner)." Empty when nobody was excluded. */
function cantApproveSentence(trace: RouteTrace): string {
  if (trace.excluded.length === 0) return "";
  const people = trace.excluded.map((entry) => `${entry.name} (${exclusionWords(entry.reasons, trace.label)})`);
  return ` Can't approve: ${people.join(", ")}.`;
}

/** The card's "Why you:" line. */
export function whyYou(trace: RouteTrace, id: string): string {
  return `${firstSentenceForYou(trace, id)}${cantApproveSentence(trace)}`;
}

/** A card's "Why you:" for the copy in the origin room, where nobody in particular is being asked. */
export function whyCopy(trace: RouteTrace): string {
  const labels = chosenLabels(trace);
  const holder = labels.length > 0 ? joinNames(labels) : trace.fallback ? fallbackWords(trace) : "an eligible approver";
  return `copy for this room; ${holder} decides.${cantApproveSentence(trace)}`;
}

/** A card's "Why here:" in the fallback room, where the group is being asked. */
export function whyFallback(trace: RouteTrace): string {
  const group = trace.fallback?.group ?? "this room";
  return `nobody else could take it, so it came to ${group}.${cantApproveSentence(trace)}`;
}

export type ExplainContext = {
  handle: string;
  tier: Tier;
  className: string;
  fired: { source: string; certain: boolean }[];
  extracted: Record<string, unknown>;
  currency: string;
  tz: string;
  escalation: { kind: "person" | "room"; name: string; atMs: number }[];
  expiresAtMs: number;
};

const COMPARISON = /^(\w+)\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/;

/** "₹40,000 > ₹10,000 → HIGH" when the first certain rule is a plain money comparison, else just "HIGH". */
function ruleWords(ctx: ExplainContext): string {
  const tier = ctx.tier.toUpperCase();
  for (const rule of ctx.fired) {
    if (!rule.certain) continue;
    const match = COMPARISON.exec(rule.source);
    if (!match) continue;
    const [, field = "", operator = "", limit = ""] = match;
    const value = toNumber(ctx.extracted[field]);
    if (value !== null && field === "amount") {
      return `${formatMoney(value, ctx.currency)} ${operator} ${formatMoney(Number(limit), ctx.currency)} → ${tier}`;
    }
  }
  return tier;
}

function rankedWords(trace: RouteTrace): string {
  return trace.ranked
    .map((entry) => {
      if (!trace.chosen.includes(entry.id)) return entry.backup ? `${entry.name} (backup)` : entry.name;
      const details: string[] = [];
      if (entry.rank === "rota_on_duty") details.push(`${entry.group} rota on duty`);
      if (entry.ownerOf) details.push(`owner of ${entry.ownerOf}`);
      if (entry.delegateFor) details.push(`covering for ${entry.delegateFor}`);
      if (entry.activeRoom !== undefined && entry.activeAgoMs !== undefined) {
        details.push(`active in ${entry.activeRoom} ${Math.round(entry.activeAgoMs / 60_000)} min ago`);
      }
      details.push(`${entry.openCards} open ${entry.openCards === 1 ? "card" : "cards"}`);
      return `${entry.name} (${details.join(", ")})`;
    })
    .join(", ");
}

/** The `@clearance why A12` answer, Appendix D's why-me trace. */
export function explainTrace(trace: RouteTrace, ctx: ExplainContext): string {
  const parts = [`${ctx.handle} → rule ${ctx.className} (${ruleWords(ctx)}).`];
  const names = trace.candidates.map((candidate) => candidate.name);
  if (names.length > 0) parts.push(`Candidates: ${names.join(", ")}.`);
  if (trace.excluded.length > 0) {
    const excluded = trace.excluded.map(
      (entry) => `${entry.name} (${entry.reasons.map((reason) => EXCLUSION_WORDS[reason]).join("; ")})`,
    );
    parts.push(`Excluded: ${excluded.join(", ")}.`);
  }
  if (trace.ranked.length > 0) parts.push(`Ranked: ${rankedWords(trace)}.`);
  if (trace.fallback) {
    if (trace.chosen.length === 0) parts.push(`Nobody eligible: ${trace.fallback.reason}.`);
    parts.push(`Fallback: ${fallbackWords(trace)}.`);
  }
  const expires = `expires ${formatClock(ctx.expiresAtMs, ctx.tz)}.`;
  if (ctx.escalation.length > 0) {
    const steps = ctx.escalation.map((step) => `${step.name} at ${formatClock(step.atMs, ctx.tz)}`);
    parts.push(`Escalates to ${steps.join(", ")}, ${expires}`);
  } else {
    parts.push(`No escalation, ${expires}`);
  }
  return parts.join(" ");
}

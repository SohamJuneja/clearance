/**
 * The router (F4), a pure function: same input, same trace. `route` picks people and returns the trace;
 * `assessAnswer` applies the same rules to one person when they answer; `why` text is written from the
 * trace alone (F13), so there is no second implementation of who can approve what.
 */
import type { Tier } from "@clearance/contracts";
import type { Directory, Person } from "../people/directory.js";
import type { CompiledClass, CompiledPolicy } from "../policy/load.js";
import type { TeamFile } from "../policy/schema.js";
import { withinSchedule } from "../time.js";
import { exclusionWords } from "./why.js";

export const ACTIVE_WINDOW_MS = 15 * 60_000;
const TIERS: Tier[] = ["low", "medium", "high", "critical"];

export type Exclusion = "requester" | "agent_owner" | "author" | "away" | "counted" | "failed_confirm";
export type Refusal = Exclusion | "not_approver";

export type Rank = "rota_on_duty" | "resource_owner" | "active_in_room" | "active_anywhere" | "other";
const RANK_ORDER: Rank[] = ["rota_on_duty", "resource_owner", "active_in_room", "active_anywhere", "other"];

export type RouteSignals = {
  openCards(userId: string): number;
  lastActive(userId: string): { room: string; atMs: number } | null;
  lastActiveIn(userId: string, room: string): number | null;
  away(userId: string): { untilMs: number; delegateTo: string | null } | null;
  /** Answering most of this class's requests today: a fatigue risk, so others are preferred (F10). */
  concentrated?(userId: string): boolean;
};

export type RouteContext = {
  requestId: string;
  policy: CompiledPolicy;
  directory: Directory;
  team: TeamFile;
  /** The class's rules. Null for a protected call with no rule, which goes straight to fallback. */
  cls: CompiledClass | null;
  className: string;
  tier: Tier;
  quorumRequired: number;
  requesterIds: string[];
  agentOwnerIds: string[];
  authorIds: string[];
  extracted: Record<string, unknown>;
  originRoom: string | null;
  nowMs: number;
  signals: RouteSignals;
  /** People whose approval already counts towards quorum. */
  counted: string[];
  /** People who typed the wrong value twice on this request. */
  failedConfirm?: string[];
  /** People who already hold an open card for this request. */
  alreadyRouted: string[];
  /** True once this request has gone to its fallback group. */
  fallbackActive: boolean;
};

export type RankedPerson = {
  id: string;
  name: string;
  rank: Rank;
  backup: boolean;
  /** "finance", the words used in "Sam (finance, on duty)". */
  group: string;
  openCards: number;
  concentrated: boolean;
  ownerOf?: string;
  delegateFor?: string;
  activeRoom?: string;
  activeAgoMs?: number;
};

export type RouteTrace = {
  requestId: string;
  className: string;
  tier: Tier;
  quorumRequired: number;
  label: string;
  rule: string[];
  candidates: { id: string; name: string; matchedBy: string | null }[];
  excluded: { id: string; name: string; reasons: Exclusion[] }[];
  ranked: RankedPerson[];
  capped: { id: string; name: string; openCards: number }[];
  chosen: string[];
  requesterIds: string[];
  fallback: { group: string; room: string; reason: string; eligible: string[] } | null;
};

function ownerExcluded(ctx: RouteContext): boolean {
  const from = ctx.cls?.approvers?.excludeAgentOwnerFrom ?? ctx.policy.defaults.exclude_agent_owner_from;
  if (from === "never") return false;
  return TIERS.indexOf(ctx.tier) >= TIERS.indexOf(from);
}

function exclusionsFor(ctx: RouteContext, id: string): Exclusion[] {
  const reasons: Exclusion[] = [];
  if (ctx.policy.defaults.exclude_requester && ctx.requesterIds.includes(id)) reasons.push("requester");
  if (ownerExcluded(ctx) && ctx.agentOwnerIds.includes(id)) reasons.push("agent_owner");
  if (ctx.authorIds.includes(id)) reasons.push("author");
  if (ctx.signals.away(id)) reasons.push("away");
  if (ctx.counted.includes(id)) reasons.push("counted");
  if (ctx.failedConfirm?.includes(id)) reasons.push("failed_confirm");
  return reasons;
}

function ruleMatch(ctx: RouteContext, person: Person): string | null {
  for (const ref of ctx.cls?.approvers?.anyOf ?? []) {
    if (ref.role && person.roles.includes(ref.role)) return `role:${ref.role}`;
    if (ref.group && person.groups.includes(ref.group)) return `group:${ref.group}`;
    if (ref.person === person.id) return `person:${person.id}`;
    if (ref.owner_of) {
      const resource = ctx.extracted[ref.owner_of];
      if (resource !== undefined && ctx.team.owners.services[String(resource)] === person.id) {
        return `owner_of:${ref.owner_of}`;
      }
    }
  }
  return null;
}

/** People the rule names, in rule order then team order, then delegates of anyone away among them. */
function candidatesFor(ctx: RouteContext): { person: Person; matchedBy: string }[] {
  const direct = ctx.directory
    .all()
    .map((person) => ({ person, matchedBy: ruleMatch(ctx, person) }))
    .filter((entry): entry is { person: Person; matchedBy: string } => entry.matchedBy !== null);
  const refs = (ctx.cls?.approvers?.anyOf ?? []).map((ref, index) => ({ ref, index }));
  const refIndex = (matchedBy: string) =>
    refs.findIndex(({ ref }) => matchedBy === `role:${ref.role}` || matchedBy === `group:${ref.group}` || matchedBy === `person:${ref.person}` || matchedBy === `owner_of:${ref.owner_of}`);
  direct.sort((a, b) => refIndex(a.matchedBy) - refIndex(b.matchedBy));
  const out = [...direct];
  for (const { person } of direct) {
    // Standing in for someone gives you what they had on this request. Someone who asked for it, or has already used
    // their approval, has nothing to hand on, or a requester could name who approves.
    if (exclusionsFor(ctx, person.id).some((reason) => reason !== "away")) continue;
    const delegate = ctx.signals.away(person.id)?.delegateTo;
    const target = delegate ? ctx.directory.person(delegate) : null;
    if (target && !out.some((entry) => entry.person.id === target.id)) {
      out.push({ person: target, matchedBy: `delegate:${person.id}` });
    }
  }
  return out;
}

function rotaStanding(ctx: RouteContext, id: string): { onDuty: boolean; backup: boolean } {
  let onDuty = false;
  let backup = false;
  const tz = ctx.policy.defaults.business_hours.tz;
  for (const ref of ctx.cls?.approvers?.anyOf ?? []) {
    if (!ref.role) continue;
    const entries = ctx.team.rotas[ref.role] ?? [];
    const mine = entries.find((entry) => entry.person === id);
    if (!mine) continue;
    const primaryOnDuty = entries.some(
      (entry) => !entry.backup && withinSchedule(entry, ctx.nowMs, tz) && !ctx.signals.away(entry.person),
    );
    if (mine.backup) {
      backup = true;
      if (!primaryOnDuty) onDuty = true;
    } else if (withinSchedule(mine, ctx.nowMs, tz)) {
      onDuty = true;
    }
  }
  return { onDuty, backup };
}

function rankPerson(ctx: RouteContext, person: Person, matchedBy: string): RankedPerson {
  const { onDuty, backup } = rotaStanding(ctx, person.id);
  const label = ctx.cls?.approvers?.label;
  const group = label && person.groups.includes(label) ? label : (person.groups[0] ?? label ?? "team");
  const entry: RankedPerson = {
    id: person.id,
    name: person.name,
    rank: "other",
    backup,
    group,
    openCards: ctx.signals.openCards(person.id),
    concentrated: ctx.signals.concentrated?.(person.id) ?? false,
  };
  if (matchedBy.startsWith("delegate:")) {
    // A person reads this on the card.
    const covered = matchedBy.slice("delegate:".length);
    entry.delegateFor = ctx.directory.person(covered)?.name ?? covered;
  }
  const ownerField = (ctx.cls?.approvers?.anyOf ?? []).find(
    (ref) =>
      ref.owner_of &&
      ctx.extracted[ref.owner_of] !== undefined &&
      ctx.team.owners.services[String(ctx.extracted[ref.owner_of])] === person.id,
  )?.owner_of;
  if (ownerField) entry.ownerOf = String(ctx.extracted[ownerField]);

  const last = ctx.signals.lastActive(person.id);
  if (last && ctx.nowMs - last.atMs <= ACTIVE_WINDOW_MS) {
    entry.activeRoom = ctx.directory.roomName(last.room);
    entry.activeAgoMs = ctx.nowMs - last.atMs;
  }
  const inRoom = ctx.originRoom ? ctx.signals.lastActiveIn(person.id, ctx.originRoom) : null;
  const activeInRoom = inRoom !== null && ctx.nowMs - inRoom <= ACTIVE_WINDOW_MS;

  if (onDuty) entry.rank = "rota_on_duty";
  else if (ownerField) entry.rank = "resource_owner";
  else if (activeInRoom) entry.rank = "active_in_room";
  else if (entry.activeRoom) entry.rank = "active_anywhere";
  return entry;
}

function describeRule(cls: CompiledClass | null): string[] {
  return (cls?.approvers?.anyOf ?? []).map((ref) => {
    if (ref.role) return `role:${ref.role}`;
    if (ref.group) return `group:${ref.group}`;
    if (ref.owner_of) return `owner_of:${ref.owner_of}`;
    return `person:${ref.person}`;
  });
}

function fallbackFor(ctx: RouteContext): { group: string; room: string } {
  return ctx.cls?.approvers?.fallback ?? ctx.policy.defaults.fallback;
}

function fallbackMembers(ctx: RouteContext, group: string): string[] {
  return ctx.directory
    .all()
    .filter((person) => person.groups.includes(group) && exclusionsFor(ctx, person.id).length === 0)
    .map((person) => person.id);
}

const SOD: Exclusion[] = ["requester", "agent_owner", "author"];

/** Why nobody could take it, separation of duties first: that is the reason a reader needs. */
function fallbackReason(trace: Pick<RouteTrace, "excluded" | "capped" | "label">): string {
  const isSod = (reasons: Exclusion[]) => reasons.some((reason) => SOD.includes(reason));
  const sorted = [...trace.excluded].sort((a, b) => Number(isSod(b.reasons)) - Number(isSod(a.reasons)));
  const parts = sorted.map((entry) => `${entry.name} (${exclusionWords(entry.reasons, trace.label)})`);
  for (const entry of trace.capped) parts.push(`${entry.name} (${entry.openCards} open cards)`);
  return parts.length > 0 ? parts.join("; ") : "the policy names no approver for this";
}

/** Pick `need` more people. Fewer than that available means the fallback group, and the trace says why. */
export function route(ctx: RouteContext, need: number): RouteTrace {
  const cap = ctx.policy.defaults.max_open_cards_per_person;
  const matched = candidatesFor(ctx);

  const candidates: RouteTrace["candidates"] = matched.map(({ person, matchedBy }) => ({
    id: person.id,
    name: person.name,
    matchedBy,
  }));
  const excluded: RouteTrace["excluded"] = [];
  const ranked: RankedPerson[] = [];
  const capped: RouteTrace["capped"] = [];
  const overCap: RankedPerson[] = [];

  for (const { person, matchedBy } of matched) {
    const reasons = exclusionsFor(ctx, person.id);
    if (reasons.length > 0) {
      excluded.push({ id: person.id, name: person.name, reasons });
      continue;
    }
    const entry = rankPerson(ctx, person, matchedBy);
    // The cap decides who's asked first, and never who may approve: being busy can't hand a decision to someone else,
    // or an agent could move one by filling people's cards.
    if (entry.openCards >= cap) {
      capped.push({ id: entry.id, name: entry.name, openCards: entry.openCards });
      overCap.push(entry);
    } else {
      ranked.push(entry);
    }
  }

  // Requesters and owners outside the rule still belong in the trace: they are the people asking why not.
  for (const id of new Set([...ctx.requesterIds, ...ctx.agentOwnerIds, ...ctx.authorIds])) {
    if (candidates.some((candidate) => candidate.id === id)) continue;
    const person = ctx.directory.person(id);
    const reasons = person ? exclusionsFor(ctx, id) : [];
    if (!person || reasons.length === 0) continue;
    candidates.push({ id, name: person.name, matchedBy: null });
    excluded.push({ id, name: person.name, reasons });
  }

  const byRank = (a: RankedPerson, b: RankedPerson) =>
    Number(a.concentrated) - Number(b.concentrated) ||
    RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank) ||
    a.openCards - b.openCards;
  ranked.sort(byRank);
  overCap.sort(byRank);

  const chosen = [...ranked, ...overCap]
    .filter((entry) => !ctx.alreadyRouted.includes(entry.id))
    .slice(0, Math.max(0, need))
    .map((entry) => entry.id);

  const label = ctx.cls?.approvers?.label ?? "approver";
  const partial = { excluded, capped, label };
  const fallback =
    chosen.length < need
      ? {
          ...fallbackFor(ctx),
          reason: fallbackReason(partial),
          eligible: fallbackMembers(ctx, fallbackFor(ctx).group),
        }
      : null;

  return {
    requestId: ctx.requestId,
    className: ctx.className,
    tier: ctx.tier,
    quorumRequired: ctx.quorumRequired,
    label,
    rule: describeRule(ctx.cls),
    candidates,
    excluded,
    ranked,
    capped,
    chosen,
    requesterIds: ctx.requesterIds,
    fallback,
  };
}

/** Re-checked on every answer, against live state. */
export function assessAnswer(ctx: RouteContext, personId: string): { eligible: boolean; reasons: Refusal[] } {
  const reasons: Refusal[] = exclusionsFor(ctx, personId);
  if (reasons.length > 0) return { eligible: false, reasons };
  const person = ctx.directory.person(personId);
  if (!person) return { eligible: false, reasons: ["not_approver"] };
  const named = candidatesFor(ctx).some((entry) => entry.person.id === personId);
  const viaFallback = ctx.fallbackActive && person.groups.includes(fallbackFor(ctx).group);
  return named || viaFallback ? { eligible: true, reasons: [] } : { eligible: false, reasons: ["not_approver"] };
}

/**
 * Promotion arithmetic and wording (F11). Pure: the evidence goes in, the verdict comes out, and the same numbers
 * feed the proposal card, `POST /v1/autonomy/simulate` and `pnpm eval:autonomy`. Nothing here can raise a level.
 */
import type { NewBucketEvent } from "./history.js";
import type { Level } from "./store.js";

export type Criteria = { approvals: number; days: number; minDistinctApprovers: number };

export const F11_CRITERIA: Criteria = { approvals: 20, days: 7, minDistinctApprovers: 2 };

export type BucketStats = {
  /** Everything decided in this range, whoever or whatever decided it. */
  requests: number;
  /** Approved by a person as it was asked for, not fast. This is the evidence. */
  counted: number;
  /** Approved by a person in less time than the card takes to read. Not evidence. */
  fastExcluded: number;
  denied: number;
  incidents: number;
  edited: number;
  /** Who gave the counted approvals. */
  approvers: string[];
  /** Replay: what the rule would have run by itself, out of what people decided. */
  wouldAuto: number;
  wouldAutoApproved: number;
  wouldAutoDenied: number;
};

export function bucketStats(events: NewBucketEvent[]): BucketStats {
  const judged = events.filter((event) => event.outcome !== "auto");
  // An approval with edits says the agent asked for the wrong thing, so it can't also count for trusting it more.
  const careful = judged.filter((event) => event.outcome === "approved" && !event.fast && !event.edited);
  const replayed = judged.filter((event) => event.autoEligible);
  return {
    requests: events.length,
    counted: careful.length,
    fastExcluded: judged.filter((event) => event.outcome === "approved" && event.fast).length,
    denied: judged.filter((event) => event.outcome === "denied").length,
    incidents: events.filter((event) => event.incident).length,
    edited: events.filter((event) => event.edited).length,
    approvers: [...new Set(careful.flatMap((event) => event.approvers))],
    wouldAuto: replayed.length,
    wouldAutoApproved: replayed.filter((event) => event.outcome === "approved" && !event.edited).length,
    wouldAutoDenied: replayed.filter((event) => event.outcome === "denied").length,
  };
}

/** F11: at least 20 approved, 0 denials, 0 incidents, 0 approved-with-edits, at least 2 approvers, none of it fast. */
export function meetsPromotion(stats: BucketStats, criteria: Criteria): boolean {
  return (
    stats.counted >= criteria.approvals &&
    stats.denied === 0 &&
    stats.incidents === 0 &&
    stats.edited === 0 &&
    stats.approvers.length >= criteria.minDistinctApprovers
  );
}

const ORDER: Level[] = ["L0", "L1", "L2", "L3"];

/** L0 and L1 go to L2 when the policy allows it, else to its cap. L2 goes to L3. Null when there's nowhere to go. */
export function proposedLevel(current: Level, max: Level): Level | null {
  const wanted: Level = current === "L2" || current === "L3" ? "L3" : "L2";
  const target: Level = ORDER.indexOf(wanted) <= ORDER.indexOf(max) ? wanted : max;
  return ORDER.indexOf(target) > ORDER.indexOf(current) ? target : null;
}

const MIN_SAMPLES = 20;

/** Nearest rank. Below 20 samples there is no telling what's normal, so there is no ceiling. */
export function percentile95(values: number[]): number | null {
  if (values.length < MIN_SAMPLES) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1] as number;
}

const NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five"];

function promise(agent: string, label: string, level: Level): string {
  switch (level) {
    case "L1":
      return `${agent} may use the fast lane for ${label} (level L1, one approver and no typing)`;
    case "L3":
      return `${agent} may auto-approve ${label} (level L3, silently, up to a daily cap)`;
    default:
      return `${agent} may auto-approve ${label} (level L2, with a review card)`;
  }
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export type PromotionWords = {
  agent: string;
  label: string;
  level: Level;
  days: number;
  stats: BucketStats;
  synthetic: boolean;
  quorum: number;
};

/** Appendix D. Switch writes the handle and its own answer line into the post, so the copy has neither. */
export function promotionDetail(input: PromotionWords): string {
  const { stats } = input;
  const range = `Last ${input.days} days in this range${input.synthetic ? " (synthetic history)" : ""}`;
  const leftOut = stats.fastExcluded > 0 ? ` (${stats.fastExcluded} left out)` : "";
  const people = plural(stats.approvers.length, "different person", "different people");
  const needed = `${NUMBER_WORDS[input.quorum] ?? input.quorum} approvals needed.`;
  return [
    `Proposal: ${promise(input.agent, input.label, input.level)}.`,
    `${range}: ${plural(stats.requests, "request")}, ${stats.counted} approved by ${people}, ${stats.denied} denied, ${plural(stats.incidents, "incident")}, 0 fast approvals counted${leftOut}.`,
    `Replay: this rule would have auto-approved ${stats.wouldAuto}, all of which people approved; ${stats.wouldAutoDenied} would have auto-approved a denied request.`,
    needed,
  ].join("\n\n");
}

export function promotedText(agent: string, label: string, level: Level, signedBy: string): string {
  return `${promise(agent, label, level).replace(" may ", " may now ")}. Signed by ${signedBy}.`;
}

export function demotionText(agent: string, label: string, because: string): string {
  return `${agent} is back to 'always ask' for ${label} because ${because}.`;
}

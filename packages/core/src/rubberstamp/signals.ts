/**
 * Rubber-stamp signals (F10), each a pure function of what already happened. A flagged approval is still valid:
 * the response is more friction next time and no credit towards autonomy, never blocking a correct human.
 */
import type { Flag, Tier } from "@clearance/contracts";
import type { PolicyFile } from "../policy/schema.js";

export type StampConfig = {
  baseS: number;
  perLineS: number;
  tierBonusS: Record<string, number>;
  streakApprovals: number;
  streakMaxDenials: number;
  batchApprovals: number;
  batchWithinS: number;
  concentrationShare: number;
  /** One answer is 100% of a class, and means nothing. Below this many, nobody is concentrated. */
  concentrationMinAnswers: number;
};

export const DEFAULT_STAMP_CONFIG: StampConfig = {
  baseS: 2,
  perLineS: 0.25,
  tierBonusS: { high: 3, critical: 6 },
  streakApprovals: 5,
  streakMaxDenials: 0,
  batchApprovals: 3,
  batchWithinS: 20,
  concentrationShare: 0.6,
  concentrationMinAnswers: 5,
};

export function stampConfig(policy: PolicyFile["rubber_stamp"]): StampConfig {
  if (!policy) return DEFAULT_STAMP_CONFIG;
  return {
    baseS: policy.t_min.base_s,
    perLineS: policy.t_min.per_evidence_line_s,
    tierBonusS: policy.t_min.tier_bonus_s,
    streakApprovals: policy.streak.approvals,
    streakMaxDenials: policy.streak.max_denials,
    batchApprovals: policy.batch?.approvals ?? DEFAULT_STAMP_CONFIG.batchApprovals,
    batchWithinS: policy.batch?.within_s ?? DEFAULT_STAMP_CONFIG.batchWithinS,
    concentrationShare: policy.concentration?.share ?? DEFAULT_STAMP_CONFIG.concentrationShare,
    concentrationMinAnswers: policy.concentration?.min_answers ?? DEFAULT_STAMP_CONFIG.concentrationMinAnswers,
  };
}

/** What a careful reader has to take in. */
export function evidenceLines(description: { call: string[]; context: string[] }, flags: Flag[]): number {
  return description.call.length + description.context.length + flags.length;
}

/** `t_min = 2 s + 0.25 s x evidence lines + tier bonus`. */
export function tMinMs(lines: number, tier: Tier, config: StampConfig): number {
  return Math.round((config.baseS + config.perLineS * lines + (config.tierBonusS[tier] ?? 0)) * 1000);
}

export type PastAnswer = { decision: string; latencyMs: number; tMinMs: number; atMs: number };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Newest first. The last N answers, all approvals, with a median time under the median floor. */
export function isStreak(answers: PastAnswer[], config: StampConfig): boolean {
  const last = answers.slice(0, config.streakApprovals);
  if (last.length < config.streakApprovals) return false;
  if (last.filter((answer) => answer.decision !== "approve").length > config.streakMaxDenials) return false;
  return median(last.map((answer) => answer.latencyMs)) < median(last.map((answer) => answer.tMinMs));
}

export function isBatch(approvalTimes: number[], nowMs: number, config: StampConfig): boolean {
  const since = nowMs - config.batchWithinS * 1000;
  return approvalTimes.filter((at) => at >= since && at <= nowMs).length >= config.batchApprovals;
}

const FLAGS_WORTH_STOPPING_FOR = new Set(["mismatch", "new_destination"]);

export function ignoredFlags(flags: Flag[]): string[] {
  return flags.map((flag) => flag.code).filter((code) => FLAGS_WORTH_STOPPING_FOR.has(code));
}

/** `answerers` is who answered this class's requests today, one entry per answer. */
export function isConcentrated(answerers: string[], person: string, config: StampConfig): boolean {
  if (answerers.length < config.concentrationMinAnswers) return false;
  return answerers.filter((id) => id === person).length / answerers.length > config.concentrationShare;
}

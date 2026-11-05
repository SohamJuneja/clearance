/**
 * E5 analysis (PLAN 11.7): turns the event logs from either platform (the Approval Lab, or real Switch
 * cards) into per-person metrics, per-condition summaries and paired differences. Pure, so it can be
 * tested on synthetic events. Differences are within a person, so people from both platforms can be
 * pooled; `participants.by_platform` and each person's `platform` say who used which (PLAN 11.5).
 *
 * Paired differences are always Clearance minus Switch (B minus A), and only people who finished both
 * blocks are in them. Everyone who started is still counted, and incomplete sessions are listed
 * separately (PLAN 11.4).
 */
import { NOT_APPROVED, type DecisionEvent, type StudyEvent } from "../../study/lib/events";
import { bootstrapMeanCi, mean, median, spread, wilcoxonSignedRank, type BootstrapCi, type Spread, type Wilcoxon } from "./stats";

/** PLAN 11.7: "Wilcoxon signed-rank p-values if n ≥ 10". */
export const WILCOXON_MIN_N = 10;

const CARDS_PER_BLOCK = 12;
type Condition = "A" | "B";
const CONDITION_NAMES = { A: "Switch default card", B: "Clearance card" } as const;

export type ConditionMetrics = {
  catch_rate: number | null;
  caught: number;
  flawed: number;
  false_deny_rate: number | null;
  false_denies: number;
  legit: number;
  median_s_legit: number | null;
  median_s_flawed: number | null;
  confidence: number | null;
  /** Second wrong type-to-confirm value. Counted as not approved in both rates above. */
  confirm_failed: number;
  /** Cards on screen while the page was hidden. Their times are kept, medians absorb them. */
  interrupted: number;
};

export type ParticipantMetrics = { participant: string; group: number | null; platform: string | null; role: string | null; familiarity: number | null; A: ConditionMetrics; B: ConditionMetrics };

const METRICS = ["catch_rate", "false_deny_rate", "median_s_legit", "median_s_flawed", "confidence"] as const;
type MetricName = (typeof METRICS)[number];

export type PairedDifference = {
  metric: MetricName;
  /** B minus A for each person. */
  per_person: { participant: string; difference: number }[];
  n: number;
  mean: number | null;
  median: number | null;
  ci95: BootstrapCi | null;
  wilcoxon: Wilcoxon | null;
  wilcoxon_note: string | null;
};

export type StudyReport = {
  experiment: "E5 human study";
  label: string;
  synthetic: boolean;
  generated_at: string;
  conditions: typeof CONDITION_NAMES;
  participants: { started: number; completed: number; incomplete: string[]; stopped: string[]; by_platform: Record<string, number> };
  per_participant: ParticipantMetrics[];
  by_condition: Record<Condition, Record<MetricName, Spread>>;
  paired_differences: Record<MetricName, PairedDifference>;
  /** Pooled over completed sessions. Context-only flaws are not on the Switch card; read them separately. */
  by_flaw_type: Record<Condition, Record<string, { caught: number; total: number; rate: number | null; evidence_in_a: string | null }>>;
  /** Exploratory (PLAN 11.7). The Lab shows no feedback inside a block, so this is not a drill-feedback effect. */
  exploratory_b_catch_by_half: { first_half: { caught: number; total: number }; second_half: { caught: number; total: number }; note: string };
  /** Values for the RESULTS.md table. Null unless these are real results from at least one person. */
  headline: {
    n: number;
    catch_rate: Record<Condition, number | null>;
    false_deny_rate: Record<Condition, number | null>;
    median_s_legit: Record<Condition, number | null>;
    median_s_flawed: Record<Condition, number | null>;
  } | null;
};

const seconds = (ms: number) => ms / 1000;

function metricsFor(decisions: DecisionEvent[], confidence: number | null): ConditionMetrics {
  const flawed = decisions.filter((d) => d.kind === "flawed");
  const legit = decisions.filter((d) => d.kind === "legit");
  const caught = flawed.filter((d) => NOT_APPROVED.has(d.decision)).length;
  const falseDenies = legit.filter((d) => NOT_APPROVED.has(d.decision)).length;
  return {
    catch_rate: flawed.length === 0 ? null : caught / flawed.length,
    caught,
    flawed: flawed.length,
    false_deny_rate: legit.length === 0 ? null : falseDenies / legit.length,
    false_denies: falseDenies,
    legit: legit.length,
    median_s_legit: median(legit.map((d) => seconds(d.ms))),
    median_s_flawed: median(flawed.map((d) => seconds(d.ms))),
    confidence,
    confirm_failed: decisions.filter((d) => d.decision === "confirm_failed").length,
    interrupted: decisions.filter((d) => d.interrupted).length,
  };
}

function isComplete(events: StudyEvent[]): boolean {
  const decisions = events.filter((e) => e.type === "decision") as DecisionEvent[];
  return (
    events.some((e) => e.type === "session_end") &&
    decisions.filter((d) => d.condition === "A").length === CARDS_PER_BLOCK &&
    decisions.filter((d) => d.condition === "B").length === CARDS_PER_BLOCK
  );
}

function participantMetrics(participant: string, events: StudyEvent[]): ParticipantMetrics {
  const decisions = events.filter((e) => e.type === "decision") as DecisionEvent[];
  const start = events.find((e) => e.type === "session_start");
  const consent = events.find((e) => e.type === "consent");
  const confidenceFor = (condition: Condition): number | null => {
    const block = decisions.find((d) => d.condition === condition)?.block;
    const rating = events.find((e) => e.type === "confidence" && e.block === block);
    return rating?.type === "confidence" ? rating.value : null;
  };
  const metrics = (condition: Condition) => metricsFor(decisions.filter((d) => d.condition === condition), confidenceFor(condition));
  return {
    participant,
    group: start?.type === "session_start" ? start.group : null,
    platform: start?.type === "session_start" ? start.platform : null,
    role: consent?.type === "consent" ? consent.role : null,
    familiarity: consent?.type === "consent" ? consent.familiarity : null,
    A: metrics("A"),
    B: metrics("B"),
  };
}

function pairedDifference(metric: MetricName, people: ParticipantMetrics[]): PairedDifference {
  const perPerson = people.flatMap((person) => {
    const a = person.A[metric];
    const b = person.B[metric];
    return a === null || b === null ? [] : [{ participant: person.participant, difference: b - a }];
  });
  const differences = perPerson.map((entry) => entry.difference);
  const enough = differences.length >= WILCOXON_MIN_N;
  return {
    metric,
    per_person: perPerson,
    n: differences.length,
    mean: mean(differences),
    median: median(differences),
    ci95: bootstrapMeanCi(differences),
    wilcoxon: enough ? wilcoxonSignedRank(differences) : null,
    wilcoxon_note: enough ? null : `not computed: n = ${differences.length}, the plan asks for n >= ${WILCOXON_MIN_N}`,
  };
}

export function analyse(events: StudyEvent[], generatedAt: string): StudyReport {
  const byParticipant = new Map<string, StudyEvent[]>();
  for (const event of events) byParticipant.set(event.participant, [...(byParticipant.get(event.participant) ?? []), event]);

  const started = [...byParticipant.keys()].filter((id) => byParticipant.get(id)!.some((e) => e.type === "session_start")).sort();
  const completedIds = started.filter((id) => isComplete(byParticipant.get(id)!));
  const stopped = started.filter((id) => byParticipant.get(id)!.some((e) => e.type === "stopped"));
  const incomplete = started.filter((id) => !completedIds.includes(id));

  const byPlatform: Record<string, number> = {};
  for (const id of started) {
    const start = byParticipant.get(id)!.find((e) => e.type === "session_start");
    if (start?.type === "session_start") byPlatform[start.platform] = (byPlatform[start.platform] ?? 0) + 1;
  }

  const completed = completedIds.map((id) => participantMetrics(id, byParticipant.get(id)!));
  const synthetic = events.some((e) => e.synthetic === true);

  const summarise = (condition: Condition) =>
    Object.fromEntries(METRICS.map((metric) => [metric, spread(completed.flatMap((person) => (person[condition][metric] === null ? [] : [person[condition][metric]!])))])) as Record<MetricName, Spread>;

  const completedDecisions = completedIds.flatMap((id) => byParticipant.get(id)!.filter((e) => e.type === "decision") as DecisionEvent[]);

  const flawTable = (condition: Condition) => {
    const table: StudyReport["by_flaw_type"][Condition] = {};
    for (const decision of completedDecisions) {
      if (decision.condition !== condition || decision.flaw_type === null) continue;
      const row = (table[decision.flaw_type] ??= { caught: 0, total: 0, rate: null, evidence_in_a: decision.evidence_in_a });
      row.total += 1;
      if (NOT_APPROVED.has(decision.decision)) row.caught += 1;
      row.rate = row.caught / row.total;
    }
    return table;
  };

  const halfOf = (half: "first" | "second") => {
    const flawed = completedDecisions.filter((d) => d.condition === "B" && d.kind === "flawed" && (half === "first" ? d.position <= 6 : d.position > 6));
    return { caught: flawed.filter((d) => NOT_APPROVED.has(d.decision)).length, total: flawed.length };
  };

  const byCondition = { A: summarise("A"), B: summarise("B") };
  const n = completed.length;
  const headlineFor = (metric: MetricName) => ({ A: byCondition.A[metric].median, B: byCondition.B[metric].median });

  return {
    experiment: "E5 human study",
    label: synthetic
      ? `SYNTHETIC DATA, n = ${n}. Not a result. No number here may be reported.`
      : `Pilot study, n = ${n}. No claims beyond it. Condition B adds context fields that condition A does not have: this measures the whole card, not layout alone.`,
    synthetic,
    generated_at: generatedAt,
    conditions: CONDITION_NAMES,
    participants: { started: started.length, completed: n, incomplete, stopped, by_platform: byPlatform },
    per_participant: completed,
    by_condition: byCondition,
    paired_differences: Object.fromEntries(METRICS.map((metric) => [metric, pairedDifference(metric, completed)])) as Record<MetricName, PairedDifference>,
    by_flaw_type: { A: flawTable("A"), B: flawTable("B") },
    exploratory_b_catch_by_half: {
      first_half: halfOf("first"),
      second_half: halfOf("second"),
      note: "Exploratory. The Lab gives no feedback inside a block, so any difference is order or fatigue, not an effect of drill-style feedback.",
    },
    headline:
      synthetic || n === 0
        ? null
        : {
            n,
            catch_rate: headlineFor("catch_rate"),
            false_deny_rate: headlineFor("false_deny_rate"),
            median_s_legit: headlineFor("median_s_legit"),
            median_s_flawed: headlineFor("median_s_flawed"),
          },
  };
}

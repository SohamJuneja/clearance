/** What the Desk's server hands its page. Types only, so the browser bundle carries none of the server. */

export type Tier = "low" | "medium" | "high" | "critical";

export type Meta = { synthetic: boolean };

/** Core's health, less its open count: while a drill holds the Queue still, a live count would point at it. */
export type Health = { ok: boolean; policy_hash: string; mode?: string | undefined; policy_error: string | null };

export type Flag = { code: string; text: string };

export type QueueItem = {
  id: string;
  state: string;
  class: string;
  tier: Tier;
  score: number;
  headline: string;
  agent: string;
  vendor: string;
  asked_by: string[];
  flags: Flag[];
  quorum_required: number;
  approvals: number;
  created_at: string;
  expires_at: string;
  /** The room the request came from, by name when core knows it. */
  room: string | null;
  /** Who holds an open card for it, from each person's inbox. */
  waiting_on: { person: string; handle: string | null }[];
  /** Set when nobody eligible could be chosen and it went to a group. */
  fallback: { group: string; room: string; reason: string } | null;
  /** Ladder steps fired so far, of how many the policy gives this class. */
  escalation: { fired: number; of: number | null; last: string | null };
};

export type QueueView = { open_count: number; requests: QueueItem[] };

export type LedgerEntry = {
  seq: number;
  at: string;
  type: string;
  request_id: string | null;
  payload: Record<string, unknown>;
  prev_hash: string;
  entry_hash: string;
};

export type LedgerView = {
  entries: LedgerEntry[];
  /** Person ids to names, because ledger payloads hold ids and the page names people. */
  names: Record<string, string>;
};

/**
 * Core's check of the whole chain, drills included, reported at the newest entry the team can read. Core's own count
 * and head move with every entry, so they would show entries being held back.
 */
export type LedgerVerification = { ok: boolean; through_seq: number | null; head: string | null; firstBad?: { seq: number; reason: string } | undefined };

export type CoverageRow = { vendor: string; source: string; calls: number; allowed: number; held: number; denied: number; last_at: string | null };

export type CoverageView = { vendors: CoverageRow[] };

export type AutonomyLevel = { agent: string; class: string; bucket: string; level: string; since: number };

/** What the proposed rule would have done over recorded history. Reads only. */
export type BucketReplay = {
  agent: string;
  class: string;
  bucket: string;
  label: string;
  level: string;
  max_level: string;
  proposed_level: string | null;
  window_days: number;
  requests: number;
  counted: number;
  fast_excluded: number;
  denied: number;
  incidents: number;
  approvers: number;
  would_auto: number;
  would_auto_approved: number;
  would_auto_denied: number;
  meets_criteria: boolean;
  needs: { approvals: number; min_distinct_approvers: number };
  synthetic_events: number;
  real_events: number;
};

export type AutonomyProposal = {
  id: string;
  state: string;
  quorum: number;
  signed_by: string[];
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  title: string;
  detail: string;
};

export type HumanLoad = {
  agent_actions: number;
  governed_actions: number;
  human_decisions: number;
  per_100: number | null;
  per_100_governed: number | null;
  by_class: { class: string; agent_actions: number; human_decisions: number; per_100: number | null }[];
};

export type AutonomyView = {
  levels: AutonomyLevel[];
  proposals: AutonomyProposal[];
  buckets: BucketReplay[];
  /** How much of the recorded evidence is real, and how much is the labelled seeded history. */
  evidence: { synthetic: number; real: number };
  human_load: HumanLoad;
  history: LedgerEntry[];
  names: Record<string, string>;
};

/** Finished drills only. How many were sent would show one still open, so the Desk does not read that number. */
export type PersonDrills = { caught: number; missed: number; expired: number; catch_rate: number | null };

/** One person's own record, less `open_cards`, which counts an open drill's card. */
export type PersonStats = {
  user: string;
  answers: number;
  approvals: number;
  denials: number;
  ineligible: number;
  median_latency_ms: number | null;
  by_tier: Record<string, { answers: number; median_latency_ms: number | null }>;
  fast_approvals: number;
  flags_ignored: number;
  batch_approvals: number;
  streaks: number;
  signals: Record<string, number>;
  friction: string | null;
  drills: PersonDrills;
};

export type Away = { until: string; delegate_to: string | null };

/** What the whole team may see of a person: who they are, and whether they are away. */
export type PersonRow = { id: string; name: string; groups: string[]; roles: string[]; away: Away | null };

/** Drill results in whole groups of `group`. Zero until the first group has finished. */
export type TeamDrills = { finished: number; caught: number; missed: number; expired: number; group: number };

/** Sums over everyone. Per F9 and F10 this is all the team view gets: nobody's own record. */
export type TeamTotals = {
  answers: number;
  approvals: number;
  denials: number;
  fast_approvals: number;
  flags_ignored: number;
  batch_approvals: number;
  streaks: number;
  drills: TeamDrills;
};

export type PeopleView = { people: PersonRow[]; team: TeamTotals };

/** One person's record, for the admin's view. A separate route, so the team view never has it to leak. */
export type PersonDetail = PersonRow & { stats: PersonStats };

/** One class in F23's report. A null amount is one nobody could read, or a class that has none. It is never zero rupees. */
export type RoiClassMoney = {
  class: string;
  has_amount: boolean;
  held_requests: number;
  held_amount: number | null;
  held_unreadable: number;
  denied_requests: number;
  denied_amount: number | null;
  denied_unreadable: number;
  rule_denied: number;
};

/**
 * F23: what the approval layer did in the last 7 days, as core's report has it. What a room may read and no more: team
 * totals, no names, no time of day. A null section couldn't be computed, and a null figure inside one has too little behind it.
 */
export type RoiView = {
  from: string;
  to: string;
  days: number;
  currency: string;
  chain_ok: boolean;
  money: { by_class: RoiClassMoney[]; edited: number } | null;
  ran_alone: { tool_calls: number; risky_outside_autonomy: number | null; shadow_would_hold: number; under_autonomy: number | null; outcome_unknown: number } | null;
  load: { agent_actions: number; human_decisions: number; per_100: number | null; tool_calls: number; no_card: number; no_card_share: number | null } | null;
  speed: { closed: number; median_seconds: number | null; escalated: number | null; expired: number | null } | null;
  drills: (TeamDrills & { catch_rate_percent: number | null }) | null;
  synthetic: { history_rows: number; runs_on_history: number } | null;
};

export type PolicyClass = {
  name: string;
  base: number | null;
  rules: number;
  approvers: string | null;
  quorum: string;
  reversible: boolean | null;
  escalation_steps: number;
  max_level: string | null;
  decision: string | null;
};

/**
 * How the file on disk relates to what core enforces. Only `same` means they match, and none of these is an alarm:
 * - `signed`: a change was signed through the API. Core keeps it, and it does not write the file back.
 * - `file_pending`: the file was edited, and that edit is waiting for signatures.
 * - `differs`: they differ and core gives no reason yet, as when an edit has not been picked up.
 * - `no_file`: the Desk cannot read the file to compare.
 */
export type PolicyRelation = "same" | "signed" | "file_pending" | "differs" | "no_file";

export type PolicyView = {
  core_hash: string;
  file_hash: string | null;
  relation: PolicyRelation;
  /** Who signed the version in force, when it came through a signed change. */
  signed_by: string[];
  policy_error: string | null;
  mode: string | null;
  shadow_would_hold: number;
  pending: { proposal: string; hash: string; signed_by: string[]; quorum: number; detail: string } | null;
  tiers: { name: string; from: number; to: number }[];
  classes: PolicyClass[];
  text: string;
};

export type SimulationResult = {
  decision: string;
  reason: string;
  class?: string | null | undefined;
  tier?: string | null | undefined;
  score?: number | null | undefined;
  flags?: Flag[] | undefined;
  step?: string | null | undefined;
};

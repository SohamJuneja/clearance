/**
 * Core's responses, checked where they enter the Desk. A shape the Desk does not understand becomes a
 * visible error on the page, never a wrong number. Only fields the Desk reads are required, so core can
 * add to a response without breaking it.
 */
import { z } from "zod";

export const HealthSchema = z.object({
  ok: z.boolean(),
  policy_hash: z.string(),
  mode: z.string().optional(),
  policy_error: z.string().nullable(),
});

const FlagSchema = z.object({ code: z.string(), text: z.string() });

export const RequestDetailSchema = z.object({
  id: z.string(),
  state: z.string(),
  class: z.string(),
  tier: z.enum(["low", "medium", "high", "critical"]),
  score: z.number(),
  agent: z.string(),
  vendor: z.string(),
  requester_ids: z.array(z.string()),
  origin_room: z.string().nullable(),
  flags: z.array(FlagSchema),
  evidence: z.object({ description: z.object({ headline: z.string() }).optional() }).passthrough(),
  quorum_required: z.number().int(),
  approvals: z.array(z.string()),
  created_at: z.string(),
  expires_at: z.string(),
});

export const OpenRequestsSchema = z.object({ requests: z.array(RequestDetailSchema) });

/** Core adds `is_drill` only once a request has closed: while it is open, a drill looks like anything else. */
export const ClosedMarkSchema = z.object({ is_drill: z.boolean().optional() });

export const RosterSchema = z.object({
  people: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      groups: z.array(z.string()),
      roles: z.array(z.string()),
      away: z.object({ until: z.string(), delegate_to: z.string().nullable() }).nullable(),
    }),
  ),
});
export type Roster = z.infer<typeof RosterSchema>;

export const InboxSchema = z.object({
  user: z.string(),
  count: z.number().int().min(0),
  items: z.array(
    z.object({
      request_id: z.string(),
      handle: z.string().nullable(),
      class: z.string(),
      tier: z.string(),
      what: z.string(),
      room: z.string().nullable(),
      age_s: z.number(),
      expires_at: z.string(),
    }),
  ),
});

const LedgerEntrySchema = z.object({
  seq: z.number().int(),
  at: z.string(),
  type: z.string(),
  request_id: z.string().nullable(),
  payload: z.record(z.unknown()),
  prev_hash: z.string(),
  entry_hash: z.string(),
});

export const LedgerSchema = z.object({ entries: z.array(LedgerEntrySchema) });

export const VerifySchema = z.object({
  ok: z.boolean(),
  count: z.number().int().min(0),
  head: z.string(),
  firstBad: z.object({ seq: z.number().int(), reason: z.string() }).optional(),
});

export const CoverageSchema = z.object({
  vendors: z.array(
    z.object({
      vendor: z.string(),
      source: z.string(),
      calls: z.number().int(),
      allowed: z.number().int().nullable().transform((value) => value ?? 0),
      held: z.number().int().nullable().transform((value) => value ?? 0),
      denied: z.number().int().nullable().transform((value) => value ?? 0),
      last_at: z.string().nullable(),
    }),
  ),
});

const BucketReplaySchema = z.object({
  agent: z.string(),
  class: z.string(),
  bucket: z.string(),
  label: z.string(),
  level: z.string(),
  max_level: z.string(),
  proposed_level: z.string().nullable(),
  window_days: z.number(),
  requests: z.number().int(),
  counted: z.number().int(),
  fast_excluded: z.number().int(),
  denied: z.number().int(),
  incidents: z.number().int(),
  approvers: z.array(z.string()).transform((list) => list.length),
  would_auto: z.number().int(),
  would_auto_approved: z.number().int(),
  would_auto_denied: z.number().int(),
  meets_criteria: z.boolean(),
  needs: z.object({ approvals: z.number().int(), min_distinct_approvers: z.number().int() }),
  synthetic_events: z.number().int(),
  real_events: z.number().int(),
});

export const AutonomySchema = z.object({
  levels: z.array(z.object({ agent: z.string(), class: z.string(), bucket: z.string(), level: z.string(), since: z.number() })),
  proposals: z.array(
    z
      .object({
        id: z.string(),
        state: z.string(),
        quorum: z.number().int(),
        signed_by: z.array(z.string()),
        created_at: z.string(),
        expires_at: z.string(),
        decided_at: z.string().nullable(),
        title: z.string(),
        detail: z.string(),
      })
      .passthrough(),
  ),
  history: z.object({ synthetic: z.number().int(), real: z.number().int() }),
  buckets: z.array(BucketReplaySchema),
});

export const ReplaySchema = z.object({ replays: z.array(BucketReplaySchema) });

/** All the Desk will forward to a replay. */
export const ReplayScopeSchema = z.object({ agent: z.string().max(200).optional(), class: z.string().max(200).optional(), bucket: z.string().max(200).optional() }).strict();

export const HumanLoadSchema = z.object({
  agent_actions: z.number().int(),
  governed_actions: z.number().int(),
  human_decisions: z.number().int(),
  per_100: z.number().nullable(),
  per_100_governed: z.number().nullable(),
  by_class: z.array(z.object({ class: z.string(), agent_actions: z.number().int(), human_decisions: z.number().int(), per_100: z.number().nullable() })),
});

/** Reads only what is safe to hold: `open_cards` and `drills.sent` both count a drill still open, so they stop here. */
export const PersonStatsSchema = z.object({
  user: z.string(),
  answers: z.number().int(),
  approvals: z.number().int(),
  denials: z.number().int(),
  ineligible: z.number().int(),
  median_latency_ms: z.number().nullable(),
  by_tier: z.record(z.string(), z.object({ answers: z.number().int(), median_latency_ms: z.number().nullable() })),
  fast_approvals: z.number().int(),
  flags_ignored: z.number().int(),
  batch_approvals: z.number().int(),
  streaks: z.number().int(),
  signals: z.record(z.string(), z.number().int()),
  friction: z.string().nullable(),
  drills: z.object({ caught: z.number().int(), missed: z.number().int(), expired: z.number().int(), catch_rate: z.number().nullable() }),
});

export const PolicyInfoSchema = z.object({
  hash: z.string(),
  mode: z.string().optional(),
  error: z.string().nullable(),
  text: z.string(),
  shadow_would_hold: z.number().int(),
  pending: z
    .object({
      proposal: z.string(),
      hash: z.string(),
      signed_by: z.array(z.string()),
      quorum: z.number().int(),
      detail: z.string(),
    })
    .nullable(),
});

export const SimulationSchema = z
  .object({
    decision: z.string(),
    reason: z.string(),
    class: z.string().nullish(),
    tier: z.string().nullish(),
    score: z.number().nullish(),
    flags: z.array(FlagSchema).optional(),
    step: z.string().nullish(),
  })
  .passthrough();

/** What the Desk still needs from team.yaml: core reports a gate call's vendor as "gate", not the agent's own. */
export const TeamFileSchema = z.object({
  agents: z.record(z.object({ vendor: z.string().optional() }).passthrough()).default({}),
});

/** The parts of a policy the Policy tab renders. */
export const PolicyFileSchema = z.object({
  mode: z.string().optional(),
  tiers: z.record(z.tuple([z.number(), z.number()])),
  classes: z.record(
    z
      .object({
        decision: z.string().optional(),
        risk: z.object({ base: z.number(), add: z.array(z.unknown()).optional() }).optional(),
        reversible: z.boolean().optional(),
        approvers: z.object({ label: z.string().optional(), quorum: z.record(z.number()).optional() }).passthrough().optional(),
        escalate: z.array(z.unknown()).optional(),
        autonomy: z.object({ max_level: z.string().optional() }).passthrough().optional(),
      })
      .passthrough(),
  ),
});
export type PolicyFile = z.infer<typeof PolicyFileSchema>;

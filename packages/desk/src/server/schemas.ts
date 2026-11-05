/**
 * Core's responses, checked where they enter the Desk. A shape the Desk does not understand becomes a
 * visible error on the page, never a wrong number. Only fields the Desk reads are required, so core can
 * add to a response without breaking it.
 */
import { z } from "zod";

export const HealthSchema = z.object({
  ok: z.boolean(),
  policy_hash: z.string(),
  policy_error: z.string().nullable(),
  open_requests: z.number().int().min(0),
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

export const AutonomySchema = z.object({
  levels: z.array(z.object({ agent: z.string(), class: z.string(), bucket: z.string(), level: z.string(), since: z.number() })),
});

export const PersonStatsSchema = z.object({
  user: z.string(),
  answers: z.number().int(),
  approvals: z.number().int(),
  denials: z.number().int(),
  ineligible: z.number().int(),
  median_latency_ms: z.number().nullable(),
  open_cards: z.number().int(),
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

export const TeamSchema = z.object({
  people: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      groups: z.array(z.string()).default([]),
      roles: z.array(z.string()).default([]),
    }),
  ),
  agents: z.record(z.object({ vendor: z.string().optional() }).passthrough()).default({}),
});
export type Team = z.infer<typeof TeamSchema>;

/** The parts of the policy file the Policy tab renders. */
export const PolicyFileSchema = z.object({
  mode: z.string().optional(),
  tiers: z.record(z.tuple([z.number(), z.number()])),
  classes: z.record(
    z
      .object({
        summary: z.string().optional(),
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

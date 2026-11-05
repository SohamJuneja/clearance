/** zod schemas for policy/clearance.policy.yaml and policy/team.yaml. `.strict()` so a typo is an error. */
import { VendorSchema } from "@clearance/contracts";
import { z } from "zod";

export const TierNameSchema = z.enum(["low", "medium", "high", "critical"]);
export const LevelSchema = z.enum(["L0", "L1", "L2", "L3"]);
export const DurationSchema = z.string().regex(/^\d+(ms|s|m|h|d)$/, 'expected a duration like "25m", "24h" or "30s"');

const MATCH_KINDS = ["gate", "mcp", "shell", "file_write", "file_read", "http"] as const;

export const MatchEntrySchema = z
  .object({
    gate: z.string().optional(),
    mcp: z.string().optional(),
    shell: z.string().optional(),
    file_write: z.string().optional(),
    file_read: z.string().optional(),
    http: z.string().optional(),
    /** A hook call that the gate is going to see and hold itself, so the hook must not open a second card. */
    via_gate: z.boolean().optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const present = MATCH_KINDS.filter((kind) => entry[kind] !== undefined);
    if (present.length !== 1) {
      ctx.addIssue({ code: "custom", message: `expected exactly one of ${MATCH_KINDS.join(", ")}` });
    }
  });
export type MatchEntry = z.infer<typeof MatchEntrySchema>;

export const ApproverRefSchema = z
  .object({
    role: z.string().optional(),
    group: z.string().optional(),
    owner_of: z.string().optional(),
    person: z.string().optional(),
  })
  .strict()
  .superRefine((ref, ctx) => {
    const present = [ref.role, ref.group, ref.owner_of, ref.person].filter((value) => value !== undefined);
    if (present.length !== 1) {
      ctx.addIssue({ code: "custom", message: "expected exactly one of role, group, owner_of, person" });
    }
  });
export type ApproverRef = z.infer<typeof ApproverRefSchema>;

const FallbackSchema = z.object({ group: z.string(), room: z.string() }).strict();

const ApproversSchema = z
  .object({
    label: z.string().optional(),
    any_of: z.array(ApproverRefSchema).min(1),
    exclude: z.array(z.string()).optional(),
    exclude_agent_owner_from: z.union([TierNameSchema, z.literal("never")]).optional(),
    quorum: z
      .object({
        default: z.number().int().min(1),
        low: z.number().int().min(1).optional(),
        medium: z.number().int().min(1).optional(),
        high: z.number().int().min(1).optional(),
        critical: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
    fallback: FallbackSchema.optional(),
  })
  .strict();

const EscalateStepSchema = z
  .object({
    after: DurationSchema,
    add: z.literal("backup").optional(),
    post: z.string().optional(),
    mention: z.string().optional(),
    notify: z.literal("requester").optional(),
  })
  .strict()
  .superRefine((step, ctx) => {
    const present = [step.add, step.post, step.notify].filter((value) => value !== undefined);
    if (present.length !== 1) ctx.addIssue({ code: "custom", message: "expected exactly one of add, post, notify" });
  });

const AutonomySchema = z
  .object({
    max_level: LevelSchema,
    buckets: z
      .array(
        z
          .object({
            name: z.string(),
            when: z.string(),
            /** "refunds up to ₹5,000": how people read this bucket. */
            label: z.string().optional(),
            /** L3 runs silently up to this much a day: the sum of `amount`, or a count when the call has none. */
            daily_cap: z.number().positive().optional(),
          })
          .strict(),
      )
      .optional(),
    promote_after: z
      .object({ approvals: z.number().int(), days: z.number().int(), min_distinct_approvers: z.number().int() })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

const ClassSchema = z
  .object({
    summary: z.string().optional(),
    match: z.array(MatchEntrySchema).min(1),
    decision: z.literal("deny").optional(),
    reason: z.string().optional(),
    extract: z.record(z.string()).optional(),
    risk: z
      .object({
        base: z.number(),
        add: z
          .array(
            z
              .object({
                when: z.string(),
                points: z.number(),
                flag: z.string().optional(),
                /** Words for the reason text and the card's policy line: "refunds over ₹10,000". */
                why: z.string().optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
    aggregate: z
      .array(
        z
          .object({
            sum: z.string(),
            by: z.string(),
            window: DurationSchema,
            over: z.number(),
            then: z.enum(["hold", "deny"]),
            why: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    reversible: z.boolean().optional(),
    approvers: ApproversSchema.optional(),
    escalate: z.array(EscalateStepSchema).optional(),
    autonomy: AutonomySchema.optional(),
    drills: z.boolean().optional(),
  })
  .strict();
export type PolicyClass = z.infer<typeof ClassSchema>;

const RangeSchema = z.tuple([z.number(), z.number()]);

export const PolicyFileSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(["enforce", "shadow"]),
    currency: z.string(),
    time_scale: z.number().positive(),
    tiers: z.object({ low: RangeSchema, medium: RangeSchema, high: RangeSchema, critical: RangeSchema }).strict(),
    defaults: z
      .object({
        request_ttl: DurationSchema,
        grant_ttl: DurationSchema,
        max_open_cards_per_person: z.number().int().min(1),
        exclude_requester: z.boolean(),
        exclude_agent_owner_from: TierNameSchema,
        unknown_protected_action: z.enum(["hold", "deny"]),
        business_hours: z.object({ days: z.string(), hours: z.string(), tz: z.string() }).strict(),
        fallback: FallbackSchema,
        gate_mcp_servers: z.array(z.string()),
        known_mcp_servers: z.array(z.string()),
      })
      .strict(),
    safe: z.array(MatchEntrySchema),
    protected: z.array(MatchEntrySchema).default([]),
    classes: z.record(ClassSchema),
    drills: z
      .object({
        enabled: z.boolean(),
        rate: z.number(),
        max_per_person_per_day: z.number().int(),
        library: z.string(),
      })
      .strict()
      .optional(),
    rubber_stamp: z
      .object({
        t_min: z
          .object({ base_s: z.number(), per_evidence_line_s: z.number(), tier_bonus_s: z.record(z.number()) })
          .strict(),
        streak: z.object({ approvals: z.number().int(), max_denials: z.number().int() }).strict(),
        batch: z.object({ approvals: z.number().int(), within_s: z.number() }).strict().optional(),
        concentration: z.object({ share: z.number(), min_answers: z.number().int() }).strict().optional(),
        friction: z.string(),
      })
      .strict()
      .optional(),
    policy_owners: z.array(ApproverRefSchema).optional(),
    policy_change_quorum: z.number().int().optional(),
    digest: z.object({ at: z.string().regex(/^\d{2}:\d{2}$/, 'expected a time like "18:30"') }).strict().optional(),
    break_glass: z.object({ people: z.array(z.string()), review_within: DurationSchema }).strict().optional(),
  })
  .strict();
export type PolicyFile = z.infer<typeof PolicyFileSchema>;

export const TeamFileSchema = z
  .object({
    /** People who may switch drills on and off. */
    admins: z.array(z.string()).optional(),
    people: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          switch_user: z.string().optional(),
          groups: z.array(z.string()).default([]),
          roles: z.array(z.string()).default([]),
          /** Git hosting handle, so a merge's author can be matched to a person. */
          github: z.string().optional(),
          away_until: z.string().optional(),
          delegate_to: z.string().optional(),
        })
        .strict(),
    ),
    rotas: z
      .record(
        z.array(
          z
            .object({
              person: z.string(),
              days: z.string().optional(),
              hours: z.string().optional(),
              tz: z.string().optional(),
              backup: z.boolean().optional(),
            })
            .strict(),
        ),
      )
      .default({}),
    owners: z.object({ services: z.record(z.string()).default({}) }).strict().default({ services: {} }),
    agents: z
      .record(z.object({ cwd: z.string(), owner: z.string(), vendor: VendorSchema.optional() }).strict())
      .default({}),
    /** Room names used by the policy, mapped to Switch room ids. A name with no mapping is passed as is. */
    rooms: z.record(z.string()).default({}),
  })
  .strict();
export type TeamFile = z.infer<typeof TeamFileSchema>;

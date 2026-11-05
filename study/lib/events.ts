/**
 * The result log format: one JSON event per line in study/results/<participant>.jsonl.
 *
 * IDs only. There is no name field anywhere, and the free-text comment is the only text a person
 * types. PLAN 11.8.
 *
 * Two platforms write this format and one analysis reads it (PLAN 11.5). Every record says which
 * platform it came from. Records from before that have no field, and their session_start still says.
 */
import { z } from "zod";

export const PARTICIPANT_ID = /^p\d{2}$/;

export const PlatformSchema = z.enum(["approval-lab", "switch"]);
export type Platform = z.infer<typeof PlatformSchema>;

const base = {
  participant: z.string().regex(PARTICIPANT_ID),
  at: z.string(),
  platform: PlatformSchema.optional(),
  /** Set only on dry runs and test data. eval/study refuses to treat these as results. */
  synthetic: z.literal(true).optional(),
};

const Answer = {
  condition: z.enum(["A", "B"]),
  request_id: z.string(),
  decision: z.enum(["approve", "deny", "confirm_failed"]),
  /** The button pressed, or "typed" for a correct type-to-confirm answer. */
  option: z.string(),
  ms: z.number().positive(),
  /**
   * True if `ms` includes something other than deciding. In the Lab: the page was hidden while the card
   * was up. In Switch: someone else's answer used up the card and it had to be posted again.
   */
  interrupted: z.boolean(),
  confirm_attempts: z.number().int().min(0),
};

export const StudyEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session_start"), ...base, group: z.number().int().min(1).max(4), platform: PlatformSchema, schema: z.literal(1) }),
  z.object({ type: z.literal("consent"), ...base, agreed: z.literal(true), role: z.string(), familiarity: z.number().int().min(1).max(5) }),
  z.object({ type: z.literal("briefing_read"), ...base }),
  z.object({ type: z.literal("practice"), ...base, ...Answer }),
  z.object({ type: z.literal("confirm_wrong"), ...base, request_id: z.string() }),
  z.object({
    type: z.literal("decision"),
    ...base,
    ...Answer,
    group: z.number().int().min(1).max(4),
    block: z.number().int().min(1).max(2),
    set: z.enum(["X", "Y"]),
    position: z.number().int().min(1).max(12),
    template: z.string(),
    kind: z.enum(["legit", "flawed"]),
    flaw_type: z.string().nullable(),
    evidence_in_a: z.enum(["raw", "none"]).nullable(),
  }),
  z.object({ type: z.literal("confidence"), ...base, block: z.number().int().min(1).max(2), value: z.number().int().min(1).max(5) }),
  z.object({ type: z.literal("break_done"), ...base }),
  z.object({ type: z.literal("comment"), ...base, text: z.string().max(2000) }),
  z.object({ type: z.literal("session_end"), ...base }),
  z.object({ type: z.literal("stopped"), ...base }),
]);
export type StudyEvent = z.infer<typeof StudyEventSchema>;
export type DecisionEvent = Extract<StudyEvent, { type: "decision" }>;

export const NOT_APPROVED = new Set<DecisionEvent["decision"]>(["deny", "confirm_failed"]);

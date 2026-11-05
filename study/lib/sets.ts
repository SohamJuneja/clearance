/** The request-set file format. Every set is validated here on load, so a bad file fails at startup. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

export const FLAW_TYPES = ["new_destination", "text_call_mismatch", "failing_checks", "external_bulk_email"] as const;

const Confirm = z.object({
  /** Which field is asked for. PLAN Appendix D rotates these. */
  field: z.enum(["amount", "destination_last4", "service", "recipient_domain"]),
  expected: z.string().min(1),
  question: z.string().min(1),
});

export const StudyRequestSchema = z
  .object({
    id: z.string().regex(/^(X|Y|P)\d{2}$/),
    template: z.string().regex(/^(T\d{2}|P\d)$/),
    kind: z.enum(["legit", "flawed"]),
    flaw: z
      .object({
        type: z.enum(FLAW_TYPES),
        /** Shown in the debrief when the participant approved this request. */
        explanation: z.string().min(1),
        /** Whether the fact that shows the flaw is on the Switch card at all. See build-sets.ts. */
        evidence_in_a: z.enum(["raw", "none"]),
      })
      .nullable(),
    /** Why a legitimate card is legitimate, especially one that carries a flag. */
    legit_note: z.string().nullable(),
    call: z.object({ class: z.string(), endpoint: z.string(), args: z.record(z.unknown()) }),
    a: z.object({ agent: z.string(), description: z.string().min(1), command: z.string().min(1) }),
    b: z.object({
      clr: z.string().regex(/^CLR-\d{4}$/),
      handle: z.string().regex(/^A\d+$/),
      score: z.number().int(),
      tier: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
      reversibility: z.enum(["irreversible", "reversible"]),
      headline: z.string().min(1),
      parsed: z.array(z.string()).min(1),
      context: z.array(z.string()).min(1),
      flags: z.array(z.string()),
      claim: z.string().min(1),
      asked_by: z.string().min(1),
      why_you: z.string().min(1),
      policy: z.string().min(1),
      confirm: Confirm.nullable(),
    }),
  })
  .refine((request) => (request.kind === "flawed") === (request.flaw !== null), "flawed requests, and only those, carry a flaw")
  .refine((request) => (request.b.tier === "CRITICAL") === (request.b.confirm !== null), "type-to-confirm applies to critical tier, per PLAN F6");
export type StudyRequest = z.infer<typeof StudyRequestSchema>;

export const StudySetSchema = z.object({
  set: z.enum(["X", "Y", "practice"]),
  synthetic: z.literal(true),
  requests: z.array(StudyRequestSchema).min(1),
});
export type StudySet = z.infer<typeof StudySetSchema>;

const SETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../sets");

export function loadSet(name: "X" | "Y" | "practice"): StudySet {
  const file = resolve(SETS_DIR, `${name}.yaml`);
  return StudySetSchema.parse(parse(readFileSync(file, "utf8")));
}

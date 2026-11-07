/**
 * F24: which Switch room role does the job behind each gate class, so a call refused for being outside an agent's job can
 * say who to hand it to. This is the one place that says so. The gate words its refusal from it and core reads it to keep
 * track of who asked. Plain data and a lookup, with no model anywhere near it.
 *
 * A role only says where to send work. It never decides who may approve or what an agent may do: anyone in a room may be
 * able to take a role, so that stays in policy/ and the gate's grants. See docs/architecture.md.
 */
export type JobRole = {
  /** The Switch role, addressed as `@role`. */
  role: string;
  /** The room that declares it. Switch lets an agent hold one role at a time across every room, so a role lives in one room. */
  room: string;
  /**
   * Who holds the gate grant for this job, and so is expected to take the role, first choice first. A test holds this to
   * GATE_GRANTS. Used to find someone to wake, and to count them as having been asked. It grants nothing.
   */
  grantHolders: readonly string[];
};

const REFUNDS: JobRole = { role: "refunds", room: "support", grantHolders: ["refunds-agent"] };
const CUSTOMER_EMAIL: JobRole = { role: "customer-email", room: "support", grantHolders: ["support-agent"] };
const MERGES: JobRole = { role: "merges", room: "eng", grantHolders: ["coder", "reviewer"] };
const OPS: JobRole = { role: "ops", room: "eng", grantHolders: ["ops-agent"] };

/** Gate class to the role that does that job. A class that isn't here has no role, and its refusal only refuses. */
export const JOB_ROLES: Readonly<Record<string, JobRole>> = {
  refund: REFUNDS,
  payout_change: REFUNDS,
  customer_email: CUSTOMER_EMAIL,
  merge: MERGES,
  deploy: OPS,
  delete: OPS,
};

/** The role for a gate class, or null. A class is matched exactly: `constructor` is nobody's job. */
export function jobRoleFor(cls: string): JobRole | null {
  return Object.hasOwn(JOB_ROLES, cls) ? (JOB_ROLES[cls] ?? null) : null;
}

/** The job role with this name, whatever the case: Switch matches mentions without regard to it. */
export function jobRoleNamed(name: string): JobRole | null {
  const wanted = name.toLowerCase();
  return Object.values(JOB_ROLES).find((job) => job.role === wanted) ?? null;
}

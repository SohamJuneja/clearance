/**
 * The gate's table of mutating operations. HTTP routes and MCP tools both read it, so there is one
 * path through `check` and one definition of what each call may carry.
 *
 * Schemas are strict on purpose: an agent cannot smuggle an extra field past the policy into Acme,
 * and `amount` must be an integer so a string cannot slip past a numeric rule.
 */
import { z } from "zod";

export const GATE_CLASSES = [
  "refund",
  "deploy",
  "customer_email",
  "payout_change",
  "delete",
  "merge",
] as const;
export type GateClass = (typeof GATE_CLASSES)[number];

/** Safe as a single URL path segment: no separators, and it cannot be `.` or `..`. */
const pathSegment = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/, "must be a plain identifier");
const text = z.string().min(1).max(256);

/**
 * Fields Acme requires are required here too, so a person is never asked to approve a call that
 * cannot run. `customer_id` and `destination` are the exception: the gate fills them when omitted.
 */
const RefundArgs = z
  .object({
    order_id: text,
    customer_id: text.optional(),
    amount: z.number().int().positive().safe(),
    destination: text.optional(),
  })
  .strict();

const DeployArgs = z.object({ service: text, env: text, version: text }).strict();
const RollbackArgs = z.object({ service: text, env: text }).strict();

const EmailArgs = z
  .object({
    /** One address only, so a domain rule cannot be dodged with a second recipient. */
    to: z.string().regex(/^[^\s,;<>]+@[^\s,;<>]+$/, "must be a single email address"),
    subject: z.string().max(998),
    body: z.string().max(100_000),
    attachments: z.array(text).max(20).default([]),
  })
  .strict();

const PayoutArgs = z.object({ customer_id: text, upi: text }).strict();
const DeleteArgs = z.object({ table: pathSegment, id: pathSegment }).strict();
const MergeArgs = z.object({ repo: text, pr: z.number().int().positive().safe() }).strict();

export type OperationName =
  "refund" | "deploy" | "rollback" | "email" | "payout" | "delete" | "merge";

export type Operation = {
  name: OperationName;
  cls: GateClass;
  method: "POST" | "DELETE";
  /** Fastify route pattern. */
  route: string;
  schema: z.AnyZodObject;
  /** Concrete gate path for this call. Goes into `business.endpoint`. */
  gatePath: (args: Record<string, unknown>) => string;
  /** Concrete Acme path for this call. */
  upstreamPath: (args: Record<string, unknown>) => string;
  /** What Acme receives, or null for a call with no body. */
  upstreamBody: (args: Record<string, unknown>) => unknown;
  /** Where the arguments come from on the HTTP route: the JSON body, or else the path. */
  hasBody: boolean;
};

const fixed = (
  name: OperationName,
  cls: GateClass,
  path: string,
  schema: Operation["schema"],
): Operation => ({
  name,
  cls,
  method: "POST",
  route: `/acme${path}`,
  schema,
  gatePath: () => `/acme${path}`,
  upstreamPath: () => path,
  upstreamBody: (args) => args,
  hasBody: true,
});

export const OPERATIONS: Record<OperationName, Operation> = {
  refund: fixed("refund", "refund", "/refunds", RefundArgs),
  deploy: fixed("deploy", "deploy", "/deploys", DeployArgs),
  rollback: fixed("rollback", "deploy", "/rollbacks", RollbackArgs),
  email: fixed("email", "customer_email", "/emails", EmailArgs),
  payout: fixed("payout", "payout_change", "/payouts/destinations", PayoutArgs),
  delete: {
    name: "delete",
    cls: "delete",
    method: "DELETE",
    route: "/acme/records/:table/:id",
    schema: DeleteArgs,
    gatePath: (args) => `/acme/records/${String(args.table)}/${String(args.id)}`,
    upstreamPath: (args) =>
      `/records/${encodeURIComponent(String(args.table))}/${encodeURIComponent(String(args.id))}`,
    upstreamBody: () => null,
    hasBody: false,
  },
  merge: {
    name: "merge",
    cls: "merge",
    method: "POST",
    route: "/github/merge",
    schema: MergeArgs,
    gatePath: () => "/github/merge",
    upstreamPath: (args) => `/pulls/${encodeURIComponent(String(args.pr))}/merge`,
    upstreamBody: (args) => ({ repo: args.repo }),
    hasBody: true,
  },
};

/** Lookup kinds core may ask for, mapped to Acme read paths. */
export const LOOKUP_PATHS: Record<string, string> = {
  orders: "/orders",
  customers: "/customers",
  destinations: "/destinations",
  ci: "/ci",
  github: "/pulls",
  pulls: "/pulls",
  files: "/files",
  services: "/services",
  tickets: "/tickets",
};

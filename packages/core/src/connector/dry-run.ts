/**
 * What the read-only connector (packages/mcp-connector) can ask core to try without making it: a shell command as an agent's
 * hook would send it, or one of the gate's operations with its arguments. Each becomes the Action the hook route or the gate
 * would build, so the policy sees what it would see. Nothing here records anything.
 */
import type { Action, LookupPort, Vendor } from "@clearance/contracts";
import type { OperationName } from "@clearance/gate";
import { ulid } from "ulid";
import { z } from "zod";

/** The gate's operations by name. connector-routes.test.ts holds this to the gate's own table. */
export const OPERATION_NAMES = ["refund", "deploy", "rollback", "email", "payout", "delete", "merge"] as const satisfies readonly OperationName[];
const AgentName = z.string().min(1).max(128);

export const DryRunBodySchema = z.union([
  z.object({ shell: z.string().min(1).max(20_000), agent: AgentName.optional() }).strict(),
  z.object({ operation: z.enum(OPERATION_NAMES), args: z.record(z.string(), z.unknown()), agent: AgentName.optional() }).strict(),
]);
export type DryRunBody = z.infer<typeof DryRunBodySchema>;

/** Never a real action's id, which is a ULID from the gate or the vendor's own. */
const dryRunId = () => `dry-run-${ulid()}`;

async function readField(lookup: LookupPort, kind: string, id: string, field: string): Promise<string | undefined> {
  try {
    const value = (await lookup.lookup(kind, id))?.[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The gate's own `enrich`, through core's lookup port: a refund that leaves out who and where is filled from the order and
 * the customer before core sees it, so a dry run without them is asked about the same call.
 */
async function enriched(name: OperationName, args: Record<string, unknown>, lookup: LookupPort): Promise<Record<string, unknown>> {
  if (name !== "refund") return args;
  const filled = { ...args };
  if (filled.customer_id === undefined) {
    const customer = await readField(lookup, "orders", String(filled.order_id), "customer_id");
    if (customer !== undefined) filled.customer_id = customer;
  }
  if (filled.destination === undefined && filled.customer_id !== undefined) {
    const destination = await readField(lookup, "customers", String(filled.customer_id), "default_destination");
    if (destination !== undefined) filled.destination = destination;
  }
  return filled;
}

export async function dryRunAction(
  body: DryRunBody,
  context: { agent: string; vendor: Vendor; nowMs: number; lookup: LookupPort },
): Promise<{ ok: true; action: Action } | { ok: false; error: string }> {
  const base = { id: dryRunId(), at: new Date(context.nowMs).toISOString(), agent: { name: context.agent } };
  if ("shell" in body) {
    // A hook call is the agent's own vendor's. The gate is never a hook.
    const vendor = context.vendor === "gate" ? "claude" : context.vendor;
    return { ok: true, action: { ...base, source: "hook", vendor, kind: "shell", raw: { command: body.shell }, shell: { command: body.shell } } };
  }
  // Loaded only here, so the gate's server and MCP code stay out of core until a dry run of a gate call needs its table.
  const { OPERATIONS } = await import("@clearance/gate");
  const op = OPERATIONS[body.operation];
  // The gate refuses arguments its schema doesn't take before core is asked, so a dry run does too.
  const parsed = op.schema.safeParse(body.args);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".") || "args"}: ${issue.message}`).join("; ") };
  }
  const args = await enriched(op.name, parsed.data as Record<string, unknown>, context.lookup);
  const endpoint = `${op.method} ${op.gatePath(args)}`;
  return {
    ok: true,
    action: {
      ...base,
      source: "gate",
      vendor: "gate",
      kind: "business",
      raw: { method: op.method, path: endpoint.slice(op.method.length + 1), body: op.hasBody ? args : undefined },
      business: { endpoint, args },
    },
  };
}

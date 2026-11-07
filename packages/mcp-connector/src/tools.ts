/**
 * The connector's MCP tools, for people: what is pending, what is waiting on me, why a request was held, the ledger and
 * whether its chain verifies, and a dry run. Each is a thin skin over one read-only core route.
 *
 * There is no tool to approve, deny or cancel, and there must never be one. An answer counts only from Switch's own
 * approval_outcome event, which says who pressed the card. Text in a chat, or a tool call from an assistant, says nothing
 * about who someone is.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CoreError, type CoreClient } from "./client.ts";
import type { ConnectorConfig } from "./config.ts";

export const TOOL_NAMES = ["pending_requests", "waiting_on_me", "explain_request", "recent_ledger", "verify_ledger", "dry_run"] as const;

const READ_ONLY =
  "Read-only: this connector can't approve, deny or cancel anything. A decision counts only when an eligible person answers the card in Switch, and Clearance takes who answered from Switch, never from text.";

const ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** The gate's operations, by the names core's dry run takes. Core checks the arguments with the gate's own schemas. */
const OPERATIONS = ["refund", "deploy", "rollback", "email", "payout", "delete", "merge"] as const;

// ── What core answers, checked before a word of it is shown ──────────────────

const FlagSchema = z.object({ code: z.string(), text: z.string() }).passthrough();
const NamedReasonSchema = z.object({ name: z.string(), why: z.string() }).passthrough();

const SummarySchema = z
  .object({
    id: z.string(),
    state: z.string(),
    class: z.string(),
    tier: z.string(),
    what: z.string().nullable(),
    agent: z.string(),
    requested_by: z.array(z.string()),
    quorum_required: z.number().int(),
    approved_by: z.array(z.string()),
    can_decide: z.array(z.string()),
    created_at: z.string(),
    expires_at: z.string(),
    decided_at: z.string().nullable(),
    waiting_on_you: z.boolean().optional(),
  })
  .passthrough();
type Summary = z.infer<typeof SummarySchema>;

const PendingSchema = z.object({ requests: z.array(SummarySchema) }).passthrough();

const ExplainedSchema = SummarySchema.extend({
  why: z.string(),
  hold_summary: z.string().nullable(),
  flags: z.array(FlagSchema),
  call: z.array(z.string()),
  context: z.array(z.string()),
  cannot_decide: z.array(NamedReasonSchema),
  is_drill: z.boolean().optional(),
});

const InboxSchema = z
  .object({
    user: z.string(),
    count: z.number().int(),
    items: z.array(
      z
        .object({
          request_id: z.string(),
          class: z.string(),
          tier: z.string(),
          typed: z.boolean(),
          what: z.string(),
          expires_at: z.string(),
          shared_in: z.string().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const LedgerSchema = z
  .object({
    entries: z.array(
      z.object({ seq: z.number().int(), at: z.string(), type: z.string(), request_id: z.string().nullable(), payload: z.record(z.unknown()) }).passthrough(),
    ),
  })
  .passthrough();

const VerificationSchema = z.object({ ok: z.boolean(), firstBad: z.object({ seq: z.number().int(), reason: z.string() }).optional() }).passthrough();

const DryRunSchema = z
  .object({
    decision: z.enum(["allow", "hold", "deny"]),
    reason: z.string(),
    class: z.string().optional(),
    tier: z.string().optional(),
    step: z.string().optional(),
    agent: z.string(),
    policy_mode: z.string(),
    // Core says it recorded nothing. Anything else isn't a dry run, and isn't shown as one.
    recorded: z.literal(false),
    flags: z.array(FlagSchema).optional(),
    what: z.string().optional(),
    already_open: z.string().nullable().optional(),
    quorum_required: z.number().int().optional(),
    requested_by: z.array(z.string()).optional(),
    would_ask: z.array(z.string()).optional(),
    can_decide: z.array(z.string()).optional(),
    cannot_decide: z.array(NamedReasonSchema).optional(),
    fallback: z.object({ group: z.string(), room: z.string(), reason: z.string() }).passthrough().nullable().optional(),
    why: z.string().optional(),
  })
  .passthrough();

// ── What the tools take ──────────────────────────────────────────────────────

const ExplainArgs = z.object({ request_id: z.string().regex(/^CLR-\d{1,9}$/i, "a request id like CLR-0042") }).strict();
const LedgerArgs = z.object({ limit: z.number().int().min(1).max(100).optional() }).strict();
const DryRunArgs = z
  .object({
    shell: z.string().min(1).max(20_000).optional(),
    operation: z.enum(OPERATIONS).optional(),
    args: z.record(z.unknown()).optional(),
    agent: z.string().min(1).max(128).optional(),
  })
  .strict();

// ── Words ────────────────────────────────────────────────────────────────────

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

const list = (names: string[], none = "nobody") => (names.length > 0 ? names.join(", ") : none);
const flagLine = (flags: { text: string }[]) => (flags.length > 0 ? flags.map((flag) => flag.text).join("; ") : "none");

function summaryLines(request: Summary): string[] {
  const about = [request.id, `${request.class}, ${request.tier}`, request.what ?? "", request.waiting_on_you ? "waiting on you" : ""].filter(Boolean).join(" · ");
  return [
    about,
    `  agent ${request.agent}, asked by ${list(request.requested_by, "nobody Clearance could see")}`,
    `  can decide: ${list(request.can_decide)} (needs ${request.quorum_required}, approved so far: ${list(request.approved_by, "none")})`,
    `  state ${request.state}, expires ${request.expires_at}`,
  ];
}

/** A ledger payload on one line, cut short: the whole entry is in core's SQLite and on the Desk. */
function payloadLine(payload: Record<string, unknown>, max = 240): string {
  const whole = JSON.stringify(payload);
  return whole.length <= max ? whole : `${whole.slice(0, max - 1)}…`;
}

function dryRunText(answer: z.infer<typeof DryRunSchema>): string {
  const about = [answer.class ? `class ${answer.class}` : "no class", answer.tier ? `tier ${answer.tier}` : null].filter(Boolean).join(", ");
  const verdict = { allow: "ALLOWED", hold: "HELD", deny: "DENIED" }[answer.decision];
  const lines = [`Would be ${verdict} (${about}) for ${answer.agent}. Nothing was recorded: no request, card, grant or ledger entry.`, `Reason: ${answer.reason}`];
  if (answer.decision === "allow" && answer.step === "autonomy") lines.push("It would run on its own, under the autonomy this agent has earned for it.");
  if (answer.decision === "hold") {
    if (answer.what) lines.push(`The card would read: ${answer.what}`);
    lines.push(`Asked by, as things stand: ${list(answer.requested_by ?? [], "nobody Clearance can see, which takes more approvers")}`);
    lines.push(`Would ask first: ${list(answer.would_ask ?? [])}. Could decide: ${list(answer.can_decide ?? [])} (needs ${answer.quorum_required ?? "?"}).`);
    if ((answer.cannot_decide ?? []).length > 0) lines.push(`Can't decide: ${(answer.cannot_decide ?? []).map((entry) => `${entry.name} (${entry.why})`).join(", ")}`);
    if (answer.fallback) lines.push(`Fallback: ${answer.fallback.group} in ${answer.fallback.room}, because ${answer.fallback.reason}`);
    lines.push(`Flags: ${flagLine(answer.flags ?? [])}`);
    if (answer.already_open) lines.push(`${answer.already_open} is already open for this exact call: a real call now would join it, not start another.`);
    if (answer.why) lines.push(`Why: ${answer.why}`);
  } else if ((answer.flags ?? []).length > 0) {
    lines.push(`Flags: ${flagLine(answer.flags ?? [])}`);
  }
  if (answer.policy_mode === "shadow" && answer.decision !== "deny") lines.push("The policy is in shadow mode: a real call would be logged as what it would do, and run.");
  lines.push("This is the policy's answer as things stand now: who has asked that agent, who is away and what has run lately can change it. The gate also refuses an operation the agent's own token doesn't cover.");
  return lines.join("\n");
}

/** A tool body that can only report what core said, or that core couldn't say. */
async function answering(work: () => Promise<string>): Promise<CallToolResult> {
  try {
    return text(await work());
  } catch (error) {
    if (error instanceof CoreError) return text(`Clearance couldn't answer: ${error.message}`, true);
    return text("Clearance couldn't answer: the connector hit an error it didn't expect.", true);
  }
}

export function buildConnectorServer(core: CoreClient, config: Pick<ConnectorConfig, "person">): McpServer {
  const server = new McpServer(
    { name: "clearance", version: "0.1.0" },
    {
      instructions: `Clearance holds risky agent actions until the right person approves them in Switch. These tools read what it holds and why, and dry-run a call. ${READ_ONLY}`,
    },
  );
  const me = config.person;

  server.registerTool(
    "pending_requests",
    {
      title: "Pending requests",
      description: `Every request Clearance is holding now: what each call is, which agent made it, who asked, and who can decide it under the policy (the person who asked never can).${me ? " Marks the ones waiting on you." : ""} ${READ_ONLY}`,
      annotations: ANNOTATIONS,
    },
    async () =>
      answering(async () => {
        const { requests } = await core.get(me ? `/v1/pending?person=${encodeURIComponent(me)}` : "/v1/pending", PendingSchema);
        if (requests.length === 0) return "Nothing is waiting.";
        const head = requests.length === 1 ? "1 request is waiting." : `${requests.length} requests are waiting.`;
        return [head, "", ...requests.flatMap((request) => [...summaryLines(request), ""])].join("\n").trimEnd();
      }),
  );

  server.registerTool(
    "waiting_on_me",
    {
      title: "Waiting on me",
      description: `The cards waiting for you to answer, the same list Clearance keeps in your direct room in Switch. "You" is the team id set as CLEARANCE_PERSON when the connector was installed. Answer each card in Switch. ${READ_ONLY}`,
      annotations: ANNOTATIONS,
    },
    async () => {
      if (!me) return text("Set CLEARANCE_PERSON to your team id (as in policy/team.yaml) in the connector's settings, then restart it.", true);
      return answering(async () => {
        const inbox = await core.get(`/v1/inbox?user=${encodeURIComponent(me)}`, InboxSchema);
        if (inbox.items.length === 0) return `Nothing is waiting on ${me}.`;
        const lines = inbox.items.map((item) =>
          [
            item.request_id,
            `${item.class}, ${item.tier}`,
            item.what,
            item.shared_in ? `in ${item.shared_in}, shared` : "in your direct room",
            item.typed ? "asks you to type a value" : "",
            `expires ${item.expires_at}`,
          ]
            .filter(Boolean)
            .join(" · "),
        );
        return [`${inbox.items.length} waiting on ${me}. Answer each card in Switch.`, ...lines].join("\n");
      });
    },
  );

  server.registerTool(
    "explain_request",
    {
      title: "Explain a request",
      description: `Why a request was held: the same answer as \`@clearance why CLR-0042\` in Switch, plus who asked, who can decide it now and why the others can't, its flags, and what the call is. ${READ_ONLY}`,
      inputSchema: ExplainArgs,
      annotations: ANNOTATIONS,
    },
    async ({ request_id }) =>
      answering(async () => {
        const request = await core.get(`/v1/requests/${encodeURIComponent(request_id)}/explain`, ExplainedSchema);
        const lines = [...summaryLines(request), `Why: ${request.why}`];
        if (request.hold_summary) lines.push(`Held because: ${request.hold_summary}`);
        if (request.cannot_decide.length > 0) lines.push(`Can't decide: ${request.cannot_decide.map((entry) => `${entry.name} (${entry.why})`).join(", ")}`);
        lines.push(`Flags: ${flagLine(request.flags)}`);
        if (request.call.length > 0) lines.push(`The call: ${request.call.join("; ")}`);
        if (request.context.length > 0) lines.push(`Context: ${request.context.join("; ")}`);
        if (request.is_drill) lines.push("This was a practice request: nothing was going to run.");
        return lines.join("\n");
      }),
  );

  server.registerTool(
    "recent_ledger",
    {
      title: "Recent ledger",
      description: `The newest entries in Clearance's hash-chained ledger (20 unless you ask for up to 100), as the team reads it in #approvals: practice requests are left out and per-person timing is removed. ${READ_ONLY}`,
      inputSchema: LedgerArgs,
      annotations: ANNOTATIONS,
    },
    async ({ limit }) =>
      answering(async () => {
        const { entries } = await core.get(`/v1/ledger/team?limit=${limit ?? 20}`, LedgerSchema);
        if (entries.length === 0) return "The ledger has no entries the team can read yet.";
        const lines = entries.map((entry) => `#${entry.seq} ${entry.at} ${entry.type}${entry.request_id ? ` ${entry.request_id}` : ""} ${payloadLine(entry.payload)}`);
        return [`The newest ${entries.length}, oldest first. Each entry holds the hash of the one before it.`, ...lines].join("\n");
      }),
  );

  server.registerTool(
    "verify_ledger",
    {
      title: "Verify the ledger",
      description: `Recompute the ledger's hash chain from its first entry and say whether it holds, or where it breaks. ${READ_ONLY}`,
      annotations: ANNOTATIONS,
    },
    async () =>
      answering(async () => {
        // Only the verdict. The entry count and head move with entries the team doesn't see, like an open drill's.
        const result = await core.get("/v1/ledger/verify", VerificationSchema);
        if (result.ok) return "The ledger's hash chain verifies, from the first entry to the last.";
        return result.firstBad
          ? `The ledger's hash chain is BROKEN at entry ${result.firstBad.seq}: ${result.firstBad.reason}. Tell whoever runs Clearance.`
          : "The ledger's hash chain does NOT verify. Tell whoever runs Clearance.";
      }),
  );

  server.registerTool(
    "dry_run",
    {
      title: "Would this be held?",
      description: [
        "Ask Clearance what it would do with a call, without making it: the decision, class and tier, and for a hold who would be asked, who could decide and why.",
        "Give either `shell` (a command line, as an agent's hook would send it) or `operation` with `args` (a gate call).",
        "Operations and their args: refund {order_id, amount (whole rupees), customer_id?, destination?}; deploy {service, env, version}; rollback {service, env}; email {to, subject, body, attachments?}; payout {customer_id, upi}; delete {table, id}; merge {repo, pr}.",
        "`agent` is the team agent making the call; without it, the team's first agent.",
        "Nothing is recorded: no request, card, grant or ledger entry, and it can't approve anything.",
        READ_ONLY,
      ].join(" "),
      inputSchema: DryRunArgs,
      annotations: ANNOTATIONS,
    },
    async ({ shell, operation, args, agent }) => {
      if ((shell === undefined) === (operation === undefined)) return text("Give either `shell`, or `operation` with `args`, not both and not neither.", true);
      if (operation !== undefined && args === undefined) return text(`\`operation\` ${operation} needs its \`args\`.`, true);
      if (shell !== undefined && args !== undefined) return text("`args` go with `operation`, not with `shell`.", true);
      const body = shell !== undefined ? { shell, ...(agent ? { agent } : {}) } : { operation, args, ...(agent ? { agent } : {}) };
      return answering(async () => dryRunText(await core.post("/v1/dry-run", body, DryRunSchema)));
    },
  );

  return server;
}

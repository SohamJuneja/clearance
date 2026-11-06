/**
 * Shared contracts between Clearance packages. Every boundary is validated with these zod schemas.
 * Change this file only from the lead session: every package builds against it.
 */
import { z } from "zod";

// ── Action (PLAN 6.4) ────────────────────────────────────────────────────────

export const VendorSchema = z.enum(["claude", "codex", "opencode", "cursor", "antigravity", "gate"]);
export type Vendor = z.infer<typeof VendorSchema>;

export const ActionKindSchema = z.enum(["shell", "file_write", "file_read", "http", "mcp", "business"]);
export type ActionKind = z.infer<typeof ActionKindSchema>;

export const ActionSchema = z.object({
  id: z.string().min(1),
  at: z.string().min(1),
  source: z.enum(["gate", "hook"]),
  vendor: VendorSchema,
  agent: z.object({
    name: z.string().min(1),
    switchAgentId: z.string().optional(),
    ownerUserId: z.string().optional(),
    cwd: z.string().optional(),
  }),
  session: z
    .object({
      vendorSessionId: z.string().optional(),
      switchRoomId: z.string().optional(),
      threadId: z.string().optional(),
    })
    .optional(),
  kind: ActionKindSchema,
  raw: z.unknown(),
  shell: z.object({ command: z.string() }).optional(),
  file: z.object({ path: z.string() }).optional(),
  http: z.object({ method: z.string(), url: z.string(), body: z.unknown().optional() }).optional(),
  mcp: z.object({ server: z.string(), tool: z.string(), args: z.unknown() }).optional(),
  business: z.object({ endpoint: z.string(), args: z.record(z.unknown()) }).optional(),
  agentClaim: z.string().optional(),
});
export type Action = z.infer<typeof ActionSchema>;

// ── Decisions ────────────────────────────────────────────────────────────────

export const TierSchema = z.enum(["low", "medium", "high", "critical"]);
export type Tier = z.infer<typeof TierSchema>;

export const DecisionSchema = z.enum(["allow", "hold", "deny"]);
export type Decision = z.infer<typeof DecisionSchema>;

export const FlagSchema = z.object({ code: z.string(), text: z.string() });
export type Flag = z.infer<typeof FlagSchema>;

/** Body of POST /v1/check (gate) and the internal call behind every /v1/hooks/* endpoint. */
export const CheckRequestSchema = z.object({ action: ActionSchema });
export type CheckRequest = z.infer<typeof CheckRequestSchema>;

export const CheckResponseSchema = z.object({
  decision: DecisionSchema,
  /** Human and agent readable. For a hold this is the Appendix D "HELD CLR-0042: ..." text. */
  reason: z.string(),
  request_id: z.string().optional(),
  class: z.string().optional(),
  tier: TierSchema.optional(),
  score: z.number().optional(),
  call_hash: z.string().optional(),
  flags: z.array(FlagSchema).optional(),
  /** True when a valid single-use grant was consumed by this allow. */
  grant_consumed: z.boolean().optional(),
  /** Only under `mode: shadow`: what enforcement would have answered. `decision` is what actually applies. */
  would_decide: DecisionSchema.optional(),
});
export type CheckResponse = z.infer<typeof CheckResponseSchema>;

// ── Request lifecycle (PLAN F3) ──────────────────────────────────────────────

export const RequestStateSchema = z.enum([
  "HELD",
  "ROUTED",
  "APPROVED",
  "DENIED",
  "EXPIRED",
  "CANCELLED",
  "BREAK_GLASS",
  "EXECUTED",
  "GRANTED",
  "CONSUMED",
  "VOIDED",
  /** Ran under earned autonomy (L2, L3): nobody was asked first. The gate or the hook runs it on the allow. */
  "AUTO",
]);
export type RequestState = z.infer<typeof RequestStateSchema>;

export const LedgerEntryTypeSchema = z.enum([
  "held",
  "routed",
  "answered",
  "ineligible_answer",
  "approved",
  "denied",
  "expired",
  "executed",
  "grant_consumed",
  "escalated",
  "drill_sent",
  "drill_result",
  "promotion_proposed",
  "promotion_signed",
  "promotion_rejected",
  "policy_proposed",
  "policy_rejected",
  "demoted",
  "incident",
  "policy_loaded",
  "break_glass",
  "cancelled",
]);
export type LedgerEntryType = z.infer<typeof LedgerEntryTypeSchema>;

// ── Chat events coming from Switch (produced by switch-agent, consumed by core) ──

/**
 * A message event from Switch. `sender` is an opaque participant id; `onBehalfOf` is a display name, platform messages only.
 * These are the only source of identity for requesters.
 */
export const ChatMessageEventSchema = z.object({
  roomId: z.string(),
  threadId: z.string().nullable().optional(),
  messageId: z.string(),
  sender: z.string(),
  senderName: z.string().nullable().optional(),
  senderKind: z.string().nullable().optional(),
  /** For a platform message only (a template's kickoff): the person's display name, not a participant id. */
  onBehalfOf: z.string().nullable().optional(),
  addressed: z.boolean(),
  body: z.string(),
  timestampMs: z.number(),
  channelType: z.string().nullable().optional(),
});
export type ChatMessageEvent = z.infer<typeof ChatMessageEventSchema>;

/** An answered card. `answeredBy` is the only source of identity for approvers. */
export const ApprovalOutcomeEventSchema = z.object({
  sessionId: z.string(),
  switchRequestId: z.string(),
  kind: z.enum(["approval", "questions"]),
  state: z.string(),
  /** The chosen option id for an approval card, for example "allow" or "deny". */
  answer: z.string().nullable().optional(),
  /** Question answers, stored shape from Switch: `{question_id, selected_option_ids, custom_text}`. */
  answers: z.array(z.record(z.unknown())).nullable().optional(),
  /**
   * A participant id for an answer given on a chat platform. An answer given from Switch Console or
   * the web is recorded as `user:<switchUserId>` instead: match that against `switchUserId`.
   */
  answeredBy: z.string().nullable().optional(),
  answeredAtMs: z.number().nullable().optional(),
});
export type ApprovalOutcomeEvent = z.infer<typeof ApprovalOutcomeEventSchema>;

// ── Ports: core depends on these interfaces, main.ts wires real implementations ──

export type CardOption = {
  id: string;
  label: string;
  description?: string;
  /**
   * What choosing it means to Switch: how the button is styled and what a typed "A12 yes" or "A12 no"
   * resolves to. Optional: `allow`/`approve`/`yes` read as accept, `deny`/`reject`/`no` as decline, and
   * anything else as cancel, which only a press or a typed number can reach.
   */
  decision?: "accept" | "acceptForSession" | "decline" | "cancel";
};
export type CardQuestion = {
  id: string;
  title: string;
  prompt: string;
  options: { id: string; label: string; description?: string }[];
  multiSelect: boolean;
  allowCustomAnswer: boolean;
};

export type OpenCardInput = {
  roomId: string;
  threadId?: string;
  kind: "approval" | "questions";
  /** At most 500 characters. */
  title: string;
  /**
   * Switch accepts 4000 characters, but on Mattermost a card over budget loses its buttons and can't be
   * answered from chat. Measured live, counting the zero-width space Switch adds after each @ and ]: up
   * to 998 with `mentionMessageId` (or an owner in the room), and only up to 966 without, because then
   * the card also carries a "notified no one" sentence.
   */
  detail: string;
  options: CardOption[];
  questions: CardQuestion[];
  expiresAtMs?: number;
  /**
   * Makes opening idempotent: the same id with the same content returns the card that exists, rather
   * than posting another. Without it each call opens a new card.
   */
  requestId?: string;
  /**
   * A message someone sent in this room. Switch names its sender at the top of the card, which is what
   * notifies them. Without it, it names the agent's owner if they are in the room; otherwise the card
   * says it notified no one, and that sentence takes budget from `detail` (see OpenCardInput.detail).
   */
  mentionMessageId?: string;
};

export type OpenCardResult = {
  sessionId: string;
  switchRequestId: string;
  /** Short answer handle shown to people, for example "A12", when Switch gives one. */
  handle?: string;
};

/** Everything core needs from Switch. Implemented by packages/switch-agent, faked in tests. */
export interface ChatPort {
  openCard(input: OpenCardInput): Promise<OpenCardResult>;
  closeCard(sessionId: string, switchRequestId: string): Promise<void>;
  postMessage(input: { roomId: string; body: string; threadId?: string }): Promise<{ messageId?: string }>;
  /** Addressed message to specific participants, for agent notifications and escalations. */
  sendTargeted(input: { roomId: string; body: string; targets: string[]; threadId?: string }): Promise<void>;
  /** The direct room between Clearance and one person. Created on first use. */
  ensureDirectRoom(person: { userName: string }): Promise<{ roomId: string }>;
  /** Create or update a room document that Clearance owns. */
  upsertDocument(input: { roomId: string; name: string; content: string }): Promise<void>;
  /**
   * How many rooms this agent belongs to, or has a live session in, that Clearance isn't in. Someone could be
   * asking it for things there, out of sight. Throws if Switch can't say. Optional: a port with no way to ask
   * has nothing to report.
   */
  unseenRoomCount?(agentName: string): Promise<number>;
}

/** Execute-on-approval and custody live in the gate. Core asks; the gate does exactly the stored call. */
export const ExecuteResultSchema = z.object({
  ok: z.boolean(),
  /** True when this request was already executed earlier; `result` is the original result. */
  alreadyExecuted: z.boolean().default(false),
  status: z.number().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type ExecuteResult = z.infer<typeof ExecuteResultSchema>;

export interface GatePort {
  /** POST /internal/execute/:requestId on the gate. Refuses when call_hash does not match the stored call. */
  execute(requestId: string, callHash: string): Promise<ExecuteResult>;
}

/** Read-only systems of record, reached through the gate because only the gate holds credentials. */
export interface LookupPort {
  /** kinds: orders, customers, destinations, ci, github, services. Null means not found. */
  lookup(kind: string, id: string): Promise<Record<string, unknown> | null>;
}

/** Scaled clock: `CLEARANCE_TIME_SCALE=10` makes policy durations ten times shorter in real time. */
export interface Clock {
  nowMs(): number;
  /** Real milliseconds for a policy duration, after scaling. */
  scaledMs(policyMs: number): number;
}

// ── Gate <-> core internal HTTP ──────────────────────────────────────────────

/** The gate's stored call. Hashing it (see canonicalCall) gives call_hash. */
export const CanonicalCallSchema = z.object({
  class: z.string(),
  target: z.string(),
  args: z.record(z.unknown()),
});
export type CanonicalCall = z.infer<typeof CanonicalCallSchema>;

/** Sorted-key JSON, the canonical serialisation for call_hash and ledger entries. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .filter((key) => input[key] !== undefined)
        .map((key) => [key, sortKeys(input[key])]),
    );
  }
  return value;
}

// ── Ports (TCP) ──────────────────────────────────────────────────────────────

export const DEFAULT_PORTS = { core: 7700, gate: 7710, acme: 7800, desk: 7900 } as const;

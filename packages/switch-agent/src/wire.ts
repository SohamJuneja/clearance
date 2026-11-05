/**
 * What Switch sends, parsed at the boundary, and how it maps onto the shared contracts.
 * Shapes come from the pinned commit's protocol code and from frames recorded off a live stack
 * (test/fixtures/). Fields the client does not use pass through untouched.
 */
import {
  ApprovalOutcomeEventSchema,
  ChatMessageEventSchema,
  type ApprovalOutcomeEvent,
  type ChatMessageEvent,
} from "@clearance/contracts";
import { z } from "zod";

/**
 * Revision 4 is the first to receive `approval_outcome` at all, and only on a `scope=all` stream: a
 * client that declares nothing connects fine and never hears an answer. Revision 9 tracks a position
 * per source, which is what lets `filter=all` resume across several rooms.
 */
export const PROTOCOL_REVISION = 9;

export const PositionSchema = z.record(z.number().int().nonnegative());
export type Position = z.infer<typeof PositionSchema>;

export const ConnectionStateSchema = z
  .object({
    connection_id: z.string(),
    agent_id: z.string(),
    generation: z.number().int(),
    scope: z.string(),
    filter: z.string(),
    rooms: z.array(z.string()),
    position: PositionSchema.default({}),
    protocol: z.number().int(),
    heartbeat_interval_seconds: z.number().positive(),
  })
  .passthrough();
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

const EnvelopeSchema = z
  .object({
    room_id: z.string(),
    bridge_id: z.string().nullish(),
    channel_type: z.string().nullish(),
    sequence: z.number().int().optional(),
    position: PositionSchema.optional(),
  })
  .passthrough();

export const MessageFrameSchema = EnvelopeSchema.extend({
  type: z.literal("message"),
  payload: z
    .object({
      addressed: z.boolean(),
      sender: z.string(),
      sender_name: z.string().optional(),
      sender_kind: z.string().nullish(),
      /** The display name of the person a platform message speaks for. Not a participant id. */
      on_behalf_of: z.string().nullish(),
      message_id: z.string(),
      body: z.string(),
      timestamp: z.number(),
      thread_id: z.string().nullish(),
    })
    .passthrough(),
});
export type MessageFrame = z.infer<typeof MessageFrameSchema>;

export const CommandFrameSchema = EnvelopeSchema.extend({
  type: z.literal("command"),
  payload: z
    .object({
      command: z.string(),
      args: z.string().default(""),
      user_id: z.string(),
      user_name: z.string(),
      thread_id: z.string().nullish(),
    })
    .passthrough(),
});
export type CommandFrame = z.infer<typeof CommandFrameSchema>;

export const RoomJoinFrameSchema = EnvelopeSchema.extend({
  type: z.literal("room_join"),
  payload: z
    .object({
      member: z.string(),
      member_name: z.string(),
      timestamp: z.number(),
      listening: z.boolean(),
    })
    .passthrough(),
});
export type RoomJoinFrame = z.infer<typeof RoomJoinFrameSchema>;

/** The one frame with no `type` and no room: it names the request, and its host knows the rest. */
export const ApprovalOutcomeFrameSchema = z
  .object({
    session_id: z.string(),
    request_id: z.string(),
    kind: z.enum(["approval", "questions"]),
    state: z.string(),
    answer: z.string().nullish(),
    answers: z.array(z.record(z.unknown())).nullish(),
    answered_by: z.string().nullish(),
    answered_at: z.string().nullish(),
  })
  .passthrough();
export type ApprovalOutcomeFrame = z.infer<typeof ApprovalOutcomeFrameSchema>;

export const GapFrameSchema = z
  .object({ from_sequence: z.number().optional(), resumed_at: z.number().optional(), reason: z.string() })
  .passthrough();
export type GapFrame = z.infer<typeof GapFrameSchema>;

export const EvictedFrameSchema = z
  .object({ code: z.string().optional(), reason: z.string(), room_id: z.string().nullish() })
  .passthrough();
export type EvictedFrame = z.infer<typeof EvictedFrameSchema>;

export const SubscriptionChangedFrameSchema = z
  .object({ rooms: z.array(z.string()), reason: z.string().optional() })
  .passthrough();

export const RoomReleasedFrameSchema = z
  .object({ room_id: z.string(), session_id: z.string().nullish() })
  .passthrough();

/** A request as the approvals routes return it. Note the camelCase, unlike every other route. */
export const ApprovalViewSchema = z
  .object({
    sessionId: z.string(),
    requestId: z.string(),
    kind: z.enum(["approval", "questions"]),
    state: z.string(),
    answer: z.string().nullish(),
    answers: z.array(z.record(z.unknown())).nullish(),
    answeredBy: z.string().nullish(),
    answeredAt: z.string().nullish(),
    expiresAt: z.string().nullish(),
    deliveredAt: z.string().nullish(),
  })
  .passthrough();
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;

export function toChatMessageEvent(frame: MessageFrame): ChatMessageEvent {
  const { payload } = frame;
  return ChatMessageEventSchema.parse({
    roomId: frame.room_id,
    threadId: payload.thread_id ?? null,
    messageId: payload.message_id,
    sender: payload.sender,
    senderName: payload.sender_name,
    senderKind: payload.sender_kind ?? undefined,
    onBehalfOf: payload.on_behalf_of ?? null,
    addressed: payload.addressed,
    body: payload.body,
    timestampMs: payload.timestamp,
    channelType: frame.channel_type ?? null,
  });
}

export function toApprovalOutcomeEvent(frame: ApprovalOutcomeFrame): ApprovalOutcomeEvent {
  const answeredAtMs = frame.answered_at ? Date.parse(frame.answered_at) : null;
  return ApprovalOutcomeEventSchema.parse({
    sessionId: frame.session_id,
    switchRequestId: frame.request_id,
    kind: frame.kind,
    state: frame.state,
    answer: frame.answer ?? null,
    answers: frame.answers ?? null,
    answeredBy: frame.answered_by ?? null,
    answeredAtMs: answeredAtMs !== null && Number.isFinite(answeredAtMs) ? answeredAtMs : null,
  });
}

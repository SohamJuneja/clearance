/** Every recorded frame must parse, and map onto the shared contracts, exactly as core will read it. */
import { ApprovalOutcomeEventSchema, ChatMessageEventSchema } from "@clearance/contracts";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ApprovalOutcomeFrameSchema,
  ApprovalViewSchema,
  CommandFrameSchema,
  ConnectionStateSchema,
  EvictedFrameSchema,
  GapFrameSchema,
  MessageFrameSchema,
  toApprovalOutcomeEvent,
  toChatMessageEvent,
} from "../src/wire.js";
import { fixture } from "./helpers.js";

const message = (name: string) => toChatMessageEvent(MessageFrameSchema.parse(fixture(name)));
const outcome = (name: string) => toApprovalOutcomeEvent(ApprovalOutcomeFrameSchema.parse(fixture(name)));

describe("message frames recorded from a live stack", () => {
  it("shows Clearance who addressed another agent, unaddressed to Clearance", () => {
    const event = message("message_other_agent_addressed");
    expect(ChatMessageEventSchema.safeParse(event).success).toBe(true);
    expect(event.addressed).toBe(false);
    expect(event.sender).toMatch(/^@switch-mattermost-.*-priya:localhost$/);
    expect(event.senderName).toBe("priya");
    expect(event.body).toBe("@spike-worker refund order A-1931");
    expect(event.threadId).toBeNull();
    expect(event.onBehalfOf).toBeNull();
    expect(event.channelType).toBe("channel_private");
    expect(event.roomId).toEqual(expect.any(String));
    expect(event.messageId).toMatch(/^sw_/);
    expect(event.timestampMs).toBeGreaterThan(1_000_000_000_000);
  });

  it("carries the thread root on a threaded message", () => {
    const event = message("message_in_thread");
    expect(event.threadId).toMatch(/^sw_/);
    expect(event.threadId).not.toBe(event.messageId);
    expect(event.senderName).toBe("alex");
  });

  it("marks a message to this agent as addressed", () => {
    expect(message("message_addressed_to_me").addressed).toBe(true);
  });

  it("addresses every message in a direct room without a mention", () => {
    const event = message("message_direct_room");
    expect(event.channelType).toBe("direct");
    expect(event.addressed).toBe(true);
    expect(event.body).toBe("hello");
  });

  it("names the person behind a template's kickoff by display name, with the platform as sender", () => {
    const event = message("message_platform_kickoff");
    expect(event.senderKind).toBe("platform");
    expect(event.sender).toBe("@switch-admin:localhost");
    expect(event.senderName).toBe("alex");
    expect(event.onBehalfOf).toBe("alex");
    expect(event.addressed).toBe(true);
  });

  it("reads an agent's message like anyone else's, with no human kind to lean on", () => {
    const event = message("message_from_agent");
    expect(event.senderName).toBe("spike-worker");
    expect(event.sender).toMatch(/^@switch-agent-/);
  });
});

describe("approval_outcome frames recorded from a live stack", () => {
  it("names the answerer by participant id", () => {
    const event = outcome("approval_outcome_answered");
    expect(ApprovalOutcomeEventSchema.safeParse(event).success).toBe(true);
    expect(event.kind).toBe("approval");
    expect(event.state).toBe("answered");
    expect(event.answer).toBe("allow");
    expect(event.answeredBy).toMatch(/^@switch-mattermost-.*-sam:localhost$/);
    expect(event.answeredAtMs).toBeGreaterThan(1_000_000_000_000);
    expect(event.answers).toBeNull();
  });

  it("gives question answers in the stored snake_case shape", () => {
    const event = outcome("approval_outcome_questions");
    expect(event.kind).toBe("questions");
    expect(event.answer).toBeNull();
    expect(event.answers).toEqual([{ question_id: "amount", custom_text: "40000", selected_option_ids: [] }]);
  });

  it("reports an expiry with nobody having answered", () => {
    const event = outcome("approval_outcome_expired");
    expect(event.state).toBe("expired");
    expect(event.answeredBy).toBeNull();
    expect(event.answeredAtMs).toBeNull();
  });
});

describe("other frames recorded from a live stack", () => {
  it("parses connection_state and reads the server's own statements", () => {
    const state = ConnectionStateSchema.parse(fixture("connection_state"));
    expect(state.scope).toBe("all");
    expect(state.filter).toBe("all");
    expect(state.protocol).toBe(9);
    expect(state.heartbeat_interval_seconds).toBeGreaterThan(0);
    expect(state.generation).toEqual(expect.any(Number));
  });

  it("parses a command event", () => {
    const frame = CommandFrameSchema.parse(fixture("command"));
    expect(frame.payload.command).toBe("reset");
    expect(frame.payload.user_name).toBe("alex");
    expect(frame.payload.user_id).toMatch(/^@switch-mattermost-/);
  });

  it("parses the open card view, whose fields are camelCase unlike the rest", () => {
    const view = ApprovalViewSchema.parse(fixture("approval_view_open"));
    expect(view.state).toBe("open");
    expect(view.requestId).toEqual(expect.any(String));
  });

  it("parses gap and evicted control frames", () => {
    expect(GapFrameSchema.parse(fixture("gap")).reason).toContain("restarted");
    expect(EvictedFrameSchema.parse(fixture("evicted_taken_over")).code).toBe("taken_over");
  });
});

describe("the fixtures themselves", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

  it("hold nothing that looks like a credential", () => {
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text, file).not.toMatch(/api_key|apiKey|password|authorization|bearer/i);
    }
  });
});

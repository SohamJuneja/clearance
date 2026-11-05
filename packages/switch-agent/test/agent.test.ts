import type { ApprovalOutcomeEvent, ChatMessageEvent } from "@clearance/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSwitchAgent, roomSessionId, SwitchApiError, type SwitchAgent, type SwitchAgentConfig, type SwitchAgentHandlers } from "../src/agent.js";
import { AGENT_ID, API_KEY, FakeSwitch, fixture, frame, quietLogger, until } from "./helpers.js";

const STATE = { ...frame("connection_state"), generation: 7 };

const running: SwitchAgent[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((agent) => agent.stop()));
});

function setup(config: Partial<SwitchAgentConfig> = {}) {
  const server = new FakeSwitch();
  const logger = quietLogger();
  const agent = createSwitchAgent({
    bridgeUrl: "http://switch.test/",
    agentId: AGENT_ID,
    apiKey: API_KEY,
    fetch: server.fetch,
    logger,
    heartbeatMs: 20,
    reconnectDelayMs: { first: 5, max: 20 },
    outcomeRetryMs: 5,
    ...config,
  });
  running.push(agent);
  return { server, agent, logger };
}

async function started(config: Partial<SwitchAgentConfig> = {}, handlers: SwitchAgentHandlers = {}) {
  const context = setup(config);
  const ready = context.agent.start(handlers);
  const stream = await context.server.stream(0);
  stream.send("connection_state", STATE);
  await ready;
  return { ...context, stream };
}

describe("the stream", () => {
  it("opens scope=all&filter=all and declares the revision that receives outcomes", async () => {
    const { server, stream, agent } = await started();
    expect(server.calls[0]!.path).toBe(`/agents/${AGENT_ID}/events`);
    expect(stream.query.get("scope")).toBe("all");
    expect(stream.query.get("filter")).toBe("all");
    expect(stream.query.get("connection_id")).toBe(agent.connectionId);
    expect(stream.query.get("start_at")).toBe("head");
    expect(Number(stream.query.get("protocol"))).toBeGreaterThanOrEqual(4);
    expect(stream.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(stream.headers.accept).toBe("text/event-stream");
  });

  it("hands core a typed message from a real frame", async () => {
    const seen: ChatMessageEvent[] = [];
    const { stream } = await started({}, { message: (event) => void seen.push(event) });
    stream.send("message", fixture("message_other_agent_addressed"));
    await until("the message", () => seen.length === 1);
    expect(seen[0]!.senderName).toBe("priya");
    expect(seen[0]!.addressed).toBe(false);
  });

  it("keeps events in arrival order across a slow handler", async () => {
    const order: string[] = [];
    const { stream } = await started(
      {},
      {
        message: async () => {
          await new Promise((done) => setTimeout(done, 20));
          order.push("message");
        },
        approvalOutcome: () => void order.push("outcome"),
      },
    );
    stream.send("message", fixture("message_in_thread"));
    stream.send("approval_outcome", fixture("approval_outcome_answered"));
    await until("both", () => order.length === 2);
    expect(order).toEqual(["message", "outcome"]);
  });

  it("drops a malformed frame loudly and carries on", async () => {
    const seen: ChatMessageEvent[] = [];
    const { stream, logger } = await started({}, { message: (event) => void seen.push(event) });
    stream.send("message", { type: "message", room_id: "r", payload: { sender: "no body" } });
    stream.raw("event: message\ndata: {not json\n\n");
    stream.send("message", fixture("message_in_thread"));
    await until("the good message", () => seen.length === 1);
    expect(logger.lines.filter((line) => line.includes("dropped"))).toHaveLength(2);
  });

  it("ignores frames it has no use for", async () => {
    const seen: ChatMessageEvent[] = [];
    const { stream } = await started({}, { message: (event) => void seen.push(event) });
    stream.send("session_command", fixture("session_command"));
    stream.send("subscription_changed", { rooms: [], reason: "subscription updated" });
    stream.send("message", fixture("message_in_thread"));
    await until("the message", () => seen.length === 1);
  });
});

describe("resuming from an earlier run", () => {
  it("opens at the saved position, so what was said while it was down is delivered", async () => {
    const saved = { s: 12, "r:room-a": 40 };
    const { stream } = await started({ initialPosition: saved });
    expect(JSON.parse(stream.query.get("start_at")!)).toEqual(saved);
    expect(stream.query.get("expected_generation")).toBeNull();
  });

  it("hands each message its own position, to save once it is handled", async () => {
    const seen: unknown[] = [];
    const { stream } = await started({}, { message: (_event, meta) => void seen.push(meta.position) });
    stream.send("message", { ...frame("message_in_thread"), position: { "r:room-a": 21 } });
    await until("the message", () => seen.length === 1);
    expect(seen).toEqual([{ "r:room-a": 21 }]);
  });
});

describe("the heartbeat", () => {
  it("beats with the connection id and the incarnation", async () => {
    const { server, agent } = await started();
    await until("two beats", () => server.paths("/connection/beat").length >= 2);
    expect(server.paths("/connection/beat")[0]!.json).toEqual({ connection_id: agent.connectionId, generation: 7 });
  });

  it("beats at most 2 s apart however long the server says it may wait", async () => {
    const { server } = await started({ heartbeatMs: undefined });
    // STATE states 10 s. One beat on open, and the next is not 10 s away.
    await until("the first beat", () => server.paths("/connection/beat").length === 1);
    await until("the second beat", () => server.paths("/connection/beat").length === 2, 2500);
  }, 4000);

  it.each([
    ["404 unknown", 404, "beat_unknown"],
    ["409 no_stream", 409, "beat_no_stream"],
    ["409 unfenced", 409, "beat_unfenced"],
  ])("reopens on %s with the same connection id", async (_label, status, name) => {
    const { server, agent } = await started();
    server.reply("POST", `/agents/${AGENT_ID}/connection/beat`, { status, body: fixture<{ body: unknown }>(name).body });
    const reopened = await server.stream(1);
    expect(reopened.query.get("connection_id")).toBe(agent.connectionId);
  });

  it("does not reopen on taken_over, which would take it straight back", async () => {
    const lost: string[] = [];
    const { server } = await started({}, { takenOver: (reason) => void lost.push(reason) });
    server.reply("POST", `/agents/${AGENT_ID}/connection/beat`, {
      status: 409,
      body: fixture<{ body: unknown }>("beat_taken_over").body,
    });
    await until("the stop", () => lost.length === 1);
    await new Promise((done) => setTimeout(done, 50));
    expect(server.streams).toHaveLength(1);
  });
});

describe("reconnecting", () => {
  it("resumes from the furthest position seen, with the same id and incarnation", async () => {
    const { server, stream, agent } = await started();
    stream.send("message", { ...frame("message_in_thread"), position: { "r:room-a": 21 } });
    stream.send("message", { ...frame("message_addressed_to_me"), position: { s: 5_000_000_000 } });
    await new Promise((done) => setTimeout(done, 20));
    stream.end();
    const reopened = await server.stream(1);
    expect(reopened.query.get("connection_id")).toBe(agent.connectionId);
    expect(reopened.query.get("expected_generation")).toBe("7");
    const position = JSON.parse(reopened.query.get("start_at")!) as Record<string, number>;
    expect(position["r:room-a"]).toBe(21);
    expect(position.s).toBe(5_000_000_000);
  });

  it("keeps trying while the server refuses", async () => {
    const { server, stream } = await started();
    server.refuseOpens.push({ status: 503, body: { detail: "starting" } }, { status: 503, body: { detail: "starting" } });
    stream.end();
    const reopened = await server.stream(1);
    expect(reopened.closed).toBe(false);
    expect(server.paths("/events")).toHaveLength(4);
  });

  it("reopens when evicted for anything but a takeover", async () => {
    const { server, stream } = await started();
    stream.send("evicted", { code: "heartbeat_lapsed", reason: "lapsed", room_id: null });
    await server.stream(1);
  });

  it("stops for good when evicted by a takeover", async () => {
    const lost: string[] = [];
    const { server, stream } = await started({}, { takenOver: (reason) => void lost.push(reason) });
    stream.send("evicted", fixture("evicted_taken_over"));
    await until("the stop", () => lost.length === 1);
    await new Promise((done) => setTimeout(done, 40));
    expect(server.streams).toHaveLength(1);
  });

  it("stops for good when a reopen is refused as taken over", async () => {
    const lost: string[] = [];
    const { server, stream } = await started({}, { takenOver: (reason) => void lost.push(reason) });
    server.refuseOpens.push({ status: 409, body: { detail: { code: "taken_over", message: "another client holds it" } } });
    stream.end();
    await until("the stop", () => lost.length === 1);
    expect(server.streams).toHaveLength(1);
  });

  it("reports a gap, adopts where the stream resumed, and stays connected", async () => {
    const gaps: unknown[] = [];
    const { server, stream } = await started({}, { gap: (frame) => void gaps.push(frame) });
    stream.send("message", { ...frame("message_addressed_to_me"), position: { s: 5000 } });
    stream.send("gap", { ...frame("gap"), resumed_position: { s: 12 } });
    await until("the gap", () => gaps.length === 1);
    stream.end();
    const reopened = await server.stream(1);
    expect(JSON.parse(reopened.query.get("start_at")!)).toEqual({ s: 12 });
  });

  it("reopens a stream that has gone silent", async () => {
    const { server } = await started({ idleTimeoutMs: 30 });
    await server.stream(1);
  });
});

describe("starting", () => {
  it("fails loudly on a key Switch refuses, without the key in the message", async () => {
    const { server, agent } = setup();
    server.refuseOpens.push({ status: 401, body: { detail: "Invalid API key" } });
    const error = await agent.start().catch((failure: Error) => failure);
    expect((error as Error).message).toContain("401");
    expect((error as Error).message).not.toContain(API_KEY);
    expect(server.streams).toHaveLength(0);
  });

  it("fails loudly on a protocol range Switch will not speak", async () => {
    const { server, agent } = setup();
    server.refuseOpens.push({ status: 409, body: { detail: { message: "no overlap", contract: "agent-protocol" } } });
    await expect(agent.start()).rejects.toThrow("409");
  });
});

describe("operations", () => {
  it("posts the arguments unwrapped, with the connection id header, and returns the result", async () => {
    const { server, agent } = await started();
    server.reply("POST", `/agents/${AGENT_ID}/ops/list_rooms`, { status: 200, body: { result: [{ room_id: "r1" }] } });
    const rooms = await agent.op<{ room_id: string }[]>("list_rooms", { include_archived: true });
    expect(rooms).toEqual([{ room_id: "r1" }]);
    const call = server.paths("/ops/list_rooms")[0]!;
    expect(call.json).toEqual({ include_archived: true });
    expect(call.headers["x-switch-connection-id"]).toBe(agent.connectionId);
    expect(call.headers["x-switch-session-id"]).toBeUndefined();
  });

  it("raises Switch's refusal with its status and words", async () => {
    const { server, agent } = await started();
    server.reply("POST", `/agents/${AGENT_ID}/ops/create_room`, {
      status: 400,
      body: { detail: "Failed to create room: Mattermost cannot create DM channels" },
    });
    const error = await agent.op("create_room", {}).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SwitchApiError);
    expect((error as SwitchApiError).status).toBe(400);
    expect((error as SwitchApiError).message).toContain("Mattermost cannot create DM channels");
    expect((error as SwitchApiError).message).not.toContain(API_KEY);
  });

  it("places a session in the room rather than claiming it from another connection", async () => {
    const { server, agent } = await started();
    await agent.op("post_message", { body: "hi" }, { roomId: "room-a" });
    const placement = server.paths("/connection/placements")[0]!;
    expect(placement.json).toEqual({
      connection_id: agent.connectionId,
      generation: 7,
      placements: { [roomSessionId("room-a")]: "room-a" },
    });
    const call = server.paths("/ops/post_message")[0]!;
    expect(call.headers["x-switch-connection-id"]).toBe(agent.connectionId);
    expect(call.headers["x-switch-session-id"]).toBe(roomSessionId("room-a"));
    expect(server.paths("/connection/subscribe")).toHaveLength(0);
  });

  it("states every room each time, because a placement replaces the whole set", async () => {
    const { server, agent } = await started();
    await agent.op("post_message", { body: "1" }, { roomId: "room-a" });
    await agent.op("post_message", { body: "2" }, { roomId: "room-a" });
    await agent.op("post_message", { body: "3" }, { roomId: "room-b" });
    const placements = server.paths("/connection/placements");
    expect(placements).toHaveLength(2);
    expect(placements[1]!.json).toMatchObject({
      placements: { [roomSessionId("room-a")]: "room-a", [roomSessionId("room-b")]: "room-b" },
    });
  });

  it("says its rooms again after a reopen", async () => {
    const { server, agent, stream } = await started();
    await agent.op("post_message", { body: "1" }, { roomId: "room-a" });
    stream.end();
    const reopened = await server.stream(1);
    reopened.send("connection_state", { ...STATE, generation: 8 });
    await until("the restated placement", () => server.paths("/connection/placements").length === 2);
    expect(server.paths("/connection/placements")[1]!.json).toMatchObject({
      generation: 8,
      placements: { [roomSessionId("room-a")]: "room-a" },
    });
  });

  it("places again and retries once when Switch has forgotten the room", async () => {
    const { server, agent } = await started();
    let attempts = 0;
    server.reply("POST", `/agents/${AGENT_ID}/ops/post_message`, () => {
      attempts += 1;
      return attempts === 1
        ? { status: 400, body: { detail: "Not connected to a room. Call connect_to_room first." } }
        : { status: 200, body: { result: { event_id: "sw_1" } } };
    });
    const result = await agent.op<{ event_id: string }>("post_message", { body: "x" }, { roomId: "room-a" });
    expect(result.event_id).toBe("sw_1");
    expect(server.paths("/connection/placements")).toHaveLength(2);
  });

  it("refuses a room Switch will not place the agent in", async () => {
    const { server, agent } = await started();
    server.reply("POST", `/agents/${AGENT_ID}/connection/placements`, {
      status: 200,
      body: { ok: true, refused: [{ room_id: "gone", reason: "not a member" }] },
    });
    await expect(agent.op("post_message", { body: "x" }, { roomId: "gone" })).rejects.toThrow("not a member");
    expect(server.paths("/ops/post_message")).toHaveLength(0);
  });

  it("refuses to run before it has started", async () => {
    const { agent } = setup();
    await expect(agent.op("list_rooms")).rejects.toThrow("not started");
  });

  it("sends a plain message with no connection involved", async () => {
    const { server, agent } = await started();
    server.reply("POST", `/agents/${AGENT_ID}/message`, { status: 200, body: { ok: true, event_id: "sw_2" } });
    await expect(agent.sendMessage("room-a", "hello")).resolves.toEqual({ eventId: "sw_2" });
    const call = server.paths("/message")[0]!;
    expect(call.json).toEqual({ room_id: "room-a", content: "hello" });
    expect(call.headers["x-switch-connection-id"]).toBeUndefined();
  });
});

describe("approvals", () => {
  const body = {
    session_id: "s 1",
    request_id: "r/1",
    turn_id: "t1",
    kind: "approval" as const,
    title: "title",
    detail: null,
    options: [{ id: "allow", label: "Allow", decision: "accept" as const }],
    questions: [],
    room_id: "room-a",
    thread_id: null,
    expires_at: null,
  };

  it("opens with every field the route insists on, and the session in the path", async () => {
    const { server, agent } = await started();
    server.reply("POST", "/agent-sessions/s%201/approvals", { status: 200, body: fixture("approval_view_open") });
    const view = await agent.openApproval(body);
    expect(view.state).toBe("open");
    const call = server.paths("/approvals")[0]!;
    expect(call.json).toEqual({
      request_id: "r/1",
      turn_id: "t1",
      kind: "approval",
      title: "title",
      detail: null,
      options: [{ id: "allow", label: "Allow", decision: "accept" }],
      questions: [],
      room_id: "room-a",
      thread_id: null,
      expires_at: null,
    });
  });

  it("closes by session and request, escaped", async () => {
    const { server, agent } = await started();
    server.reply("POST", "/agent-sessions/s%201/approvals/r%2F1/close", {
      status: 200,
      body: { ...frame("approval_view_open"), state: "closed" },
    });
    await expect(agent.closeApproval("s 1", "r/1")).resolves.toMatchObject({ state: "closed" });
  });

  it("acknowledges an outcome only after core has it", async () => {
    const steps: string[] = [];
    const frame = fixture<{ session_id: string; request_id: string }>("approval_outcome_answered");
    const { server, stream } = await started(
      {},
      {
        approvalOutcome: async (event: ApprovalOutcomeEvent) => {
          await new Promise((done) => setTimeout(done, 20));
          expect(server.paths("/delivered")).toHaveLength(0);
          steps.push(event.answer ?? "");
        },
      },
    );
    stream.send("approval_outcome", frame);
    await until("the ack", () => server.paths("/delivered").length === 1);
    expect(steps).toEqual(["allow"]);
    expect(server.paths("/delivered")[0]!.path).toBe(
      `/agent-sessions/${encodeURIComponent(frame.session_id)}/approvals/${encodeURIComponent(frame.request_id)}/delivered`,
    );
  });

  it("does not acknowledge while core is failing, and retries until it can", async () => {
    let calls = 0;
    const { server, stream } = await started(
      {},
      {
        approvalOutcome: () => {
          calls += 1;
          if (calls < 3) throw new Error("database is locked");
        },
      },
    );
    stream.send("approval_outcome", fixture("approval_outcome_answered"));
    await until("the ack", () => server.paths("/delivered").length === 1);
    expect(calls).toBe(3);
  });

  it("does not hand core the same outcome twice when Switch offers it again", async () => {
    let calls = 0;
    const { server, stream } = await started({}, { approvalOutcome: () => void calls++ });
    stream.send("approval_outcome", fixture("approval_outcome_answered"));
    stream.send("approval_outcome", fixture("approval_outcome_answered"));
    await until("both acks", () => server.paths("/delivered").length === 2);
    expect(calls).toBe(1);
  });

  it("retries the ack alone when only the ack failed", async () => {
    let calls = 0;
    let acks = 0;
    const { server, stream } = await started({}, { approvalOutcome: () => void calls++ });
    server.on((call) => {
      if (!call.path.endsWith("/delivered")) return undefined;
      acks += 1;
      return acks === 1 ? { status: 503, body: { detail: "busy" } } : { status: 200, body: fixture("approval_view_open") };
    });
    stream.send("approval_outcome", fixture("approval_outcome_answered"));
    await until("the second ack", () => acks === 2);
    expect(calls).toBe(1);
  });

  it("reports a turn with no room, so Switch names its sender and draws no status post", async () => {
    const { server, agent } = await started();
    const occurredAt = new Date("2026-11-06T16:00:00.000Z");
    await agent.reportTurn("s 1", { turnId: "turn-1", messageId: "sw_hello", occurredAt });
    const call = server.paths("/activity")[0]!;
    expect(call.path).toBe("/agent-sessions/s%201/activity");
    expect(call.json).toEqual({
      turn_id: "turn-1",
      item_id: "turn",
      kind: "turn",
      revision: 0,
      status: "completed",
      title: "",
      text: "",
      command_id: null,
      room_id: null,
      thread_id: null,
      message_id: "sw_hello",
      occurred_at: "2026-11-06T16:00:00.000Z",
      usage: [],
    });
  });

  it("marks an outcome delivered and reads the undelivered list", async () => {
    const { server, agent } = await started();
    const view = { ...frame("approval_view_open"), state: "answered" };
    server.reply("GET", "/agent-sessions/approvals/outcomes", { status: 200, body: [view] });
    await expect(agent.undeliveredOutcomes()).resolves.toHaveLength(1);
  });
});

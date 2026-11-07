import type { ChatPort, OpenCardInput } from "@clearance/contracts";
import { describe, expect, it, vi } from "vitest";
import { roomSessionId, SwitchApiError, type OpenApprovalBody, type SwitchAgent } from "../src/agent.js";
import {
  createChatPort,
  createMattermostHandleResolver,
  directRoomName,
  fallbackRoomName,
  optionDecision,
  type ChatPortOptions,
} from "../src/chat-port.js";
import { registerAgent } from "../src/register.js";
import { fixture } from "./helpers.js";

type OpCall = { name: string; args: Record<string, unknown>; roomId?: string };

function fakeAgent(ops: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const opCalls: OpCall[] = [];
  const opened: OpenApprovalBody[] = [];
  const closed: [string, string][] = [];
  const sent: [string, string][] = [];
  const turns: { sessionId: string; turnId: string; messageId: string }[] = [];
  const agent = {
    connectionId: "conn",
    agentId: "agent-1",
    start: vi.fn(),
    stop: vi.fn(),
    async op(name: string, args: Record<string, unknown> = {}, opts: { roomId?: string } = {}) {
      opCalls.push({ name, args, roomId: opts.roomId });
      const handler = ops[name];
      if (!handler) throw new Error(`unexpected op ${name}`);
      return handler(args);
    },
    async sendMessage(roomId: string, content: string) {
      sent.push([roomId, content]);
      return { eventId: "sw_sent" };
    },
    async openApproval(body: OpenApprovalBody) {
      opened.push(body);
      return fixture("approval_view_open");
    },
    async closeApproval(sessionId: string, requestId: string) {
      closed.push([sessionId, requestId]);
      return fixture("approval_view_open");
    },
    markDelivered: vi.fn(),
    undeliveredOutcomes: vi.fn(),
    async reportTurn(sessionId: string, turn: { turnId: string; messageId: string }) {
      turns.push({ sessionId, turnId: turn.turnId, messageId: turn.messageId });
    },
  } as unknown as SwitchAgent;
  return { agent, opCalls, opened, closed, sent, turns };
}

function port(ops: Parameters<typeof fakeAgent>[0] = {}, options: ChatPortOptions = {}) {
  const fake = fakeAgent(ops);
  const warnings: string[] = [];
  const chat: ChatPort = createChatPort(fake.agent, { warn: (line) => warnings.push(line), ...options });
  return { ...fake, chat, warnings };
}

const approvalCard: OpenCardInput = {
  roomId: "room-a",
  kind: "approval",
  title: "CLR-0042 · REFUND ₹40,000 · HIGH",
  detail: "The call\n  Refund ₹40,000",
  options: [
    { id: "allow", label: "Allow" },
    { id: "deny", label: "Deny" },
  ],
  questions: [],
};

describe("optionDecision", () => {
  it.each([
    ["allow", "accept"],
    ["approve", "accept"],
    ["yes", "accept"],
    ["deny", "decline"],
    ["reject", "decline"],
    ["no", "decline"],
    ["ALLOW", "accept"],
  ])("reads %s as %s", (id, decision) => {
    expect(optionDecision({ id, label: id })).toBe(decision);
  });

  it("never lets a typed yes or no land on an option it cannot name", () => {
    expect(optionDecision({ id: "escalate", label: "Escalate" })).toBe("cancel");
  });

  it("prefers what the caller said", () => {
    expect(optionDecision({ id: "escalate", label: "x", decision: "decline" })).toBe("decline");
  });
});

describe("roomAliases", () => {
  it("asks Switch who's in the room, and gives back each alias, lower-cased, against the agent's real name", async () => {
    const calls: unknown[][] = [];
    const agent = {
      op: async (...args: unknown[]) => {
        calls.push(args);
        return [
          { id: "1", name: "refunds-agent", type: "agent", status: "online", alias: "TF" },
          { id: "2", name: "sam", type: "user", status: null, alias: null },
          { id: "3", name: "coder", type: "agent", status: null },
        ];
      },
    };
    const chat = createChatPort(agent as never);
    expect(await chat.roomAliases?.("room-1")).toEqual({ tf: "refunds-agent" });
    expect(calls).toEqual([["list_participants", {}, { roomId: "room-1" }]]);
  });
});

describe("roomRoles", () => {
  it("asks Switch for the room's roles, and gives back each one, lower-cased, with who holds it now", async () => {
    const calls: unknown[][] = [];
    const agent = {
      op: async (...args: unknown[]) => {
        calls.push(args);
        return [
          { name: "Merges", exclusive: true, assumable_by_me: false, held_by: [{ name: "coder", present_here: true, session_room: null }] },
          { name: "ops", exclusive: false, assumable_by_me: true, held_by: [] },
        ];
      },
    };
    const chat = createChatPort(agent as never);
    expect(await chat.roomRoles?.("room-1")).toEqual({ merges: ["coder"], ops: [] });
    expect(calls).toEqual([["list_roles", {}, { roomId: "room-1" }]]);
  });

  it("lets a Switch that can't answer throw, so core knows it can't say rather than hearing nobody holds it", async () => {
    const chat = createChatPort({ op: () => Promise.reject(new Error("down")) } as never);
    await expect(chat.roomRoles?.("room-1")).rejects.toThrow("down");
  });
});

describe("the handle resolver", () => {
  it("gives up on a stalled Mattermost within its own limit, however long the server would have waited", async () => {
    const agent = { op: async () => ({ external_channel_id: "ch-1" }) };
    const stalled = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const resolve = createMattermostHandleResolver({ agent: agent as never, mattermostUrl: "http://mm", token: "t", fetch: stalled, timeoutMs: 30, pollMs: 5 });
    const started = Date.now();
    await expect(resolve({ roomId: "room-1", title: "CLR-0001 · x", openedAtMs: started })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("openCard", () => {
  it("opens an approval with the fields Switch requires and reports where it lives", async () => {
    const { chat, opened } = port();
    // Within the 24 hours Switch allows. A later date is clamped: see "a card's lifetime".
    const soon = Date.now() + 3_600_000;
    const result = await chat.openCard({ ...approvalCard, threadId: "sw_thread", expiresAtMs: soon });
    const body = opened[0]!;
    expect(body.session_id).toBe(roomSessionId("room-a"));
    expect(body.request_id).toBe(result.switchRequestId);
    expect(body.turn_id).toEqual(expect.any(String));
    expect(body.kind).toBe("approval");
    expect(body.options).toEqual([
      { id: "allow", label: "Allow", decision: "accept" },
      { id: "deny", label: "Deny", decision: "decline" },
    ]);
    expect(body.questions).toEqual([]);
    expect(body.room_id).toBe("room-a");
    expect(body.thread_id).toBe("sw_thread");
    expect(body.expires_at).toBe(new Date(soon).toISOString());
    expect(result.sessionId).toBe(roomSessionId("room-a"));
    expect(result.handle).toBeUndefined();
  });

  it("uses a caller's request id, so opening again finds the same card", async () => {
    const { chat, opened } = port();
    const first = await chat.openCard({ ...approvalCard, requestId: "study-p01-X03" });
    const second = await chat.openCard({ ...approvalCard, requestId: "study-p01-X03" });
    expect(first.switchRequestId).toBe("study-p01-X03");
    expect(second.switchRequestId).toBe("study-p01-X03");
    expect(opened.map((body) => body.request_id)).toEqual(["study-p01-X03", "study-p01-X03"]);
    expect(opened[0]!.turn_id).toBe(opened[1]!.turn_id);
  });

  it("records a turn once for the message whose sender a card should name, before the card", async () => {
    const { chat, opened, turns } = port();
    await chat.openCard({ ...approvalCard, mentionMessageId: "sw_hello" });
    await chat.openCard({ ...approvalCard, mentionMessageId: "sw_hello" });
    expect(turns).toEqual([{ sessionId: roomSessionId("room-a"), turnId: "turn-sw_hello", messageId: "sw_hello" }]);
    expect(opened.map((body) => body.turn_id)).toEqual(["turn-sw_hello", "turn-sw_hello"]);
  });

  it("does not open a card whose mention could not be recorded", async () => {
    const { agent, opened } = fakeAgent();
    (agent as unknown as { reportTurn: () => Promise<void> }).reportTurn = async () => {
      throw new Error("Switch is down");
    };
    await expect(createChatPort(agent).openCard({ ...approvalCard, mentionMessageId: "sw_hello" })).rejects.toThrow("Switch is down");
    expect(opened).toHaveLength(0);
  });

  it("gives two cards two request ids", async () => {
    const { chat } = port();
    const first = await chat.openCard(approvalCard);
    const second = await chat.openCard(approvalCard);
    expect(first.switchRequestId).not.toBe(second.switchRequestId);
  });

  it("sends no expiry when none is given, and null detail when it is empty", async () => {
    const { chat, opened } = port();
    await chat.openCard({ ...approvalCard, detail: "" });
    expect(opened[0]!.expires_at).toBeNull();
    expect(opened[0]!.detail).toBeNull();
    expect(opened[0]!.thread_id).toBeNull();
  });

  it("folds an option's description into its label, the only place the wire has for it", async () => {
    const { chat, opened } = port();
    await chat.openCard({
      ...approvalCard,
      options: [{ id: "allow", label: "Allow", description: "runs once" }],
    });
    expect(opened[0]!.options[0]!.label).toBe("Allow: runs once");
  });

  it("maps a questions card to the snake_case the wire takes, with no options of its own", async () => {
    const { chat, opened } = port();
    await chat.openCard({
      roomId: "room-a",
      kind: "questions",
      title: "CLR-0051 is high risk",
      detail: "",
      options: [{ id: "ignored", label: "Ignored" }],
      questions: [
        {
          id: "amount",
          title: "Amount",
          prompt: "Type the refund amount in rupees to approve, or answer no.",
          options: [{ id: "no", label: "No" }],
          multiSelect: false,
          allowCustomAnswer: true,
        },
      ],
    });
    const body = opened[0]!;
    expect(body.options).toEqual([]);
    expect(body.questions).toEqual([
      {
        id: "amount",
        title: "Amount",
        prompt: "Type the refund amount in rupees to approve, or answer no.",
        options: [{ id: "no", label: "No", description: null }],
        multi_select: false,
        allow_custom_answer: true,
      },
    ]);
  });

  it("refuses over-long text rather than cutting evidence off a card", async () => {
    const { chat, opened } = port();
    await expect(chat.openCard({ ...approvalCard, title: "x".repeat(501) })).rejects.toThrow("at most 500");
    await expect(chat.openCard({ ...approvalCard, detail: "x".repeat(4001) })).rejects.toThrow("at most 4000");
    await expect(chat.openCard({ ...approvalCard, title: "   " })).rejects.toThrow("needs a title");
    expect(opened).toHaveLength(0);
  });

  it("returns the handle when it can be read", async () => {
    const { chat } = port({}, { resolveHandle: async () => "A12" });
    await expect(chat.openCard(approvalCard)).resolves.toMatchObject({ handle: "A12" });
  });

  it("still returns the card when the handle cannot be read", async () => {
    const { chat, warnings } = port(
      {},
      {
        resolveHandle: async () => {
          throw new Error("Mattermost answered 503");
        },
      },
    );
    const result = await chat.openCard(approvalCard);
    expect(result.switchRequestId).toEqual(expect.any(String));
    expect(result.handle).toBeUndefined();
    expect(warnings[0]).toContain("503");
  });
});

describe("a card whose first attempt got through", () => {
  const conflict = new SwitchApiError(409, "/agent-sessions/s/approvals", {
    code: "REQUEST_CONFLICT",
    message: "already opened with different content",
  });

  it("counts as open when Switch says this id is already open, since the id is ours and used once", async () => {
    const { chat, agent } = port();
    agent.openApproval = () => Promise.reject(conflict);
    const result = await chat.openCard({ ...approvalCard, requestId: "card-ours" });
    expect(result.switchRequestId).toBe("card-ours");
  });

  it("still fails without an id of ours, where a conflict can't be read that way", async () => {
    const { chat, agent } = port();
    agent.openApproval = () => Promise.reject(conflict);
    await expect(chat.openCard(approvalCard)).rejects.toThrow(/409/);
  });

  it("still fails on any other refusal", async () => {
    const { chat, agent } = port();
    agent.openApproval = () => Promise.reject(new SwitchApiError(409, "/x", { code: "SESSION_CLOSED" }));
    await expect(chat.openCard({ ...approvalCard, requestId: "card-ours" })).rejects.toThrow(/409/);
    agent.openApproval = () => Promise.reject(new SwitchApiError(500, "/x", { code: "REQUEST_CONFLICT" }));
    await expect(chat.openCard({ ...approvalCard, requestId: "card-ours" })).rejects.toThrow(/500/);
  });
});

describe("closeCard", () => {
  it("closes the card it is told to", async () => {
    const { chat, closed } = port();
    await chat.closeCard("session", "request");
    expect(closed).toEqual([["session", "request"]]);
  });
});

describe("postMessage", () => {
  it("uses the plain route at the top level", async () => {
    const { chat, sent, opCalls } = port();
    await expect(chat.postMessage({ roomId: "room-a", body: "hi" })).resolves.toEqual({ messageId: "sw_sent" });
    expect(sent).toEqual([["room-a", "hi"]]);
    expect(opCalls).toHaveLength(0);
  });

  it("uses the operation in a thread, which the plain route cannot do", async () => {
    const { chat, opCalls } = port({ post_message: () => ({ event_id: "sw_threaded" }) });
    const result = await chat.postMessage({ roomId: "room-a", body: "hi", threadId: "sw_root" });
    expect(result).toEqual({ messageId: "sw_threaded" });
    expect(opCalls[0]).toEqual({ name: "post_message", args: { body: "hi", thread_id: "sw_root" }, roomId: "room-a" });
  });
});

describe("sendTargeted", () => {
  const ok = () => ({ event_id: "sw", target_statuses: { "refunds-agent": "live" } });

  it("addresses by name, in the room, in the thread", async () => {
    const { chat, opCalls, warnings } = port({ send_targeted_message: ok });
    await chat.sendTargeted({ roomId: "room-a", body: "approved", targets: ["refunds-agent", "@sam"], threadId: "sw_root" });
    expect(opCalls[0]).toEqual({
      name: "send_targeted_message",
      args: { body: "approved", target_names: ["refunds-agent", "sam"], thread_id: "sw_root" },
      roomId: "room-a",
    });
    expect(warnings).toHaveLength(0);
  });

  it("turns a participant id into the name Switch needs", async () => {
    const id = "@switch-mattermost-b-sam:localhost";
    const { chat, opCalls } = port({ send_targeted_message: ok }, { participantNames: { [id]: "sam" } });
    await chat.sendTargeted({ roomId: "room-a", body: "x", targets: [id] });
    expect(opCalls[0]!.args.target_names).toEqual(["sam"]);
  });

  it("refuses a participant id it has no name for, rather than guess", async () => {
    const { chat, opCalls } = port({ send_targeted_message: ok });
    await expect(chat.sendTargeted({ roomId: "room-a", body: "x", targets: ["@nobody:localhost"] })).rejects.toThrow("No name known");
    expect(opCalls).toHaveLength(0);
  });

  it("says so when an agent will not wake for the message", async () => {
    const { chat, warnings } = port({
      send_targeted_message: () => ({ target_statuses: { "refunds-agent": "not_permitted" } }),
    });
    await chat.sendTargeted({ roomId: "room-a", body: "x", targets: ["refunds-agent"] });
    expect(warnings[0]).toContain("not_permitted");
  });
});

describe("ensureDirectRoom", () => {
  it("finds the direct room the person opened", async () => {
    const { chat, opCalls } = port({
      list_rooms: () => [{ room_id: "dm-1", name: directRoomName("sam", "clearance"), archived: false }],
      get_room_detail: () => ({ channel_type: "direct" }),
    });
    await expect(chat.ensureDirectRoom({ userName: "sam" })).resolves.toEqual({ roomId: "dm-1" });
    expect(opCalls.some((call) => call.name === "create_room")).toBe(false);
  });

  it("reopens an archived direct room rather than losing it", async () => {
    const { chat, opCalls } = port({
      list_rooms: () => [{ room_id: "dm-1", name: directRoomName("sam", "clearance"), archived: true }],
      get_room_detail: () => ({ channel_type: "direct" }),
      unarchive_room: () => ({ ok: true }),
    });
    await chat.ensureDirectRoom({ userName: "sam" });
    expect(opCalls.find((call) => call.name === "unarchive_room")?.args).toEqual({ room_id: "dm-1" });
  });

  it("falls back to a private room when no direct room exists, because Mattermost will not make one", async () => {
    const { chat, opCalls } = port({
      list_rooms: () => [],
      create_room: () => ({ id: "private-1" }),
    });
    await expect(chat.ensureDirectRoom({ userName: "neha" })).resolves.toEqual({ roomId: "private-1" });
    expect(opCalls.find((call) => call.name === "create_room")?.args).toMatchObject({
      name: fallbackRoomName("neha", "clearance"),
      agent_names: ["clearance"],
      user_names: ["neha"],
      channel_type: "channel_private",
    });
  });

  it("reuses a private room it made earlier", async () => {
    const { chat, opCalls } = port({
      list_rooms: () => [{ room_id: "private-1", name: fallbackRoomName("neha", "clearance") }],
    });
    await expect(chat.ensureDirectRoom({ userName: "neha" })).resolves.toEqual({ roomId: "private-1" });
    expect(opCalls.some((call) => call.name === "create_room")).toBe(false);
  });

  it("does not take a room that only happens to have the name", async () => {
    const { chat } = port({
      list_rooms: () => [{ room_id: "impostor", name: directRoomName("sam", "clearance") }],
      get_room_detail: () => ({ channel_type: "channel_public" }),
      create_room: () => ({ id: "private-1" }),
    });
    await expect(chat.ensureDirectRoom({ userName: "sam" })).resolves.toEqual({ roomId: "private-1" });
  });

  it("asks Switch once per person", async () => {
    const { chat, opCalls } = port({
      list_rooms: () => [{ room_id: "dm-1", name: directRoomName("sam", "clearance") }],
      get_room_detail: () => ({ channel_type: "direct" }),
    });
    await chat.ensureDirectRoom({ userName: "sam" });
    await chat.ensureDirectRoom({ userName: "sam" });
    expect(opCalls.filter((call) => call.name === "list_rooms")).toHaveLength(1);
  });
});

describe("upsertDocument", () => {
  const input = { roomId: "room-a", name: "clearance-ledger-2026-11-06", content: "# Ledger\n" };

  it("creates a document the room does not have", async () => {
    const { chat, opCalls } = port({
      connect_to_room: () => ({ documents: [] }),
      create_room_document: () => ({ document_id: "doc-1" }),
    });
    await chat.upsertDocument(input);
    const create = opCalls.find((call) => call.name === "create_room_document")!;
    expect(create.roomId).toBe("room-a");
    expect(create.args).toMatchObject({ name: input.name, content: input.content });
    expect(create.args.description).toEqual(expect.any(String));
    expect(create.args.instructions).toEqual(expect.any(String));
  });

  it("updates one that exists, found by name", async () => {
    const { chat, opCalls } = port({
      connect_to_room: () => ({ documents: [{ id: "doc-1", name: input.name }] }),
      update_room_document: () => ({ document_id: "doc-1", status: "ok" }),
    });
    await chat.upsertDocument(input);
    expect(opCalls.find((call) => call.name === "update_room_document")?.args).toEqual({
      document_id: "doc-1",
      content: input.content,
    });
    expect(opCalls.some((call) => call.name === "create_room_document")).toBe(false);
  });

  it("remembers the id, so a later write takes one call", async () => {
    const { chat, opCalls } = port({
      connect_to_room: () => ({ documents: [] }),
      create_room_document: () => ({ document_id: "doc-1" }),
      update_room_document: () => ({ status: "ok" }),
    });
    await chat.upsertDocument(input);
    await chat.upsertDocument({ ...input, content: "later" });
    expect(opCalls.map((call) => call.name)).toEqual(["connect_to_room", "create_room_document", "update_room_document"]);
  });

  it("creates it again if a person deleted it from the room", async () => {
    const { chat } = port({
      connect_to_room: () => ({ documents: [{ id: "doc-1", name: input.name }] }),
      update_room_document: () => {
        throw new SwitchApiError(400, "/ops/update_room_document", "Document not found");
      },
      create_room_document: () => ({ document_id: "doc-2" }),
    });
    await expect(chat.upsertDocument(input)).resolves.toBeUndefined();
  });

  it("does not swallow any other failure", async () => {
    const { chat } = port({
      connect_to_room: () => ({ documents: [{ id: "doc-1", name: input.name }] }),
      update_room_document: () => {
        throw new SwitchApiError(400, "/ops/update_room_document", "content exceeds 1048576 bytes");
      },
    });
    await expect(chat.upsertDocument(input)).rejects.toThrow("exceeds");
  });
});

describe("a card's lifetime", () => {
  it("never asks Switch for more than it allows, even for a proposal that stays open for days", async () => {
    const { agent, opened } = fakeAgent();
    const port = createChatPort(agent, { agentName: "clearance", participantNames: {} });
    const threeDays = Date.now() + 3 * 24 * 60 * 60 * 1000;
    await port.openCard({ roomId: "room-1", kind: "approval", title: "PROP-0001", detail: "", options: [], questions: [], expiresAtMs: threeDays });
    const expires = Date.parse(String(opened[0]!.expires_at));
    expect(expires).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000);
    expect(expires).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
  });

  it("leaves a shorter expiry as it is", async () => {
    const { agent, opened } = fakeAgent();
    const port = createChatPort(agent, { agentName: "clearance", participantNames: {} });
    const soon = Date.now() + 30 * 60 * 1000;
    await port.openCard({ roomId: "room-1", kind: "approval", title: "CLR-0001", detail: "", options: [], questions: [], expiresAtMs: soon });
    expect(Date.parse(String(opened[0]!.expires_at))).toBe(soon);
  });
});

describe("createMattermostHandleResolver", () => {
  const card = fixture<{ message: string }>("mattermost_card_post");
  const postsResponse = (messages: string[]) =>
    Response.json({
      order: messages.map((_, index) => `p${index}`),
      posts: Object.fromEntries(messages.map((message, index) => [`p${index}`, { message }])),
    });

  function resolver(fetchImpl: typeof fetch) {
    const { agent, opCalls } = fakeAgent({ get_room_detail: () => ({ external_channel_id: "chan-1" }) });
    return {
      opCalls,
      resolve: createMattermostHandleResolver({
        agent,
        mattermostUrl: "http://mm.test/",
        token: "reader-token",
        timeoutMs: 40,
        pollMs: 5,
        fetch: fetchImpl,
      }),
    };
  }

  it("does not take the handle of an older card that reads the same, since ids restart after a reset", async () => {
    const title = "CLR-0001 · REFUND ₹40,000 · HIGH · irreversible";
    const now = Date.now();
    const old = { message: `**Approve** · request \`A7\`\n${title}`, create_at: now - 3_600_000 };
    const fresh = { message: `**Approve** · request \`A9\`\n${title}`, create_at: now + 10 };
    let polls = 0;
    const fetchImpl = (async () => {
      polls += 1;
      // The new card lands on the second look. Until then the only match is the old one.
      const posts = polls === 1 ? { old } : { fresh, old };
      return Response.json({ order: Object.keys(posts), posts });
    }) as typeof fetch;
    const { resolve } = resolver(fetchImpl);
    expect(await resolve({ roomId: "room", title, openedAtMs: now })).toBe("A9");
    expect(polls).toBeGreaterThan(1);
  });

  it("reads the handle off a card as Mattermost really stores it, escaping and all", async () => {
    // The recorded post has a zero-width space in the address, which the title does not.
    expect(card.message).toContain("meera.k@​okaxis");
    const fetchImpl = vi.fn(async () => postsResponse(["chatter", card.message])) as unknown as typeof fetch;
    const { resolve } = resolver(fetchImpl);
    await expect(resolve({ roomId: "room-a", title: "CLR-S21 refund ₹40,000 to meera.k@okaxis · HIGH" })).resolves.toBe("A1");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://mm.test/api/v4/channels/chan-1/posts?per_page=30");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer reader-token");
  });

  it("reads the handle the same when the card opens by naming someone", async () => {
    // Switch draws the mention on the line above the heading, and the handle stays where it was.
    const named = `@sam\n${card.message}`;
    const { resolve } = resolver((async () => postsResponse([named])) as unknown as typeof fetch);
    await expect(resolve({ roomId: "room-a", title: "CLR-S21 refund ₹40,000 to meera.k@okaxis · HIGH" })).resolves.toBe("A1");
  });

  it("waits for a card that is not drawn yet", async () => {
    let calls = 0;
    const { resolve } = resolver((async () => {
      calls += 1;
      return postsResponse(calls < 3 ? [] : [card.message]);
    }) as unknown as typeof fetch);
    await expect(resolve({ roomId: "room-a", title: "CLR-S21 refund ₹40,000 to meera.k@okaxis · HIGH" })).resolves.toBe("A1");
    expect(calls).toBe(3);
  });

  it("does not take another card's handle", async () => {
    const { resolve } = resolver((async () => postsResponse([card.message])) as unknown as typeof fetch);
    await expect(resolve({ roomId: "room-a", title: "CLR-9999 something else" })).resolves.toBeUndefined();
  });

  it("looks the channel up once per room", async () => {
    const { resolve, opCalls } = resolver((async () => postsResponse([card.message])) as unknown as typeof fetch);
    const title = "CLR-S21 refund ₹40,000 to meera.k@okaxis · HIGH";
    await resolve({ roomId: "room-a", title });
    await resolve({ roomId: "room-a", title });
    expect(opCalls.filter((call) => call.name === "get_room_detail")).toHaveLength(1);
  });

  it("gives up cleanly on a room with no channel", async () => {
    const { agent } = fakeAgent({ get_room_detail: () => ({ external_channel_id: null }) });
    const resolve = createMattermostHandleResolver({ agent, mattermostUrl: "http://mm.test", token: "t" });
    await expect(resolve({ roomId: "room-a", title: "x" })).resolves.toBeUndefined();
  });

  it("has no handle to give for a channel its token may not read, such as a real DM", async () => {
    const { resolve } = resolver((async () => new Response("no", { status: 403 })) as unknown as typeof fetch);
    await expect(resolve({ roomId: "room-a", title: "x" })).resolves.toBeUndefined();
  });

  it("reports any other failed read", async () => {
    const { resolve } = resolver((async () => new Response("no", { status: 502 })) as unknown as typeof fetch);
    await expect(resolve({ roomId: "room-a", title: "x" })).rejects.toThrow("502");
  });
});

describe("registerAgent", () => {
  it("registers an always-on protocol agent under the key's owner", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: "agent-1", api_key: "secret" })) as unknown as typeof fetch;
    const result = await registerAgent({
      bridgeUrl: "http://switch.test/",
      registrationKey: "reg",
      name: "clearance",
      description: "d",
      fetch: fetchImpl,
    });
    expect(result).toEqual({ agentId: "agent-1", apiKey: "secret" });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://switch.test/agents");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer reg");
    expect(JSON.parse(init.body as string)).toMatchObject({
      name: "clearance",
      connector_type: "external",
      overwrite: false,
      integration_profile: { connection_model: "always_on", message_exchange: true },
    });
  });

  it("raises Switch's refusal", async () => {
    const fetchImpl = (async () => Response.json({ detail: "Agent already exists" }, { status: 409 })) as unknown as typeof fetch;
    await expect(
      registerAgent({ bridgeUrl: "http://switch.test", registrationKey: "reg", name: "clearance", description: "d", fetch: fetchImpl }),
    ).rejects.toThrow("Agent already exists");
  });
});

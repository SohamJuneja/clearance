import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Persona } from "../lib/persona.ts";
import {
  FakeMattermost,
  type FakeChannel,
  type FakeUser,
} from "../test-support/fake-mattermost.ts";
import {
  type AgentDetail,
  httpPrivateChatWorld,
  privateChatCheck,
  type PrivateChatAttempt,
  PRIVATE_CHAT_CHECK,
} from "./private-chat.ts";

const REFUSAL =
  "@sam You're not permitted to direct messages to me in this room — my operator has restricted who can address me here.";

describe("the private-chat check", () => {
  let mm: FakeMattermost;
  let sam: FakeUser;
  let agent: FakeUser;

  beforeEach(async () => {
    mm = new FakeMattermost();
    await mm.start();
    sam = mm.addUser("sam");
    agent = mm.addUser("refunds-agent");
  });
  afterEach(async () => {
    await mm.stop();
  });

  const persona = (): Persona =>
    new Persona({ name: "sam", token: () => sam.token, baseUrl: mm.baseUrl, pollMs: 2 });
  const custom: AgentDetail = { addressing: { policy: "custom" }, rooms: [] };

  /** Plays the agent: what it says when Sam writes in the direct room. */
  function agentAnswers(...lines: string[]): void {
    mm.onPost = (post, author) => {
      if (author.username !== "sam") return;
      const channel = { id: post.channel_id } as FakeChannel;
      for (const line of lines) mm.addPost(channel, agent, line);
    };
  }

  function check(
    options: {
      details?: AgentDetail[];
      chat?: PrivateChatAttempt;
    } = {},
  ) {
    const details = [...(options.details ?? [custom, custom])];
    return privateChatCheck({
      agent: "refunds-agent",
      sam: persona(),
      readAgent: async () => details.shift() ?? custom,
      startPrivateChat: async () => options.chat ?? { status: 403, code: "AGENT_NOT_ALLOWED" },
      attempts: 2,
      replyTimeoutMs: 30,
      quietMs: 5,
    });
  }

  const postsBySam = (): number =>
    mm.requests.filter((request) => request.method === "POST" && request.path === "/api/v4/posts")
      .length;

  it("passes when the direct message draws the refusal, the agent says nothing else, and the chat gets 403", async () => {
    agentAnswers(REFUSAL);
    const result = await check();
    expect(result).toMatchObject({ id: PRIVATE_CHAT_CHECK, outcome: "prevented" });
    expect(result.why).toContain("403 AGENT_NOT_ALLOWED");
    expect(result.warnings).toEqual([]);
  });

  it("sends nothing at all when the limit isn't on, because a real agent would start a session", async () => {
    const result = await check({ details: [{ addressing: { policy: "anyone" }, rooms: [] }] });
    expect(result.outcome).toBe("not prevented");
    expect(result.why).toContain("reads `anyone`");
    expect(result.why).toContain("Nothing was sent");
    expect(postsBySam()).toBe(0);
  });

  it("fails if the agent says anything beyond the refusal, which means it heard", async () => {
    agentAnswers(REFUSAL, "Starting a session to handle this — one moment.");
    const result = await check();
    expect(result.outcome).toBe("not prevented");
    expect(result.why).toContain("heard the direct message");
  });

  it("fails if the agent answers with no refusal at all", async () => {
    agentAnswers("Sure, what do you need?");
    const result = await check();
    expect(result.outcome).toBe("not prevented");
    expect(result.why).toContain("heard the direct message");
  });

  it("fails when nothing comes back, since it can't claim a refusal it didn't see, after trying again", async () => {
    const result = await check();
    expect(result.outcome).toBe("not prevented");
    expect(result.why).toContain('no "not permitted" came back after 2 direct messages');
    expect(postsBySam()).toBe(2);
  });

  it("stops retrying once the refusal comes, so it doesn't keep writing to a protected agent", async () => {
    agentAnswers(REFUSAL);
    await check();
    expect(postsBySam()).toBe(1);
  });

  it("fails if Switch makes the private chat, and says what to clean up", async () => {
    agentAnswers(REFUSAL);
    const result = await check({ chat: { status: 201, roomId: "room_9" } });
    expect(result.outcome).toBe("not prevented");
    expect(result.why).toContain("made Sam a private chat (HTTP 201)");
    expect(result.why).toContain("Remove room room_9");
  });

  it("won't call any other refusal a pass: a 500 says nothing about addressing", async () => {
    agentAnswers(REFUSAL);
    const result = await check({ chat: { status: 500 } });
    expect(result.outcome).toBe("blocked");
    expect(result.why).toContain("HTTP 500");
  });

  it("says when the direct message left a room, which keeps the agent at two approvals", async () => {
    agentAnswers(REFUSAL);
    const result = await check({
      details: [
        { addressing: { policy: "custom" }, rooms: [{ room_id: "a", room_name: "#support" }] },
        {
          addressing: { policy: "custom" },
          rooms: [
            { room_id: "a", room_name: "#support" },
            { room_id: "b", room_name: "Mattermost: sam / refunds-agent" },
            { room_id: "c", room_name: "already archived", archived: true },
          ],
        },
      ],
    });
    expect(result.outcome).toBe("prevented");
    expect(result.warnings).toEqual([
      'the direct message left "Mattermost: sam / refunds-agent" behind, which keeps refunds-agent at two approvals until it\'s archived',
    ]);
  });
});

describe("the calls to Switch's own API", () => {
  const KEY = "viewer-key-do-not-print";
  const PASSWORD = "persona-password-do-not-print";
  let server: Server;
  let url: string;
  let seen: { method?: string; path?: string; auth?: string; cookie?: string; body: string }[];
  let chatStatus: number;
  let chatBody: unknown;
  let loginStatus: number;

  beforeEach(async () => {
    seen = [];
    chatStatus = 403;
    chatBody = { code: "AGENT_NOT_ALLOWED" };
    loginStatus = 200;
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        seen.push({
          method: req.method,
          path: req.url,
          auth: req.headers.authorization,
          cookie: req.headers.cookie,
          body,
        });
        const send = (status: number, value: unknown, headers = {}): void => {
          res.writeHead(status, { "content-type": "application/json", ...headers });
          res.end(JSON.stringify(value));
        };
        if (req.url === "/agents/clr/ops/list_agents") {
          return send(200, {
            result: [
              { id: "agent-2", name: "refunds-agent-vanilla" },
              { id: "agent-1", name: "refunds-agent" },
            ],
          });
        }
        if (req.url === "/agents/clr/ops/get_agent_detail") {
          return send(200, { result: { addressing: { policy: "custom" }, rooms: [] } });
        }
        if (req.url === "/gateway/auth/login") {
          return send(loginStatus, {}, { "set-cookie": "session=abc; HttpOnly" });
        }
        if (req.url === "/gateway/chats") return send(chatStatus, chatBody);
        return send(404, {});
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });

  const world = () =>
    httpPrivateChatWorld({
      bridgeUrl: url,
      viewer: { id: "clr", key: KEY },
      agent: "refunds-agent",
      sam: { email: "sam@clearance.example", password: PASSWORD },
    });

  it("reads the agent as Clearance's viewer with a plain call, with no stream to disturb core's", async () => {
    await expect(world().readAgent()).resolves.toEqual({
      addressing: { policy: "custom" },
      rooms: [],
    });
    expect(seen.map((request) => request.path)).toEqual([
      "/agents/clr/ops/list_agents",
      "/agents/clr/ops/get_agent_detail",
    ]);
    expect(seen.every((request) => request.auth === `Bearer ${KEY}`)).toBe(true);
    // The exact agent, though the search also finds refunds-agent-vanilla.
    expect(JSON.parse(seen[1]?.body ?? "")).toEqual({ agent_id: "agent-1" });
  });

  it("stops if Switch has no agent by that name", async () => {
    const missing = httpPrivateChatWorld({
      bridgeUrl: url,
      viewer: { id: "clr", key: KEY },
      agent: "nobody",
      sam: { email: "sam@clearance.example", password: PASSWORD },
    });
    await expect(missing.readAgent()).rejects.toThrow("Switch has no agent named nobody");
  });

  it("starts the chat as Sam, with the session the login gave, and reports Switch's refusal", async () => {
    const attempt = await world().startPrivateChat();
    expect(attempt).toEqual({ status: 403, code: "AGENT_NOT_ALLOWED" });
    const chat = seen.find((request) => request.path === "/gateway/chats");
    expect(chat?.cookie).toBe("session=abc");
    expect(JSON.parse(chat?.body ?? "")).toMatchObject({ agentId: "agent-1" });
  });

  it("names the room when Switch does make the chat", async () => {
    chatStatus = 201;
    chatBody = { room_id: "room_9" };
    await expect(world().startPrivateChat()).resolves.toEqual({ status: 201, roomId: "room_9" });
  });

  it("stops on a failed login, without saying what the password was", async () => {
    loginStatus = 401;
    const failure = await world()
      .startPrivateChat()
      .catch((error: Error) => error.message);
    expect(failure).toBe("Sam's login answered HTTP 401");
    expect(seen.some((request) => request.path === "/gateway/chats")).toBe(false);
  });
});

/** Removing our own posts through Mattermost, and Switch's template operations as install uses them. */
import { describe, expect, it } from "vitest";
import { createOwnPosts } from "../src/own-posts.js";
import { createTemplatePort } from "../src/template-port.js";

type Handler = (method: string, path: string) => { status: number; body?: unknown };

function fakeFetch(handler: Handler) {
  const calls: { method: string; path: string; auth: string | null }[] = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    const path = String(url).replace("http://mm/api/v4", "");
    const method = init.method ?? "GET";
    calls.push({ method, path, auth: new Headers(init.headers).get("authorization") });
    const { status, body } = handler(method, path);
    return new Response(JSON.stringify(body ?? {}), { status });
  }) as unknown as typeof fetch;
  return { calls, doFetch };
}

const agentWith = (detail: { external_channel_id?: string | null }) => {
  const ops: string[] = [];
  return {
    ops,
    agent: {
      op: (async (name: string) => {
        ops.push(name);
        return detail;
      }) as never,
    },
  };
};

const posts = {
  order: ["p3", "p2", "p1", "p0"],
  posts: {
    p3: { id: "p3", user_id: "me", message: "**Needs your response (2)**" },
    p2: { id: "p2", user_id: "me", message: "a card" },
    p1: { id: "p1", user_id: "sam", message: "**Needs your response (9)** said Sam" },
    p0: { id: "p0", user_id: "me", message: "@sam **Needs your response (1)**" },
  },
};
const isInbox = (message: string) => message.includes("Needs your response");

const mattermost: Handler = (method, path) => {
  if (path === "/users/me") return { status: 200, body: { id: "me" } };
  if (method === "GET") return { status: 200, body: posts };
  return { status: 200, body: { status: "OK" } };
};

describe("removing our own posts", () => {
  it("deletes what matches and is ours, and leaves everything else", async () => {
    const { calls, doFetch } = fakeFetch(mattermost);
    const own = createOwnPosts({ ...agentWith({ external_channel_id: "c1" }), mattermostUrl: "http://mm", token: "tok", fetch: doFetch });
    expect(await own.remove("room-1", isInbox)).toBe(2);
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(["/posts/p3", "/posts/p0"]);
  });

  it("never deletes someone else's post, even one that reads the same", async () => {
    const { calls, doFetch } = fakeFetch(mattermost);
    const own = createOwnPosts({ ...agentWith({ external_channel_id: "c1" }), mattermostUrl: "http://mm", token: "tok", fetch: doFetch });
    await own.remove("room-1", isInbox);
    expect(calls.map((call) => call.path)).not.toContain("/posts/p1");
  });

  it("uses the token it was given, and looks up the channel and itself once", async () => {
    const { calls, doFetch } = fakeFetch(mattermost);
    const { agent, ops } = agentWith({ external_channel_id: "c1" });
    const own = createOwnPosts({ agent, mattermostUrl: "http://mm/", token: "tok", fetch: doFetch });
    await own.remove("room-1", isInbox);
    await own.remove("room-1", isInbox);
    expect(ops).toEqual(["get_room_detail"]);
    expect(calls.filter((call) => call.path === "/users/me")).toHaveLength(1);
    expect(new Set(calls.map((call) => call.auth))).toEqual(new Set(["Bearer tok"]));
  });

  it("throws when it can't read the room, which is how the caller knows to say so another way", async () => {
    const { doFetch } = fakeFetch((_method, path) => (path === "/users/me" ? { status: 200, body: { id: "me" } } : { status: 403 }));
    const own = createOwnPosts({ ...agentWith({ external_channel_id: "c1" }), mattermostUrl: "http://mm", token: "tok", fetch: doFetch });
    await expect(own.remove("room-1", isInbox)).rejects.toThrow("403");
  });

  it("throws for a room with no Mattermost channel", async () => {
    const { doFetch } = fakeFetch(mattermost);
    const own = createOwnPosts({ ...agentWith({ external_channel_id: null }), mattermostUrl: "http://mm", token: "tok", fetch: doFetch });
    await expect(own.remove("room-1", isInbox)).rejects.toThrow("no Mattermost channel");
  });

  it("doesn't put the token in an error", async () => {
    const { doFetch } = fakeFetch(() => ({ status: 500 }));
    const own = createOwnPosts({ ...agentWith({ external_channel_id: "c1" }), mattermostUrl: "http://mm", token: "very-secret", fetch: doFetch });
    const error = await own.remove("room-1", isInbox).catch((caught: Error) => caught);
    expect(String(error)).not.toContain("very-secret");
  });
});

type OpCall = { name: string; args: Record<string, unknown> };

function templateAgent(answers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: OpCall[] = [];
  return {
    calls,
    agent: {
      op: (async (name: string, args: Record<string, unknown> = {}) => {
        calls.push({ name, args });
        const answer = answers[name];
        if (!answer) throw new Error(`unexpected op ${name}`);
        return answer(args);
      }) as never,
    },
  };
}

describe("the template port", () => {
  it("looks through every room Clearance's owner can see, not only the ones it is in", async () => {
    const { agent, calls } = templateAgent({
      list_all_rooms: () => ({ rooms: [{ room_id: "r1", name: "approvals" }, { room_id: "r2", name: "approvals-old" }], next_cursor: null }),
    });
    const rooms = await createTemplatePort(agent).roomsNamed("approvals");
    expect(rooms).toEqual([{ roomId: "r1", name: "approvals", archived: false }]);
    expect(calls[0]).toEqual({ name: "list_all_rooms", args: { include_archived: true, name_contains: "approvals", limit: 500 } });
  });

  it("reads every page, so a room on page two still counts", async () => {
    const { agent, calls } = templateAgent({
      list_all_rooms: (args) =>
        args.cursor
          ? { rooms: [{ room_id: "r9", name: "approvals", archived: true }], next_cursor: null }
          : { rooms: [{ room_id: "r1", name: "approvals-1" }], next_cursor: "next" },
    });
    expect(await createTemplatePort(agent).roomsNamed("approvals")).toEqual([{ roomId: "r9", name: "approvals", archived: true }]);
    expect(calls).toHaveLength(2);
  });

  it("knows whether Clearance is in a room", async () => {
    const { agent } = templateAgent({ list_rooms: () => [{ room_id: "r1", name: "a" }] });
    const port = createTemplatePort(agent);
    expect(await port.isMember("r1")).toBe(true);
    expect(await port.isMember("r2")).toBe(false);
  });

  it("finds a template by its exact name", async () => {
    const { agent } = templateAgent({
      list_templates: () => [
        { id: "t1", name: "clearance-install-old", can_edit: true },
        { id: "t2", name: "clearance-install", can_edit: false },
      ],
    });
    const port = createTemplatePort(agent);
    expect(await port.findTemplate("clearance-install")).toEqual({ id: "t2", canEdit: false });
    expect(await port.findTemplate("nope")).toBeNull();
  });

  it("saves privately, never bypassing Switch's warnings", async () => {
    const { agent, calls } = templateAgent({ save_template: () => ({ id: "t1", kind: "room", warnings: [] }) });
    expect(await createTemplatePort(agent).saveTemplate({ name: "n", description: "d", yaml: "y" })).toEqual({ id: "t1" });
    expect(calls[0]?.args).toEqual({ name: "n", description: "d", yaml: "y", visibility: "private" });
  });

  it("reports the room as it came out, read back from Switch", async () => {
    const { agent } = templateAgent({
      run_template: () => ({ room_id: "r1", room_name: "approvals", created_document_ids: ["d1"], failed_attachments: [] }),
      get_room_detail: () => ({ connected_user_names: ["sam", "neha"] }),
    });
    expect(await createTemplatePort(agent).runTemplate("t1", { room_name: "approvals" })).toEqual({
      roomId: "r1",
      roomName: "approvals",
      documents: 1,
      users: ["sam", "neha"],
      errors: [],
    });
  });

  it("reads errors, because a partly failed run still answers 200", async () => {
    const { agent } = templateAgent({
      run_template: () => ({ room_id: "r1", errors: [{ room_name: "approvals", error: "Unknown agents: clearance" }], failed_attachments: [{ name: "x" }] }),
      get_room_detail: () => ({}),
    });
    const run = await createTemplatePort(agent).runTemplate("t1", {});
    expect(run.errors[0]).toBe("approvals: Unknown agents: clearance");
    expect(run.errors[1]).toContain("attachment");
  });

  it("throws when no room came of it, and says why", async () => {
    const { agent } = templateAgent({ run_template: () => ({ errors: [{ room_name: "approvals", error: "nope" }] }) });
    await expect(createTemplatePort(agent).runTemplate("t1", {})).rejects.toThrow("nope");
  });
});

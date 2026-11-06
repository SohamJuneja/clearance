import { describe, expect, it } from "vitest";
import { retiredChannelName } from "./fresh-room.ts";
import { greetClearance, PEOPLE } from "./greet.ts";
import { isStray } from "./stray-rooms.ts";

type Call = { method: string; path: string; token: string; body?: unknown };

function fakeMattermost(failFor?: string): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("http://mm.test/api/v4", "");
    const token = String((init?.headers as Record<string, string>).authorization).replace("Bearer ", "");
    calls.push({ method: init?.method ?? "GET", path, token, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (failFor === token && path === "/posts") return new Response("{}", { status: 403 });
    const id = path === "/users/me" ? `me-${token}` : path.includes("clearance") ? "clearance-id" : path === "/channels/direct" ? `dm-${token}` : "post";
    return new Response(JSON.stringify({ id }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const tokens = Object.fromEntries(PEOPLE.map((person) => [person, person]));

describe("greetClearance", () => {
  it("has each person write once in their own direct room with Clearance", async () => {
    const { fetchImpl, calls } = fakeMattermost();
    await greetClearance({ mattermostUrl: "http://mm.test/", tokens, fetchImpl });
    const posts = calls.filter((call) => call.path === "/posts");
    expect(posts.map((post) => post.token)).toEqual([...PEOPLE]);
    for (const post of posts) {
      expect(post.body).toEqual({ channel_id: `dm-${post.token}`, message: "hello" });
    }
    const direct = calls.find((call) => call.path === "/channels/direct" && call.token === "sam");
    expect(direct?.body).toEqual(["me-sam", "clearance-id"]);
  });

  it("names the person who could not say it", async () => {
    const { fetchImpl } = fakeMattermost("neha");
    await expect(greetClearance({ mattermostUrl: "http://mm.test", tokens, fetchImpl })).rejects.toThrow(/neha could not say hello/);
  });

  it("refuses to go on without someone's token", async () => {
    const { fetchImpl } = fakeMattermost();
    const { dev: _dev, ...missing } = tokens;
    await expect(greetClearance({ mattermostUrl: "http://mm.test", tokens: missing, fetchImpl })).rejects.toThrow(/no Mattermost token for dev/);
  });
});

describe("retiredChannelName", () => {
  it("is a name Mattermost accepts, and sorts by when the channel was retired", () => {
    const name = retiredChannelName("support", new Date("2026-11-06T01:02:03Z"));
    expect(name).toBe("support-take-20261106-010203");
    expect(name).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("isStray", () => {
  const guarded = new Set(["refunds", "coder"]);

  it("is a room with a protected agent that Clearance can't hear, such as an old DM", () => {
    expect(isStray(["refunds"], guarded, "clearance")).toBe(true);
  });

  it("leaves rooms Clearance is in, and rooms with no protected agent, like the baseline's", () => {
    expect(isStray(["refunds", "clearance"], guarded, "clearance")).toBe(false);
    expect(isStray(["vanilla"], guarded, "clearance")).toBe(false);
  });
});

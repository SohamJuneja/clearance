/**
 * Whether an agent is anywhere Clearance isn't. The shapes are what `get_agent_detail` returned on the live stack
 * (spikes/s-hidden-session.ts): a Mattermost direct room is named, a private chat shows only as a session with a
 * room id and no name, and a managed agent's session has no room at all.
 */
import { describe, expect, it } from "vitest";
import type { SwitchAgent } from "../src/agent.js";
import { createChatPort } from "../src/chat-port.js";

type Detail = {
  rooms: { room_id: string; room_name?: string; archived?: boolean; status?: string }[];
  sessions: { room_id: string | null; room_name?: string | null; lifecycle?: string; state: string }[];
};

const MINE = [{ room_id: "support", name: "support" }, { room_id: "town-square", name: "Mattermost: Town Square" }];

function portFor(detail: Detail, options: { agents?: { id: string; name: string }[]; mine?: { room_id: string; name: string }[] } = {}) {
  const calls: string[] = [];
  const agent = {
    op: async (name: string) => {
      calls.push(name);
      if (name === "list_agents") return options.agents ?? [{ id: "ag-1", name: "refunds-agent" }];
      if (name === "get_agent_detail") return detail;
      if (name === "list_rooms") return options.mine ?? MINE;
      throw new Error(`unexpected op ${name}`);
    },
  } as unknown as SwitchAgent;
  return { port: createChatPort(agent), calls };
}

const count = (detail: Detail, options?: Parameters<typeof portFor>[1]) => portFor(detail, options).port.unseenRoomCount!("refunds-agent");

const inSupport = { room_id: "support", room_name: "support", status: "live" };

describe("how many rooms an agent is in that Clearance isn't", () => {
  it("is none in the normal flow, with the agent only where Clearance also is", async () => {
    const detail: Detail = {
      rooms: [inSupport, { room_id: "town-square", room_name: "Mattermost: Town Square" }],
      sessions: [{ room_id: "support", room_name: "support", lifecycle: "connection", state: "live" }],
    };
    expect(await count(detail)).toBe(0);
  });

  it("counts a Mattermost direct room, which is named, for an agent of any kind", async () => {
    const detail: Detail = { rooms: [inSupport, { room_id: "dm", room_name: "Mattermost: sam / refunds-agent" }], sessions: [] };
    expect(await count(detail)).toBe(1);
  });

  it("counts a live session in a private chat, which has a room id and no name, and isn't in its rooms", async () => {
    const detail: Detail = {
      rooms: [inSupport],
      sessions: [{ room_id: "private-chat", room_name: null, lifecycle: "connection", state: "live" }],
    };
    expect(await count(detail)).toBe(1);
  });

  it("counts a room once, whether it shows as membership, a session or both", async () => {
    const detail: Detail = {
      rooms: [inSupport, { room_id: "dm" }],
      sessions: [{ room_id: "dm", state: "live" }],
    };
    expect(await count(detail)).toBe(1);
  });

  it("counts each room", async () => {
    const detail: Detail = { rooms: [{ room_id: "a" }, { room_id: "b" }], sessions: [{ room_id: "c", state: "live" }] };
    expect(await count(detail)).toBe(3);
  });

  it("doesn't count a session with no room: an always-on connection, or a managed agent's controller", async () => {
    const detail: Detail = {
      rooms: [inSupport],
      sessions: [
        { room_id: null, lifecycle: "connection", state: "live" },
        { room_id: null, lifecycle: "controller", state: "live" },
      ],
    };
    expect(await count(detail)).toBe(0);
  });

  it("doesn't count a stale session, but does count an explicit one, which has no heartbeat to go stale", async () => {
    expect(await count({ rooms: [inSupport], sessions: [{ room_id: "gone", state: "stale" }] })).toBe(0);
    expect(await count({ rooms: [inSupport], sessions: [{ room_id: "held", lifecycle: "explicit", state: "open" }] })).toBe(1);
  });

  it("doesn't count an archived room, where nobody can ask anything", async () => {
    expect(await count({ rooms: [inSupport, { room_id: "old", archived: true }], sessions: [] })).toBe(0);
  });

  it("counts Town Square if Clearance isn't in it: someone can ask there too", async () => {
    const detail: Detail = { rooms: [inSupport, { room_id: "town-square" }], sessions: [] };
    expect(await count(detail, { mine: [{ room_id: "support", name: "support" }] })).toBe(1);
  });
});

describe("when it can't say", () => {
  it("throws for an agent Switch doesn't know, so core takes the cautious side", async () => {
    await expect(count({ rooms: [], sessions: [] }, { agents: [] })).rejects.toThrow("no agent named refunds-agent");
  });

  it("doesn't take a similar name for the agent", async () => {
    await expect(count({ rooms: [], sessions: [] }, { agents: [{ id: "x", name: "refunds-agent-old" }] })).rejects.toThrow("no agent named");
  });

  it("lets a failed read through as a failure", async () => {
    const agent = {
      op: async (name: string) => {
        if (name === "list_agents") return [{ id: "ag-1", name: "refunds-agent" }];
        throw new Error("switch unreachable");
      },
    } as unknown as SwitchAgent;
    await expect(createChatPort(agent).unseenRoomCount!("refunds-agent")).rejects.toThrow("switch unreachable");
  });
});

describe("asking", () => {
  it("finds an agent's id once and reads its rooms each time", async () => {
    const { port, calls } = portFor({ rooms: [inSupport], sessions: [] });
    await port.unseenRoomCount!("refunds-agent");
    await port.unseenRoomCount!("refunds-agent");
    expect(calls.filter((name) => name === "list_agents")).toHaveLength(1);
    expect(calls.filter((name) => name === "get_agent_detail")).toHaveLength(2);
  });
});

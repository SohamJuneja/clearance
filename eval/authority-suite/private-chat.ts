/**
 * The path E1's case 1 can't reach: a managed agent in a private Switch chat. Its call names no room and Switch reports
 * its session with no room, so if someone else asked it in the last 10 minutes, Clearance records the wrong person and
 * asks for one approver (docs/threat-model.md, DECISIONS 08:20). Nothing Clearance reads can see this. What closes it is
 * the agent's owner limiting who can address it to named rooms, which Switch enforces. So this checks Switch does:
 * a direct message draws "You're not permitted" and the agent hears nothing, and a private chat gets 403.
 *
 * It runs through the real stack as part of `--live`. It reads the agent's addressing first and sends nothing if the
 * limit isn't on, because a real agent would hear the message and start a real session. With the limit on, the direct
 * message can still leave a room behind, which keeps the agent at two approvals until it's archived, so the result
 * names any it finds.
 */
import { randomUUID } from "node:crypto";
import { MattermostUnreachableError, type Persona, postText } from "../lib/persona.ts";
import type { LiveResult } from "./scene.ts";

export const PRIVATE_CHAT_CHECK = "1-private-chat";

/** Asks for nothing, so that if the limit is wrong and the agent hears it, it has nothing to act on. */
export const PROBE = "Live check of who can address you. No action needed.";

const NOT_PERMITTED = /not permitted/i;

export interface AgentDetail {
  addressing: { policy: string };
  rooms: { room_id: string; room_name?: string; archived?: boolean }[];
}

export interface PrivateChatAttempt {
  status: number;
  /** Switch's reason, when it gave one. */
  code?: string;
  /** Set if Switch made the chat, which has to be cleaned up by hand. */
  roomId?: string;
}

export interface PrivateChatWorld {
  agent: string;
  sam: Persona;
  readAgent(): Promise<AgentDetail>;
  startPrivateChat(): Promise<PrivateChatAttempt>;
  /** A new direct room can take a moment to bridge, so the first message may get no answer. */
  attempts?: number;
  replyTimeoutMs?: number;
  /** How long the agent gets to give itself away after the refusal: "Starting a session" comes within seconds. */
  quietMs?: number;
}

const ID = PRIVATE_CHAT_CHECK;

export async function privateChatCheck(world: PrivateChatWorld): Promise<LiveResult> {
  const { agent, sam } = world;
  const before = await world.readAgent();
  if (before.addressing.policy !== "custom") {
    return {
      id: ID,
      outcome: "not prevented",
      why: `${agent}'s addressing reads \`${before.addressing.policy}\`, so room-limited addressing isn't on and the private-chat path is open. Nothing was sent, since a real agent would have heard it`,
    };
  }

  const channel = await sam.dm(agent);
  const me = await sam.me();
  const attempts = world.attempts ?? 3;
  const replyTimeoutMs = world.replyTimeoutMs ?? 12_000;
  const first = await sam.post(channel, PROBE);
  let refused = false;
  for (let attempt = 1; attempt <= attempts && !refused; attempt += 1) {
    if (attempt > 1) await sam.post(channel, PROBE);
    refused = await sam
      .waitForPost(channel, (post) => NOT_PERMITTED.test(postText(post)), {
        after: first,
        timeoutMs: replyTimeoutMs,
        description: `${agent} to say Sam isn't permitted`,
      })
      .then(() => true)
      .catch((error: unknown) => {
        if (error instanceof MattermostUnreachableError) throw error;
        return false;
      });
  }
  // Long enough for anything else the agent was going to say. A session announces itself in seconds.
  await new Promise((done) => setTimeout(done, world.quietMs ?? 20_000));
  // Switch itself posts this into a new direct room, in the agent's name, whoever is allowed to talk to it (delivery/
  // recipient.py). It is the room being made, not the agent hearing anything. Only these exact words are let through.
  const greeting = `Hi! I'm ${agent} — how can I help?`;
  const spoke = (await sam.recent(channel, { limit: 30 })).filter(
    (post) =>
      post.create_at >= first.create_at &&
      post.user_id !== me.id &&
      !NOT_PERMITTED.test(postText(post)) &&
      postText(post).trim() !== greeting,
  );

  const after = await world.readAgent();
  const known = new Set(before.rooms.map((room) => room.room_id));
  const leftBehind = after.rooms
    .filter((room) => !room.archived && !known.has(room.room_id))
    .map((room) => room.room_name ?? room.room_id);
  const warnings = leftBehind.map(
    (room) =>
      `the direct message left "${room}" behind, which keeps ${agent} at two approvals until it's archived`,
  );

  const chat = await world.startPrivateChat();
  const problems: string[] = [];
  if (spoke.length > 0) {
    problems.push(
      `${agent} heard the direct message: it posted ${spoke.length} time(s) beyond the refusal`,
    );
  } else if (!refused) {
    problems.push(
      `no "not permitted" came back after ${attempts} direct messages, and nothing else did either`,
    );
  }
  if (chat.status < 300) {
    problems.push(
      `Switch made Sam a private chat (HTTP ${chat.status})${chat.roomId ? `. Remove room ${chat.roomId} by hand` : ""}`,
    );
  }
  if (problems.length > 0) {
    return { id: ID, outcome: "not prevented", why: problems.join("; "), warnings };
  }
  // A failure that isn't Switch refusing says nothing about whether Switch would have refused.
  if (chat.status !== 403) {
    return {
      id: ID,
      outcome: "blocked",
      why: `a private chat answered HTTP ${chat.status}, not the 403 this checks for`,
      warnings,
    };
  }
  return {
    id: ID,
    outcome: "prevented",
    why: `a direct message to ${agent} drew "not permitted" and it posted nothing else, and a private chat got 403${chat.code ? ` ${chat.code}` : ""}`,
    warnings,
  };
}

export interface HttpPrivateChatOptions {
  bridgeUrl: string;
  /** Who reads the agent: the same view Clearance has, with a plain call, so core's own connection isn't disturbed. */
  viewer: { id: string; key: string };
  /** By name, as core finds it: identities.json only holds Clearance's own id. */
  agent: string;
  sam: { email: string; password: string };
}

/** The two things that need Switch's own API. Reads, plus the one attempt to start a chat. */
export function httpPrivateChatWorld(
  options: HttpPrivateChatOptions,
): Pick<PrivateChatWorld, "readAgent" | "startPrivateChat"> {
  const { bridgeUrl, viewer, agent, sam } = options;
  const op = async <T>(name: string, args: unknown): Promise<T> => {
    const res = await fetch(`${bridgeUrl}/agents/${viewer.id}/ops/${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${viewer.key}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`${name} answered HTTP ${res.status}`);
    return ((await res.json()) as { result: T }).result;
  };
  let known: string | undefined;
  const agentId = async (): Promise<string> => {
    if (known) return known;
    const rows = await op<{ id: string; name: string }[]>("list_agents", { name_contains: agent });
    known = rows.find((row) => row.name === agent)?.id;
    if (!known) throw new Error(`Switch has no agent named ${agent}`);
    return known;
  };
  return {
    async readAgent() {
      return op<AgentDetail>("get_agent_detail", { agent_id: await agentId() });
    },
    async startPrivateChat() {
      const id = await agentId();
      const login = await fetch(`${bridgeUrl}/gateway/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: sam.email, password: sam.password }),
      });
      const cookie = login.headers.getSetCookie()[0]?.split(";")[0];
      if (!login.ok || !cookie) throw new Error(`Sam's login answered HTTP ${login.status}`);
      const res = await fetch(`${bridgeUrl}/gateway/chats`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          agentId: id,
          name: `e1-live-private-chat-${Date.now().toString(36)}`,
          requestId: randomUUID(),
        }),
      });
      const text = await res.text();
      const roomId = res.ok ? /"(?:room_id|roomId|id)"\s*:\s*"([^"]+)"/.exec(text)?.[1] : undefined;
      return {
        status: res.status,
        ...(/AGENT_NOT_ALLOWED/.test(text) ? { code: "AGENT_NOT_ALLOWED" } : {}),
        ...(roomId ? { roomId } : {}),
      };
    },
  };
}

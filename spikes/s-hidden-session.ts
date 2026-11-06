/**
 * Can Clearance tell that an agent is working somewhere it can't see?
 *
 * Priya names @refunds-agent in a room Clearance is in. Sam then asks the same agent in a direct room Clearance
 * isn't in. Nothing about Sam reaches Clearance. So: what does Switch say about that agent, to whom?
 *
 * Uses throwaway agents, their own rooms, and two viewers: one owned by clearance-admin, as the real Clearance
 * is, and one owned by the gateway admin, since a workspace admin's agents can read every room. Real agents are
 * only read, with `get_agent_detail`. Prints no secrets, and room ids only as labels. Removes what it made.
 *
 * CLEARANCE_ENV_FILE=<.env> SWITCH_ENV_FILE=<vendor .env> CLEARANCE_DATA_DIR=<data> pnpm exec tsx spikes/s-hidden-session.ts
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSwitchAgent, type SwitchAgent } from "../packages/switch-agent/src/agent.js";
import { registerAgent } from "../packages/switch-agent/src/register.js";
import { BRIDGE_URL, MATTERMOST_URL, identities, mattermost, say, secrets, sleep, waitFor } from "./lib.js";

const readEnv = (path: string) =>
  Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "")]),
  );
const switchEnv = readEnv(process.env.SWITCH_ENV_FILE!);
const personaPassword = readEnv(process.env.CLEARANCE_ENV_FILE!).PERSONA_PASSWORD!;
const stamp = Date.now().toString(36);

const init = (method: string, cookie: string | null, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const login = async (email: string, password: string) => {
  const res = await fetch(`${BRIDGE_URL}/gateway/auth/login`, init("POST", null, { email, password }));
  if (!res.ok) throw new Error(`login as ${email}: ${res.status}`);
  return res.headers.getSetCookie()[0]!.split(";")[0]!;
};
const gateway = async (cookie: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${BRIDGE_URL}/gateway${path}`, init(method, cookie, body));
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON.
  }
  return { status: res.status, body: parsed as Record<string, unknown> };
};

type Registered = { name: string; agentId: string; apiKey: string; owner: string };
const register = async (cookie: string, name: string): Promise<Registered> => {
  const key = await gateway(cookie, "POST", "/api-keys", { label: `spike-hidden-${stamp}` });
  const made = await registerAgent({ bridgeUrl: BRIDGE_URL, registrationKey: String(key.body.key), name, description: "Throwaway: can Clearance tell where an agent is working?" });
  await gateway(cookie, "DELETE", `/api-keys/${String(key.body.id)}`);
  return { name, agentId: made.agentId, apiKey: made.apiKey, owner: cookie };
};
const opOf = (agent: Registered) => async <T>(name: string, args: unknown): Promise<T> => {
  const res = await fetch(`${BRIDGE_URL}/agents/${agent.agentId}/ops/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${agent.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}: ${text.slice(0, 160)}`);
  return (JSON.parse(text) as { result: T }).result;
};

const clearanceAdmin = await login("clearance-admin@clearance.example", secrets.clearanceAdminPassword);
const gatewayAdmin = await login(switchEnv.GATEWAY_ADMIN_EMAIL!, switchEnv.GATEWAY_ADMIN_PASSWORD!);
const priya = await login("priya@clearance.example", personaPassword);

const viewer = await register(clearanceAdmin, `spike-view-${stamp}`);
const adminViewer = await register(gatewayAdmin, `spike-adm-${stamp}`);
const target = await register(priya, `spike-tgt-${stamp}`);
const limited = await register(priya, `spike-lim-${stamp}`);
// As every real agent is today: `get_agent_detail` reads `addressing: anyone` for all of them.
const opened = await gateway(priya, "PUT", `/agents/${target.agentId}/addressing-policy`, { policy: null });
say(`target's addressing set to anyone: HTTP ${opened.status}`);
say(`registered: viewer (owner clearance-admin), admin viewer (owner gateway admin), two targets (owner priya)`);

const made = { rooms: [] as string[], channels: new Set<string>() };
const labels = new Map<string, string>();
const label = (roomId: string | null) => (roomId === null ? "none" : (labels.get(roomId) ?? `some other room`));

const view = opOf(viewer);
const adminView = opOf(adminViewer);
const hands = { sam: mattermost("sam"), priya: mattermost("priya") };

const roomA = (await view<{ id: string }>("create_room", { name: `spike-seen-${stamp}`, description: "Throwaway", agent_names: [viewer.name, target.name, limited.name], user_names: ["sam", "priya"], channel_type: "channel_private" })).id;
made.rooms.push(roomA);
labels.set(roomA, "the room Clearance is in");

type Detail = {
  rooms: { room_id: string; room_name: string; status: string }[];
  sessions: { room_id: string | null; room_name: string | null; lifecycle: string; state: string; controller_id: string | null }[];
  addressing: { policy: string };
  connection_model?: string;
  integration_profile?: { connection_model?: string };
};
const show = (detail: Detail) =>
  `rooms ${JSON.stringify(detail.rooms.map((room) => `${label(room.room_id)} (${room.status})`))}, sessions ${JSON.stringify(detail.sessions.map((row) => ({ room: label(row.room_id), named: row.room_name !== null, lifecycle: row.lifecycle, state: row.state })))}`;
const report = async (what: string, agent: Registered = target) => {
  say(`\n${what}`);
  say(`  clearance-admin's viewer sees: ${show(await view<Detail>("get_agent_detail", { agent_id: agent.agentId }))}`);
  say(`  gateway admin's viewer sees:   ${show(await adminView<Detail>("get_agent_detail", { agent_id: agent.agentId }))}`);
};

const bot = async (name: string) =>
  waitFor(`${name}'s bot`, async () => {
    const res = await hands.sam.call("GET", `/users/username/${name}`);
    return res.status === 200 ? (res.body as unknown as { id: string }) : undefined;
  }, 30_000);

const stream: { body: string; roomId: string; addressed: boolean }[] = [];
let live: SwitchAgent | null = null;
const startTarget = async () => {
  live = createSwitchAgent({ bridgeUrl: BRIDGE_URL, agentId: target.agentId, apiKey: target.apiKey });
  await live.start({ message: (event) => void stream.push({ body: event.body, roomId: event.roomId, addressed: event.addressed }) });
  await sleep(400);
};

try {
  await report("[0] Registered, never connected, in the room Clearance is in");

  await startTarget();
  await report("[1] Connected, as an always-on protocol agent, with no session placed");

  await live!.op("list_participants", {}, { roomId: roomA });
  await sleep(300);
  await report("[2] A session in the room Clearance is in: the normal flow");

  // Sam writes to it directly, the way people do. Nothing here reaches Clearance.
  const targetBot = await bot(target.name);
  const samId = identities.people.sam!.mattermostUserId;
  const direct = await hands.sam.call("POST", "/channels/direct", [samId, targetBot.id]);
  const dmChannel = String(direct.body.id);
  made.channels.add(dmChannel);
  let said = 0;
  const dmRoom = await waitFor("Sam's direct room", async () => {
    if (Date.now() - said > 5_000) {
      await hands.sam.post(dmChannel, "refund order A-2004 in full please");
      said = Date.now();
    }
    return (await opOf(target)<{ room_id: string; name: string }[]>("list_rooms", {})).find((room) => room.name === `Mattermost: sam / ${target.name}`);
  }, 60_000);
  made.rooms.push(dmRoom.room_id);
  labels.set(dmRoom.room_id, "SAM'S DIRECT ROOM");
  await sleep(500);
  await report("[3] Sam has written to it directly. No session there yet: only membership");

  await live!.op("list_participants", {}, { roomId: dmRoom.room_id });
  await sleep(300);
  await report("[4] It has a live session in Sam's direct room, and one in the room Clearance is in. This is the break");

  // ── Anything else that gives it away ─────────────────────────────────────
  say("\n[5] Everything else clearance-admin's viewer can ask");
  const attempt = async (name: string, args: unknown, room?: string) => {
    const res = await fetch(`${BRIDGE_URL}/agents/${viewer.agentId}/ops/${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${viewer.apiKey}`, "content-type": "application/json", ...(room ? { "x-switch-room-id": room } : {}) },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    return { status: res.status, text };
  };
  const roomDetail = await attempt("get_room_detail", { room_id: dmRoom.room_id });
  say(`  get_room_detail on the hidden room's id: HTTP ${roomDetail.status}: ${roomDetail.text.slice(0, 130)}`);
  const connect = await attempt("connect_to_room", { room_id: dmRoom.room_id });
  say(`  connect_to_room on it: HTTP ${connect.status}: ${connect.text.slice(0, 130)}`);
  const allRooms = await view<{ rooms: { name: string }[] }>("list_all_rooms", { name_contains: target.name, include_archived: true });
  say(`  list_all_rooms for the agent's name: ${JSON.stringify(allRooms.rooms.map((room) => room.name))}`);
  const summary = await view<Record<string, unknown>[]>("list_agents", { name_contains: target.name });
  say(`  list_agents fields that could count anything: ${JSON.stringify(Object.keys(summary[0] ?? {}).filter((key) => /room|session|count/i.test(key)))}`);
  const seenDetail = await attempt("get_room_detail", { room_id: roomA });
  const seen = JSON.parse(seenDetail.text) as { result: Record<string, unknown> };
  say(`  get_room_detail on the visible room, fields about agents: ${JSON.stringify(Object.keys(seen.result).filter((key) => /agent|session|status|particip/i.test(key)))}`);
  const visibility = (await gateway(gatewayAdmin, "GET", `/rooms/${dmRoom.room_id}`)).body as { read_visibility?: string; channel_type?: string };
  say(`  Sam's Mattermost direct room is ${visibility.channel_type}, read_visibility ${visibility.read_visibility}. That is why it can be listed`);
  const context = await attempt("read_context", { room_id: dmRoom.room_id, limit: 3 });
  say(`  read_context on it, from a viewer who can list it: HTTP ${context.status}: ${context.text.slice(0, 110)}`);

  // ── A room that really is private ────────────────────────────────────────
  // A person's chat in Switch Console or the web is made read_visibility private (chats/service.py).
  const sam = await login("sam@clearance.example", personaPassword);
  const chat = await gateway(sam, "POST", "/chats", { agentId: target.agentId, name: `spike-chat-${stamp}`, requestId: randomUUID() });
  say(`\n[5b] Sam starts a chat with it in Switch itself: HTTP ${chat.status}`);
  if (chat.status >= 300) say(`  ${JSON.stringify(chat.body).slice(0, 300)}`);
  const chatRoomId = roomIdOfChat(chat.body);
  if (chat.status < 300 && chatRoomId !== "undefined") {
    made.rooms.push(chatRoomId);
    labels.set(chatRoomId, "SAM'S PRIVATE CHAT");
    const chatRoom = (await gateway(gatewayAdmin, "GET", `/rooms/${chatRoomId}`)).body as { read_visibility?: string; channel_type?: string };
    say(`  it is ${chatRoom.channel_type}, read_visibility ${chatRoom.read_visibility}, name ${JSON.stringify((chat.body as { chat?: { name?: string } }).chat?.name)}`);
    await report("[5c] It is a member of Sam's private chat, with no session there yet");
    await live!.op("list_participants", {}, { roomId: chatRoomId });
    await sleep(300);
    await report("[5d] It has a live session in Sam's private chat. This is the break at its hardest");
    const listed = await view<{ rooms: { name: string }[] }>("list_all_rooms", { name_contains: `spike-chat-${stamp}`, include_archived: true });
    say(`  list_all_rooms for that chat's name, clearance-admin's viewer: ${JSON.stringify(listed.rooms.map((room) => room.name))}`);
    const raw = await view<Detail>("get_agent_detail", { agent_id: target.agentId });
    say(`  the session there, as read: ${JSON.stringify(raw.sessions.filter((row) => row.room_id === chatRoomId).map((row) => ({ has_room_id: row.room_id !== null, room_name: row.room_name, state: row.state })))}`);
  }

  // ── When it stops ────────────────────────────────────────────────────────
  await live!.stop();
  live = null;
  await sleep(800);
  await report("[6] The agent has stopped. Does a hidden session linger?");
  await startTarget();
  await report("[7] Back, with no session placed: no live session anywhere, membership in the direct room remains");
  await live!.stop();
  live = null;

  // ── Real agents, read only ───────────────────────────────────────────────
  say("\n[8] Real agents, read only: how a managed agent looks");
  let clearanceRooms = new Set<string>();
  for (const name of ["clearance", "refunds-agent", "support-agent", "coder", "ops-agent", "reviewer"]) {
    const rows = await view<{ id: string; name: string; known_agent_type?: string | null; connection_model?: string | null }[]>("list_agents", { name_contains: name });
    const row = rows.find((entry) => entry.name === name);
    if (!row) {
      say(`  ${name}: not registered`);
      continue;
    }
    const seenBy = await view<Detail>("get_agent_detail", { agent_id: row.id });
    const seenByAdmin = await adminView<Detail>("get_agent_detail", { agent_id: row.id });
    const sessions = (detail: Detail) => JSON.stringify(detail.sessions.map((entry) => ({ hasRoom: entry.room_id !== null, named: entry.room_name !== null, lifecycle: entry.lifecycle, state: entry.state })));
    say(`  ${name}: type ${row.known_agent_type ?? "none"}, model ${row.connection_model ?? "none"}, addressing ${seenBy.addressing.policy}`);
    say(`    room names, Clearance's view: ${JSON.stringify(seenBy.rooms.map((room) => `${room.room_name.replace(/^Mattermost: (\w+) \/ .*/, "direct with $1")} (${room.status})`))}`);
    say(`    clearance-admin's viewer: ${seenBy.rooms.length} rooms, sessions ${sessions(seenBy)}`);
    if (name === "clearance") clearanceRooms = new Set(seenBy.rooms.map((room) => room.room_id));
    else say(`    rooms it is in that Clearance isn't: ${JSON.stringify(seenBy.rooms.filter((room) => !clearanceRooms.has(room.room_id)).map((room) => room.room_name))}`);
    say(`    gateway admin's viewer:   ${seenByAdmin.rooms.length} rooms, sessions ${sessions(seenByAdmin)}`);
  }

  // ── Can addressing stop direct rooms at the source? ──────────────────────
  say("\n[9] Addressing limited to named rooms: does a direct message reach the agent?");
  // Anyone at all, so that a refusal below can only be about the room.
  const policy = await gateway(priya, "PUT", `/agents/${limited.agentId}/addressing-policy`, { policy: { rules: [{ rooms: [roomA], users: "*", agents: "*", owner: true }] } });
  say(`  setting it: HTTP ${policy.status}`);
  const limitedStream: { body: string; roomId: string; addressed: boolean }[] = [];
  const limitedAgent = createSwitchAgent({ bridgeUrl: BRIDGE_URL, agentId: limited.agentId, apiKey: limited.apiKey });
  await limitedAgent.start({ message: (event) => void limitedStream.push({ body: event.body, roomId: event.roomId, addressed: event.addressed }) });
  await sleep(400);
  await hands.sam.post(await channelOf(roomA), `@${limited.name} are you there?`);
  await sleep(1_500);
  say(`  Sam names it in the listed room: heard ${JSON.stringify(limitedStream.map((event) => ({ room: label(event.roomId), addressed: event.addressed })))}`);

  const limitedBot = await bot(limited.name);
  const limitedDirect = await hands.sam.call("POST", "/channels/direct", [samId, limitedBot.id]);
  const limitedChannel = String(limitedDirect.body.id);
  made.channels.add(limitedChannel);
  limitedStream.length = 0;
  let limitedRoom: { room_id: string; name: string } | undefined;
  for (let attempts = 0; attempts < 5 && !limitedRoom; attempts += 1) {
    await hands.sam.post(limitedChannel, "refund order A-2004 in full please");
    await sleep(4_000);
    limitedRoom = (await opOf(limited)<{ room_id: string; name: string }[]>("list_rooms", {})).find((room) => room.name.includes(`sam / ${limited.name}`));
  }
  say(`  after 5 direct messages over 20 s: a room for it ${limitedRoom ? "exists" : "does not exist"}`);
  if (limitedRoom) {
    made.rooms.push(limitedRoom.room_id);
    labels.set(limitedRoom.room_id, "SAM'S DIRECT ROOM");
  }
  say(`  what the agent heard: ${JSON.stringify(limitedStream.map((event) => ({ room: label(event.roomId), addressed: event.addressed })))}`);
  const replies = (await hands.sam.posts(limitedChannel)).filter((post) => post.user_id === limitedBot.id).map((post) => post.message.slice(0, 150));
  say(`  what Sam was told: ${JSON.stringify([...new Set(replies)])}`);
  // The same rule against a private chat, the path no reader can see into.
  limitedStream.length = 0;
  const limitedChat = await gateway(await login("sam@clearance.example", personaPassword), "POST", "/chats", { agentId: limited.agentId, name: `spike-lchat-${stamp}`, requestId: randomUUID() });
  const limitedChatRoom = roomIdOfChat(limitedChat.body);
  say(`  Sam starts a private chat with it: HTTP ${limitedChat.status}${limitedChat.status >= 300 ? `: ${JSON.stringify(limitedChat.body).slice(0, 120)}` : ""}`);
  if (limitedChat.status < 300 && limitedChatRoom !== "undefined") {
    made.rooms.push(limitedChatRoom);
    labels.set(limitedChatRoom, "SAM'S PRIVATE CHAT");
    const samCookie = await login("sam@clearance.example", personaPassword);
    const sent = await gateway(samCookie, "POST", `/chats/${limitedChatRoom}/messages`, { text: "refund order A-2004 in full please", body: "refund order A-2004 in full please", requestId: randomUUID() });
    say(`  Sam writes in it: HTTP ${sent.status}${sent.status >= 300 ? `: ${JSON.stringify(sent.body).slice(0, 200)}` : ""}`);
    await sleep(2_000);
    say(`  what the agent heard: ${JSON.stringify(limitedStream.map((event) => ({ room: label(event.roomId), addressed: event.addressed })))}`);
  }
  const limitedDetail = await view<Detail>("get_agent_detail", { agent_id: limited.agentId });
  say(`  what another agent can read of the policy: ${JSON.stringify(limitedDetail.addressing)}`);
  await limitedAgent.stop();
} finally {
  if (live) await (live as SwitchAgent).stop();
  say("\ncleaning up");
  const mmLogin = await fetch(`${MATTERMOST_URL}/api/v4/users/login`, init("POST", null, { login_id: switchEnv.MATTERMOST_ADMIN_USER, password: switchEnv.MATTERMOST_ADMIN_PASSWORD }));
  const mmToken = mmLogin.headers.get("token")!;
  const mm = async (method: string, path: string) => {
    const res = await fetch(`${MATTERMOST_URL}/api/v4${path}`, { method, headers: { authorization: `Bearer ${mmToken}` } });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> };
  };
  for (const roomId of made.rooms) {
    const detail = (await gateway(gatewayAdmin, "GET", `/rooms/${roomId}`)).body as { external_channel_id?: string | null };
    if (detail.external_channel_id) made.channels.add(detail.external_channel_id);
    await gateway(gatewayAdmin, "DELETE", `/rooms/${roomId}`);
  }
  for (const channelId of made.channels) {
    const channel = (await mm("GET", `/channels/${channelId}`)).body as { type?: string; team_id?: string; name?: string };
    if (channel.type === "D" || !channel.team_id) continue;
    const team = (await mm("GET", `/teams/${channel.team_id}`)).body as { name?: string };
    execFileSync("docker", ["exec", "switch-mattermost-1", "mmctl", "--local", "channel", "delete", `${team.name}:${channel.name}`, "--confirm"], { stdio: "ignore" });
  }
  const teamId = String((await mm("GET", "/teams/name/switch")).body.id);
  for (const agent of [viewer, adminViewer, target, limited]) {
    await gateway(agent.owner, "DELETE", `/agents/${agent.agentId}`);
    const user = await hands.sam.call("GET", `/users/username/${agent.name}`);
    const id = (user.body as { id?: string }).id;
    if (user.status === 200 && id) {
      await mm("DELETE", `/teams/${teamId}/members/${id}`);
      await mm("DELETE", `/users/${id}`);
    }
  }
  say(`removed ${made.rooms.length} rooms and 4 agents`);
}

function roomIdOfChat(body: unknown): string {
  const chat = (body as { chat?: { id?: string; roomId?: string; room_id?: string } }).chat;
  return String(chat?.roomId ?? chat?.room_id ?? chat?.id);
}

async function channelOf(roomId: string): Promise<string> {
  return (await view<{ external_channel_id: string }>("get_room_detail", { room_id: roomId })).external_channel_id;
}

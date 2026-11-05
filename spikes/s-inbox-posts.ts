/**
 * Can Clearance's own Mattermost account read its real direct rooms and remove its own posts?
 *
 * Switch gives an agent no way to edit or delete a message, and the reader account can't see a real DM,
 * so an inbox in a DM would have no handles and would pile up. Mattermost's own API might do both, with
 * a token for the bot Switch made for the agent. Uses a throwaway agent, never `clearance`: the live stack
 * is shared. Prints no secrets.
 */
import { readFileSync } from "node:fs";
import { registerAgent } from "../packages/switch-agent/src/register.js";
import { createSwitchAgent } from "../packages/switch-agent/src/agent.js";
import { BRIDGE_URL, DATA_DIR, MATTERMOST_URL, identities, mattermost, say, secrets, sleep, waitFor } from "./lib.js";

const env = Object.fromEntries(
  readFileSync(process.env.SWITCH_ENV_FILE!, "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "")]),
);
const AGENT = "spike-clr-posts";
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const login = await fetch(`${BRIDGE_URL}/gateway/auth/login`, json({ email: "clearance-admin@clearance.example", password: secrets.clearanceAdminPassword }));
if (!login.ok) throw new Error(`owner login: ${login.status}`);
const cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
const key = (await (await fetch(`${BRIDGE_URL}/gateway/api-keys`, { ...json({ label: `spike-posts-${Date.now()}` }), headers: { "content-type": "application/json", cookie } })).json()) as { key: string; id: string };
const registered = await registerAgent({ bridgeUrl: BRIDGE_URL, registrationKey: key.key, name: AGENT, description: "Throwaway: spike for reading and removing an agent's own posts.", overwrite: true });
await fetch(`${BRIDGE_URL}/gateway/api-keys/${key.id}`, { method: "DELETE", headers: { cookie } });
// As real setup does, and first: a message from someone who may not address the agent opens no room.
const rowIds = Object.values(identities.people).map((person) => person.externalUserRowId);
const policy = await fetch(`${BRIDGE_URL}/gateway/agents/${registered.agentId}/addressing-policy`, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ policy: { rules: [{ users: rowIds, agents: "*", owner: true }] } }),
});
say(`addressing policy: HTTP ${policy.status}`);
const agent =createSwitchAgent({ bridgeUrl: BRIDGE_URL, agentId: registered.agentId, apiKey: registered.apiKey });
const events: string[] = [];
await agent.start({ message: (event) => void events.push(event.body) });
say(`registered ${AGENT}`);

const sam = mattermost("sam");
const samId = identities.people.sam!.mattermostUserId;
const roomName = `Mattermost: sam / ${AGENT}`;
const adminLogin = await fetch(`${MATTERMOST_URL}/api/v4/users/login`, json({ login_id: env.MATTERMOST_ADMIN_USER, password: env.MATTERMOST_ADMIN_PASSWORD }));
const adminToken = adminLogin.headers.get("token")!;
const admin = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${MATTERMOST_URL}/api/v4${path}`, { method, headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> };
};

// The bot appears when Switch first needs it. Being in a bridged room does that.
const room = await agent.op<{ id: string }>("create_room", { name: `spike-posts-${Date.now()}`, description: "Throwaway", agent_names: [AGENT], user_names: ["sam"], channel_type: "channel_private" });
const bot = await waitFor("the agent's Mattermost account", async () => {
  const res = await sam.call("GET", `/users/username/${AGENT}`);
  return res.status === 200 ? (res.body as unknown as { id: string; is_bot: boolean }) : undefined;
}, 30_000);
say(`its Mattermost account exists, is_bot=${bot.is_bot}, in room ${room.id.slice(0, 8)}`);

const direct = await sam.call("POST", "/channels/direct", [samId, bot.id]);
const channelId = String(direct.body.id);
await sam.post(channelId, "hello");
const dm = await waitFor("the direct room", async () => {
  const rooms = await agent.op<{ room_id: string; name: string }[]>("list_rooms", { include_archived: false });
  return rooms.find((entry) => entry.name === roomName);
}, 20_000);
say(`Sam opened a real DM; Switch made its room`);

// Can the reader account the core uses today see it?
const readerRes = await fetch(`${MATTERMOST_URL}/api/v4/channels/${channelId}/posts?per_page=5`, { headers: { authorization: `Bearer ${secrets.mattermostTokens.user}` } });
say(`the reader account reading the DM: HTTP ${readerRes.status}`);

// A token for the bot, minted the way setup mints the personas'.
const minted = await admin("POST", `/users/${bot.id}/tokens`, { description: "spike: own posts" });
say(`admin mints a token for the bot: HTTP ${minted.status}`);
if (minted.status !== 201 && minted.status !== 200) throw new Error(`mint: ${JSON.stringify(minted.body).slice(0, 300)}`);
const botToken = String(minted.body.token);
const asBot = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${MATTERMOST_URL}/api/v4${path}`, { method, headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> };
};
const read = await asBot("GET", `/channels/${channelId}/posts?per_page=5`);
say(`the bot reading its own DM: HTTP ${read.status}`);

// Post through Switch, find it through Mattermost, then remove it.
const before = events.length;
const sent = await agent.sendMessage(dm.room_id, "**Needs your response (1)**\nA1 CLR-0001 refund · #support · 0 s");
await sleep(600);
const posts = (await sam.posts(channelId)).filter((post) => post.user_id === bot.id);
const mine = posts.find((post) => post.message.includes("Needs your response"));
say(`posted through Switch (event ${String(sent.eventId).slice(0, 8)}); Sam sees it as: ${JSON.stringify(mine?.message)}`);
if (!mine) throw new Error("the post never appeared");

const patched = await asBot("PUT", `/posts/${mine.id}/patch`, { message: "**Needs your response (2)**\nedited" });
say(`the bot editing its post: HTTP ${patched.status}`);
const deleted = await asBot("DELETE", `/posts/${mine.id}`);
say(`the bot deleting its post: HTTP ${deleted.status}`);
await sleep(600);
const after = (await sam.posts(channelId)).find((post) => post.id === mine.id);
say(`Sam sees it after: ${after ? `still there, ${JSON.stringify(after.message)}` : "gone"}`);

// Someone else's post must stay out of reach, and nothing in the room may have noticed.
const samPost = await sam.post(channelId, "still talking");
const refused = await asBot("DELETE", `/posts/${samPost.id}`);
say(`the bot deleting Sam's post: HTTP ${refused.status}`);
await sleep(800);
const context = await agent.op<{ messages?: { body?: string; content?: string }[] }>("read_context", { limit: 10 }, { roomId: dm.room_id }).catch((error: Error) => ({ messages: [{ body: `read_context failed: ${error.message}` }] }));
say(`room context after the delete, newest ${context.messages?.length ?? 0}: ${JSON.stringify(context.messages?.map((m) => (m.body ?? m.content ?? "").slice(0, 50)))}`);
say(`stream heard: ${JSON.stringify(events.slice(before))}`);

// A later message still flows both ways.
await agent.sendMessage(dm.room_id, "a later message from the agent");
await sleep(500);
say(`later message reaches Sam: ${(await sam.posts(channelId)).some((post) => post.message.includes("a later message"))}`);
say(`left behind, for cleanup: room ${room.id}, room ${dm.room_id}, DM channel ${channelId}, agent ${registered.agentId}; data dir ${DATA_DIR}`);
await agent.stop();

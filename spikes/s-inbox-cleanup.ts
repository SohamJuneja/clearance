/**
 * Removes what s-inbox-posts.ts, s-inbox-live.ts, s-hidden-session.ts and s-hidden-live.ts left behind: their
 * rooms, channels, throwaway agents and those agents' bots. Goes by name, and only the names in ROOMS and AGENTS.
 * Lists by default. Deletes only with --delete.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { BRIDGE_URL, MATTERMOST_URL, say, secrets } from "./lib.js";

const remove = process.argv.includes("--delete");
const env = Object.fromEntries(
  readFileSync(process.env.SWITCH_ENV_FILE!, "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "")]),
);
const ROOMS = /^(spike-inbox-|spike-ledger-|spike-install-|spike-posts-|spike-seen-|spike-chat-|spike-lchat-)|^(Mattermost: )?\w+ \/ spike-(clr|tgt|tg2|lim|view|adm)-/;
const AGENTS = /^spike-(clr|tgt|tg2|lim|view|adm)-/;

const login = async (email: string, password: string) => {
  const res = await fetch(`${BRIDGE_URL}/gateway/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!res.ok) throw new Error(`login as ${email}: ${res.status}`);
  return res.headers.getSetCookie()[0]!.split(";")[0]!;
};
const adminCookie = await login(env.GATEWAY_ADMIN_EMAIL!, env.GATEWAY_ADMIN_PASSWORD!);
const gateway = async (cookie: string, method: string, path: string) => {
  const res = await fetch(`${BRIDGE_URL}/gateway${path}`, { method, headers: { cookie } });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON.
  }
  return { status: res.status, body };
};

const mmLogin = await fetch(`${MATTERMOST_URL}/api/v4/users/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ login_id: env.MATTERMOST_ADMIN_USER, password: env.MATTERMOST_ADMIN_PASSWORD }),
});
const mmToken = mmLogin.headers.get("token")!;
const mm = async (method: string, path: string) => {
  const res = await fetch(`${MATTERMOST_URL}/api/v4${path}`, { method, headers: { authorization: `Bearer ${mmToken}` } });
  return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
};

type Room = { id: string; name: string; external_channel_id?: string | null };
const listed = (await gateway(adminCookie, "GET", "/rooms?include_archived=true&limit=500")).body as Room[] | { rooms?: Room[]; items?: Room[] };
const allRooms: Room[] = Array.isArray(listed) ? listed : (listed.rooms ?? listed.items ?? []);
const rooms = allRooms.filter((room) => ROOMS.test(room.name));
say(`${rooms.length} of ${allRooms.length} rooms match:`);
for (const room of rooms) say(`  ${room.name}`);

// As the gateway admin: these agents have different owners.
const agentsBody = (await gateway(adminCookie, "GET", "/agents")).body as { id: string; name: string }[] | { agents?: { id: string; name: string }[]; items?: { id: string; name: string }[] };
const allAgents = Array.isArray(agentsBody) ? agentsBody : (agentsBody.agents ?? agentsBody.items ?? []);
const agents = allAgents.filter((agent) => AGENTS.test(agent.name));
say(`${agents.length} agents match: ${JSON.stringify(agents.map((agent) => agent.name))}`);

const users = (await mm("GET", "/users?per_page=200&page=0")).body as { id: string; username: string; delete_at: number }[];
const bots = users.filter((user) => AGENTS.test(user.username) && user.delete_at === 0);
say(`${bots.length} bots match: ${JSON.stringify(bots.map((bot) => bot.username))}`);

// A direct channel can't be deleted, and it stays in the person's sidebar after its bot is gone. These
// accounts appear in the demo, so each one's preference is turned off, as closing the conversation does.
const everyBot = users.filter((user) => AGENTS.test(user.username));
const shown: { person: string; botId: string }[] = [];
const asPerson = async (person: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${MATTERMOST_URL}/api/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${secrets.mattermostTokens[person]}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
};
for (const person of ["priya", "sam", "neha", "alex", "dev"]) {
  // Someone who never opened a direct channel has no such preferences, and gets a 404 rather than a list.
  const answer = (await asPerson(person, "GET", "/users/me/preferences/direct_channel_show")).body;
  const preferences = (Array.isArray(answer) ? answer : []) as { name: string; value: string }[];
  for (const bot of everyBot) {
    if (preferences.some((preference) => preference.name === bot.id && preference.value === "true")) shown.push({ person, botId: bot.id });
  }
}
say(`${shown.length} direct channels with these bots still showing in someone's sidebar`);

if (!remove) {
  say("Nothing removed. Pass --delete.");
  process.exit(0);
}

for (const { person, botId } of shown) {
  const me = (await asPerson(person, "GET", "/users/me")).body as { id: string };
  await asPerson(person, "PUT", `/users/${me.id}/preferences`, [{ user_id: me.id, category: "direct_channel_show", name: botId, value: "false" }]);
}

const channels = new Set<string>();
for (const room of rooms) {
  const detail = (await gateway(adminCookie, "GET", `/rooms/${room.id}`)).body as { external_channel_id?: string | null };
  if (detail.external_channel_id) channels.add(detail.external_channel_id);
  const gone = await gateway(adminCookie, "DELETE", `/rooms/${room.id}`);
  if (gone.status >= 300) say(`  room ${room.name}: HTTP ${gone.status}`);
}
for (const agent of agents) {
  const gone = await gateway(adminCookie, "DELETE", `/agents/${agent.id}`);
  if (gone.status >= 300) say(`  agent ${agent.name}: HTTP ${gone.status}`);
}
// Deleting a Switch room leaves its channel, and Switch would bridge it again. Bots count against the team limit.
for (const channelId of channels) {
  const detail = (await mm("GET", `/channels/${channelId}`)).body as { type?: string; team_id?: string; name?: string };
  if (detail.type === "D") continue;
  const team = (await mm("GET", `/teams/${detail.team_id}`)).body as { name: string };
  execFileSync("docker", ["exec", "switch-mattermost-1", "mmctl", "--local", "channel", "delete", `${team.name}:${detail.name}`, "--confirm"], { stdio: "ignore" });
}
const team = (await mm("GET", `/teams/name/switch`)).body as { id: string };
for (const bot of bots) {
  await mm("DELETE", `/teams/${team.id}/members/${bot.id}`);
  await mm("DELETE", `/users/${bot.id}`);
}
say(`removed ${rooms.length} rooms, ${agents.length} agents, ${channels.size} channels (direct ones stay, with their bot gone), ${bots.length} bots`);

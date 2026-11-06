/**
 * Clears what spikes and E1's live check left on the live stack: agents, rooms, channels and bots named with an exact
 * prefix, and two rooms by name. Everything else that looks stale is listed and left alone.
 *
 *   pnpm exec tsx scripts/clear-leftovers.ts            prints what it would change, and changes nothing
 *   pnpm exec tsx scripts/clear-leftovers.ts --apply    prints the same list, applies it, then reads the stack again
 *
 * Safe to run twice: whatever is already gone isn't in the list. It only talks to our own `switch` stack, and refuses
 * any other address. A bot is deactivated rather than erased, because Mattermost keeps a user's posts.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PEOPLE, personaTokens } from "./demo/greet.ts";
import {
  BRIDGE_URL,
  ownerGateway,
  type OwnerGateway,
  readDotenv,
  ROOT,
  roomLabel,
} from "./gateway-owner.ts";

export const PREFIXES = ["spike-", "e1-live-"] as const;
export const ROOMS = ["clearance-identity-probe", "fence-proof"] as const;
/** E2 needs these. Nothing above can match them, and this says so out loud if that ever changes. */
export const KEEP = ["ops-vanilla", "ops-agent-vanilla"] as const;

const STACK = "switch";
const MATTERMOST_URL = "http://127.0.0.1:8065";
const MATTERMOST_CONTAINER = `${STACK}-mattermost-1`;
const PAGE = 200;

const KNOWN_ACCOUNTS = new Set([
  ...PEOPLE,
  "clearance",
  "refunds-agent",
  "refunds-agent-vanilla",
  "ops-agent",
  "ops-agent-vanilla",
  "coder",
  // In templates/acme-mini.template.yaml. Each waits for a login, Codex and Cursor, so it has a bot and no agent yet.
  "support-agent",
  "reviewer",
  "study-bot",
  // The stack's own.
  "admin",
  "switch-admin",
  "system-bot",
]);
const KNOWN_CHANNELS = new Set([
  "off-topic",
  "town-square",
  "approvals",
  "eng",
  "finance",
  "support",
  "support-vanilla",
  "ops-vanilla",
]);
const KNOWN_ROOMS = new Set([
  "Off-Topic",
  "Town Square",
  "approvals",
  "eng",
  "finance",
  "support",
  "support-vanilla",
  "ops-vanilla",
]);

export type Named = { id: string; name: string };
export type Snapshot = {
  rooms: Named[];
  agents: Named[];
  users: (Named & { deleted: boolean; bot: boolean })[];
  channels: (Named & { team: string; type: string })[];
  /** People whose sidebar still shows a direct channel with one of the leftover bots. */
  sidebars: { person: string; botId: string; botName: string }[];
  machines: { owner: string; name: string; revoked: boolean; running?: number }[];
};
export type Plan = {
  rooms: Named[];
  agents: Named[];
  channels: Named[];
  bots: Named[];
  sidebars: Snapshot["sidebars"];
  /** Not ours to remove on this reading. Each line says why it looks stale. */
  listed: string[];
};

/** The whole rule for what may be removed. A name that merely contains a prefix doesn't count. */
export function isLeftover(name: string): boolean {
  if ((KEEP as readonly string[]).includes(name)) return false;
  return (
    PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    (ROOMS as readonly string[]).includes(name)
  );
}

const isDirectRoom = (label: string): boolean => label.includes(" / ");
/** The study's rooms, their channels and its participants' accounts. They're real, and listing them would bury the rest. */
const isStudyName = (name: string): boolean =>
  /^study-p\d+(-[0-9a-f]+)?$/.test(name) || /^p\d\d$/.test(name);
const isRetired = (name: string): boolean => /-take-\d{8}-\d{6}/.test(name);
const mentionsPrefix = (name: string): boolean => PREFIXES.some((prefix) => name.includes(prefix));

/** Why something outside the rule looks stale, or undefined if it is what the stack should hold. */
export function staleReason(
  kind: "room" | "account" | "channel",
  name: string,
): string | undefined {
  if (isLeftover(name)) return undefined;
  if (kind === "room") {
    const label = roomLabel(name);
    if (isLeftover(label) || KNOWN_ROOMS.has(label) || isStudyName(label) || isRetired(label))
      return undefined;
    if (isDirectRoom(label)) {
      if (label.endsWith(" / clearance")) return undefined;
      if (mentionsPrefix(label))
        return "a direct room with a leftover bot, not named with the exact prefix";
      return "a direct room with a protected agent, archived at each take by scripts/demo/stray-rooms.ts";
    }
    return "a room this project doesn't define";
  }
  if (kind === "channel") {
    if (KNOWN_CHANNELS.has(name) || isStudyName(name) || isRetired(name)) return undefined;
    return "a channel this project doesn't define";
  }
  if (KNOWN_ACCOUNTS.has(name) || isStudyName(name)) return undefined;
  return "an account this project doesn't define";
}

/** What would change, from what's there. No network, so tests can hold it to the rule. */
export function buildPlan(snapshot: Snapshot): Plan {
  const rooms = snapshot.rooms.filter((room) => isLeftover(roomLabel(room.name)));
  const agents = snapshot.agents.filter((agent) => isLeftover(agent.name));
  const channels = snapshot.channels.filter(
    (channel) =>
      channel.team === STACK &&
      channel.type !== "D" &&
      channel.type !== "G" &&
      isLeftover(channel.name),
  );
  const bots = snapshot.users.filter((user) => !user.deleted && isLeftover(user.name));

  const listed: string[] = [];
  for (const room of snapshot.rooms) {
    const why = staleReason("room", room.name);
    if (why) listed.push(`room ${room.name}: ${why}`);
  }
  for (const channel of snapshot.channels) {
    const why =
      channel.team === STACK
        ? staleReason("channel", channel.name)
        : `a channel in another team (${channel.team})`;
    if (why) listed.push(`channel ${channel.name}: ${why}`);
  }
  for (const user of snapshot.users) {
    if (user.deleted) continue;
    const why = staleReason("account", user.name);
    if (why && user.bot) listed.push(`bot ${user.name}: ${why}`);
    else if (why) listed.push(`user ${user.name}: ${why}`);
  }
  const retired = snapshot.channels.filter(
    (channel) => channel.team === STACK && isRetired(channel.name),
  ).length;
  if (retired > 0)
    listed.push(
      `${retired} retired *-take-* channels: kept on purpose, each holds an earlier take's posts`,
    );
  for (const machine of snapshot.machines) {
    if (machine.revoked) listed.push(`machine ${machine.name} (${machine.owner}): revoked`);
    else if (machine.running === undefined)
      listed.push(`machine ${machine.name} (${machine.owner}): has reported no status`);
  }
  return { rooms, agents, channels, bots, sidebars: snapshot.sidebars, listed };
}

export function describePlan(plan: Plan): string[] {
  const section = (title: string, names: string[]): string[] =>
    names.length === 0
      ? [`${title}: none`]
      : [`${title}: ${names.length}`, ...names.map((name) => `  ${name}`)];
  return [
    ...section(
      "Switch rooms to delete",
      plan.rooms.map((room) => room.name),
    ),
    ...section(
      "Switch agents to delete",
      plan.agents.map((agent) => agent.name),
    ),
    ...section(
      "Mattermost channels to delete",
      plan.channels.map((channel) => channel.name),
    ),
    ...section(
      "Mattermost bots to deactivate",
      plan.bots.map((bot) => bot.name),
    ),
    ...section(
      "Direct channels to hide from a person's sidebar",
      plan.sidebars.map((shown) => `${shown.person} / ${shown.botName}`),
    ),
    ...section("Left alone, but it looks stale", plan.listed),
  ];
}

export const isEmptyPlan = (plan: Plan): boolean =>
  [plan.rooms, plan.agents, plan.channels, plan.bots, plan.sidebars].every(
    (part) => part.length === 0,
  );

type Mattermost = {
  call(method: string, path: string, json?: unknown): Promise<{ status: number; body: unknown }>;
};

async function mattermostAdmin(): Promise<Mattermost> {
  const env = readDotenv(join(ROOT, "vendor/switch/.env"));
  const login = await fetch(`${MATTERMOST_URL}/api/v4/users/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      login_id: env.MATTERMOST_ADMIN_USER,
      password: env.MATTERMOST_ADMIN_PASSWORD,
    }),
  });
  const token = login.headers.get("token");
  if (!token) throw new Error(`Mattermost admin login: HTTP ${login.status}`);
  return authorised(token);
}

function authorised(token: string): Mattermost {
  return {
    call: async (method, path, json) => {
      const res = await fetch(`${MATTERMOST_URL}/api/v4${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as unknown };
    },
  };
}

async function allPages<T>(mattermost: Mattermost, path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; ; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const { status, body } = await mattermost.call(
      "GET",
      `${path}${separator}per_page=${PAGE}&page=${page}`,
    );
    if (status !== 200) throw new Error(`Mattermost: GET ${path} answered ${status}`);
    const rows = body as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

function listOf<T>(body: unknown, ...keys: string[]): T[] {
  if (Array.isArray(body)) return body as T[];
  for (const key of keys) {
    const value = (body as Record<string, unknown> | null)?.[key];
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

async function readStack(admin: OwnerGateway, mattermost: Mattermost): Promise<Snapshot> {
  const rooms = listOf<Named>(
    await admin.must("GET", "/rooms?include_archived=true&limit=500"),
    "rooms",
    "items",
  );
  const agents = listOf<Named>(await admin.must("GET", "/agents"), "agents", "items");
  const users = (
    await allPages<{ id: string; username: string; delete_at: number; is_bot?: boolean }>(
      mattermost,
      "/users",
    )
  ).map((user) => ({
    id: user.id,
    name: user.username,
    deleted: user.delete_at !== 0,
    bot: Boolean(user.is_bot),
  }));
  const rawChannels = await allPages<{
    id: string;
    name: string;
    team_name?: string;
    type: string;
  }>(mattermost, "/channels?include_deleted=true");
  const channels = rawChannels.map((channel) => ({
    id: channel.id,
    name: channel.name,
    team: channel.team_name ?? "",
    type: channel.type,
  }));

  // Deactivated bots too: a person's sidebar keeps their direct channel after the bot has gone.
  const leftoverBots = users.filter((user) => isLeftover(user.name));
  const tokens = personaTokens(ROOT);
  const sidebars: Snapshot["sidebars"] = [];
  for (const person of PEOPLE) {
    const token = tokens[person];
    if (!token) continue;
    const answer = await authorised(token).call("GET", "/users/me/preferences/direct_channel_show");
    const shown = listOf<{ name: string; value: string }>(answer.body);
    for (const bot of leftoverBots) {
      if (shown.some((preference) => preference.name === bot.id && preference.value === "true")) {
        sidebars.push({ person, botId: bot.id, botName: bot.name });
      }
    }
  }

  const machines: Snapshot["machines"] = [];
  for (const owner of ["alex", "priya"]) {
    const gateway = await ownerGateway(owner);
    for (const machine of await gateway.must<
      {
        name: string;
        revoked_at?: string | null;
        status?: { machine?: { sessions_running?: number } };
      }[]
    >("GET", "/management/controllers")) {
      machines.push({
        owner,
        name: machine.name,
        revoked: Boolean(machine.revoked_at),
        running: machine.status?.machine?.sessions_running,
      });
    }
  }
  return { rooms, agents, users, channels, sidebars, machines };
}

/** Applies a plan and returns what could not be done. Order matters: Switch would bridge a channel whose room is kept. */
async function applyPlan(
  plan: Plan,
  admin: OwnerGateway,
  mattermost: Mattermost,
): Promise<string[]> {
  const failed: string[] = [];
  const tokens = personaTokens(ROOT);
  for (const { person, botId, botName } of plan.sidebars) {
    const asPerson = authorised(tokens[person] ?? "");
    const me = (await asPerson.call("GET", "/users/me")).body as { id: string };
    const { status } = await asPerson.call("PUT", `/users/${me.id}/preferences`, [
      { user_id: me.id, category: "direct_channel_show", name: botId, value: "false" },
    ]);
    if (status >= 300) failed.push(`hide ${botName} from ${person}: HTTP ${status}`);
  }
  for (const room of plan.rooms) {
    const { status } = await admin.call("DELETE", `/rooms/${room.id}`);
    if (status >= 300) failed.push(`room ${room.name}: HTTP ${status}`);
  }
  for (const agent of plan.agents) {
    const { status } = await admin.call("DELETE", `/agents/${agent.id}`);
    if (status >= 300) failed.push(`agent ${agent.name}: HTTP ${status}`);
  }
  for (const channel of plan.channels) {
    try {
      execFileSync(
        "docker",
        [
          "exec",
          MATTERMOST_CONTAINER,
          "mmctl",
          "--local",
          "channel",
          "delete",
          `${STACK}:${channel.name}`,
          "--confirm",
        ],
        { stdio: "ignore" },
      );
    } catch {
      failed.push(`channel ${channel.name}: mmctl refused`);
    }
  }
  const team = (await mattermost.call("GET", `/teams/name/${STACK}`)).body as { id: string };
  for (const bot of plan.bots) {
    await mattermost.call("DELETE", `/teams/${team.id}/members/${bot.id}`);
    const { status } = await mattermost.call("DELETE", `/users/${bot.id}`);
    if (status >= 300) failed.push(`bot ${bot.name}: HTTP ${status}`);
  }
  return failed;
}

async function main(): Promise<number> {
  const apply = process.argv.includes("--apply");
  if (new URL(BRIDGE_URL).port !== "8000")
    throw new Error(`refusing a Switch at ${BRIDGE_URL}: this only clears our own stack`);
  const admin = await ownerGateway("admin");
  const mattermost = await mattermostAdmin();
  const plan = buildPlan(await readStack(admin, mattermost));
  for (const line of describePlan(plan)) console.log(line);
  if (!apply) {
    console.log(isEmptyPlan(plan) ? "\nNothing to change." : "\nNothing changed. Pass --apply.");
    return 0;
  }
  if (isEmptyPlan(plan)) {
    console.log("\nNothing to change.");
    return 0;
  }
  const failed = await applyPlan(plan, admin, mattermost);
  const after = buildPlan(await readStack(admin, mattermost));
  console.log("\nApplied. What's left to change, read back from the stack:");
  for (const line of describePlan({ ...after, listed: [] }).slice(0, -1)) console.log(line);
  for (const line of failed) console.log(`FAILED ${line}`);
  return failed.length === 0 && isEmptyPlan(after) ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (status) => process.exit(status),
    (error: unknown) => {
      process.stderr.write(`clear-leftovers failed: ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}

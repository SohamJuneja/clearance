/**
 * Provisions the in-Switch study (PLAN 11.5). Idempotent, and never prints a credential.
 *
 *   tsx scripts/setup-study-accounts.ts                 p01 to p20
 *   tsx scripts/setup-study-accounts.ts --count 4       p01 to p04 only
 *   tsx scripts/setup-study-accounts.ts --dry-run       says what it would do, changes nothing
 *   tsx scripts/setup-study-accounts.ts --reset p01     a fresh room and password, after a rehearsal
 *   tsx scripts/setup-study-accounts.ts --retire p07    ends p07's one-time password after their session
 *
 * For each participant: a Mattermost account with its own one-time password, a Switch user, the link
 * between them confirmed with the account's own session, and one private room holding that person and
 * `study-bot`. The bridge also adds its default member and admin to every channel it creates; they can
 * see the room, and the addressing policy stops them answering in it.
 *
 * `study-bot` has its own owner, `study-admin`, who owns nothing else: not clearance-admin and not a
 * persona, because two agents with one owner can rewrite each other's addressing policy (PLAN 6.6).
 *
 * Writes data/study-accounts.json, mode 600. Saved after every step that creates a credential, because
 * those are only shown once.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { registerAgent } from "../packages/switch-agent/src/register.js";
import { addressingRules, participantIds, raisedTeamLimit, roomNameFor, type ParticipantAccount, type StudyAccounts } from "../study/lib/accounts";
import { assignGroup } from "../study/lib/protocol";
import {
  BRIDGE_URL,
  DATA_DIR,
  EMAIL_DOMAIN,
  MATTERMOST_URL,
  SWITCH_ENV_FILE,
  call,
  ensureMattermostAccount,
  ensureSwitchUser,
  expectOk,
  fail,
  gatewayLogin,
  linkAccount,
  log,
  mattermostLogin,
  need,
  readEnvFile,
  readJson,
  writePrivate,
} from "./lib-provisioning.js";

const AGENT_NAME = "study-bot";
const OWNER_NAME = "study-admin";
const ACCOUNTS_FILE = join(DATA_DIR, "study-accounts.json");

type Args = { dryRun: boolean; count: number; reset: string[]; retire: string[] };

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, count: 20, reset: [], retire: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => argv[++index] ?? fail(`${String(flag)} needs a value`);
    if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--count") args.count = Number(value());
    else if (flag === "--reset") args.reset.push(...value().split(","));
    else if (flag === "--retire") args.retire.push(...value().split(","));
    else fail(`unknown argument: ${String(flag)}`);
  }
  return args;
}

const secret = () => randomBytes(15).toString("base64url");
const emailOf = (participant: string) => `${participant}@${EMAIL_DOMAIN}`;

type Stack = { mmAdmin: string; adminCookie: string; teamId: string; teamName: string; bridgeId: string };

async function connect(env: Record<string, string>): Promise<Stack> {
  const mmAdmin = await mattermostLogin(need(env, "MATTERMOST_ADMIN_USER"), need(env, "MATTERMOST_ADMIN_PASSWORD"));
  const teamName = need(env, "MATTERMOST_TEAM_NAME");
  const team = expectOk(await call(MATTERMOST_URL, "GET", `/api/v4/teams/name/${teamName}`, { token: mmAdmin }), `reading team ${teamName}`);
  const adminCookie = await gatewayLogin(need(env, "GATEWAY_ADMIN_EMAIL"), need(env, "GATEWAY_ADMIN_PASSWORD"));
  const bridges = await call(BRIDGE_URL, "GET", "/gateway/collaborations", { cookie: adminCookie });
  expectOk(bridges, "listing bridges");
  const bridge = (bridges.body as { bridge_id: string; bridge_type: string }[]).find((entry) => entry.bridge_type === "mattermost");
  if (!bridge) fail("no Mattermost bridge is registered on this Switch");
  return { mmAdmin, adminCookie, teamId: String(team.id), teamName, bridgeId: bridge.bridge_id };
}

/** The team's limit, and what it should become. */
async function teamLimit(stack: Stack): Promise<{ current: unknown; raised: number | null }> {
  const config = expectOk(await call(MATTERMOST_URL, "GET", "/api/v4/config", { token: stack.mmAdmin }), "reading Mattermost's config");
  const current = (config.TeamSettings as { MaxUsersPerTeam?: unknown } | undefined)?.MaxUsersPerTeam;
  return { current, raised: raisedTeamLimit(current) };
}

async function ensureTeamRoom(stack: Stack): Promise<void> {
  const { current, raised } = await teamLimit(stack);
  if (raised === null) return;
  expectOk(
    await call(MATTERMOST_URL, "PUT", "/api/v4/config/patch", { token: stack.mmAdmin, json: { TeamSettings: { MaxUsersPerTeam: raised } } }),
    "raising the team's size limit",
  );
  log(`mattermost: raised the team size limit from ${String(current)} to ${raised}`);
}

/** The agent's API key is shown once, so a saved one is kept for as long as it still works. */
async function ensureAgent(ownerCookie: string, saved: StudyAccounts["agent"] | undefined): Promise<StudyAccounts["agent"]> {
  if (saved) {
    const probe = await call(BRIDGE_URL, "GET", `/agents/${saved.switchAgentId}/ops`, { token: saved.apiKey });
    if (probe.status === 200) return saved;
  }
  const key = await call(BRIDGE_URL, "POST", "/gateway/api-keys", { cookie: ownerCookie, json: { label: `study-setup-${Date.now()}` } });
  const keyBody = expectOk(key, `minting ${OWNER_NAME}'s registration key`);
  const registered = await registerAgent({
    bridgeUrl: BRIDGE_URL,
    registrationKey: String(keyBody.key),
    name: AGENT_NAME,
    displayName: "Study bot",
    description: "Runs the Clearance user study: posts example approval cards. Nothing it asks about is real.",
    // Rotates the key when one was lost. Switch refuses it when another owner holds the name.
    overwrite: true,
  });
  await call(BRIDGE_URL, "DELETE", `/gateway/api-keys/${String(keyBody.id)}`, { cookie: ownerCookie });
  log(`switch: registered ${AGENT_NAME}`);
  return { name: AGENT_NAME, switchAgentId: registered.agentId, apiKey: registered.apiKey };
}

const op = async <T>(agent: StudyAccounts["agent"], name: string, args: unknown): Promise<T> => {
  const res = await call(BRIDGE_URL, "POST", `/agents/${agent.switchAgentId}/ops/${name}`, { token: agent.apiKey, json: args });
  return expectOk(res, `operation ${name}`).result as T;
};

type ListedRoom = { room_id: string; name: string; archived: boolean };
type ContextEntry = { sender?: string; sender_name?: string };
type Thread = { root: ContextEntry; replies: ContextEntry[] };

/** The room, made if missing. The bot is its creator, and is a member because it lists itself. */
async function ensureRoom(agent: StudyAccounts["agent"], participant: string): Promise<{ roomId: string; channelId: string }> {
  const name = roomNameFor(participant);
  const rooms = await op<ListedRoom[]>(agent, "list_rooms", { include_archived: true });
  const found = rooms.find((room) => room.name === name);
  let roomId = found?.room_id;
  if (found?.archived) await op(agent, "unarchive_room", { room_id: found.room_id });
  if (!roomId) {
    const created = await op<{ id: string }>(agent, "create_room", {
      name,
      description: "Your room for the Clearance study. Nothing here is real.",
      agent_names: [AGENT_NAME],
      user_names: [participant],
      channel_type: "channel_private",
    });
    roomId = created.id;
    log(`switch: made room ${name}`);
  }
  const detail = await op<{ external_channel_id?: string | null }>(agent, "get_room_detail", { room_id: roomId });
  if (!detail.external_channel_id) fail(`room ${name} has no Mattermost channel`);
  return { roomId, channelId: detail.external_channel_id };
}

/** No API lists a person's participant id, so it is read off their join entry in the room's history. */
async function readParticipantId(agent: StudyAccounts["agent"], roomId: string, participant: string): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) await new Promise((done) => setTimeout(done, 1000));
    const context = await op<{ threads: Thread[] }>(agent, "read_context", { room_id: roomId, limit: 100 });
    for (const thread of context.threads) {
      for (const entry of [thread.root, ...thread.replies]) {
        if (entry.sender_name === participant && entry.sender) return entry.sender;
      }
    }
  }
  return fail(`no participant id for ${participant} in its room`);
}

/** Confirmed on the bridge's own list, so a re-run needs no login as the person. */
async function isLinked(adminCookie: string, bridgeId: string, mattermostUserId: string, switchUserId: string): Promise<{ linked: boolean; rowId?: string }> {
  const users = await call(BRIDGE_URL, "GET", `/gateway/collaborations/${bridgeId}/users`, { cookie: adminCookie });
  expectOk(users, "listing the bridge's users");
  const row = (users.body as { id: string; external_user_id: string; claimed_by: { user_id: string; verified: boolean }[] }[]).find(
    (entry) => entry.external_user_id === mattermostUserId,
  );
  return { linked: Boolean(row?.claimed_by.some((claim) => claim.user_id === switchUserId && claim.verified)), rowId: row?.id };
}

async function ensureParticipant(stack: Stack, participant: string, agent: StudyAccounts["agent"], saved: ParticipantAccount | undefined): Promise<ParticipantAccount> {
  const oneTimePassword = saved?.oneTimePassword ?? secret();
  const switchPassword = saved?.switchPassword ?? secret();
  const mattermostUserId = await ensureMattermostAccount(stack.mmAdmin, stack.teamId, participant, oneTimePassword);
  // The account may outlive the file. Without the old password it can only be given a new one.
  if (!saved) {
    expectOk(
      await call(MATTERMOST_URL, "PUT", `/api/v4/users/${mattermostUserId}/password`, { token: stack.mmAdmin, json: { new_password: oneTimePassword } }),
      `setting ${participant}'s password`,
    );
  }
  const switchUserId = await ensureSwitchUser(stack.adminCookie, participant, emailOf(participant), switchPassword);

  let link = await isLinked(stack.adminCookie, stack.bridgeId, mattermostUserId, switchUserId);
  if (!link.linked) {
    const cookie = await gatewayLogin(emailOf(participant), switchPassword).catch((error: Error) =>
      fail(`${participant} has a Switch user whose password is unknown and no confirmed link. Cause: ${error.message}`),
    );
    await linkAccount(cookie, stack.bridgeId, participant, mattermostUserId, oneTimePassword);
    link = await isLinked(stack.adminCookie, stack.bridgeId, mattermostUserId, switchUserId);
    if (!link.linked || !link.rowId) fail(`linking ${participant} did not take`);
  }

  const { roomId, channelId } = await ensureRoom(agent, participant);
  const participantId = saved?.participantId ?? (await readParticipantId(agent, roomId, participant));
  return {
    mattermostUser: participant,
    mattermostUserId,
    switchUserId,
    externalUserRowId: link.rowId ?? fail(`${participant} has no row on the bridge`),
    participantId,
    roomId,
    channelId,
    oneTimePassword,
    switchPassword,
    retired: false,
  };
}

async function setPolicy(ownerCookie: string, accounts: StudyAccounts): Promise<void> {
  const rules = addressingRules(Object.values(accounts.participants).filter((participant) => !participant.retired));
  expectOk(
    await call(BRIDGE_URL, "PUT", `/gateway/agents/${accounts.agent.switchAgentId}/addressing-policy`, { cookie: ownerCookie, json: { policy: { rules } } }),
    "setting the bot's addressing policy",
  );
}

/** Reports what a run would do, from reads alone. */
async function dryRun(stack: Stack, ids: string[], saved: Partial<StudyAccounts>): Promise<void> {
  const users = await call(BRIDGE_URL, "GET", "/gateway/users", { cookie: stack.adminCookie });
  expectOk(users, "listing Switch users");
  const emails = new Set((users.body as { email: string }[]).map((user) => user.email));
  const rooms = saved.agent ? await op<ListedRoom[]>(saved.agent, "list_rooms", { include_archived: true }) : [];
  const roomNames = new Set(rooms.map((room) => room.name));
  log(`dry run: nothing will change. Accounts file: ${ACCOUNTS_FILE}`);
  const limit = await teamLimit(stack);
  log(`  team size limit: ${String(limit.current)}${limit.raised === null ? "" : `, would raise to ${limit.raised}`}`);
  log(`  owner ${OWNER_NAME}: ${emails.has(`${OWNER_NAME}@${EMAIL_DOMAIN}`) ? "exists" : "would create"}`);
  log(`  agent ${AGENT_NAME}: ${saved.agent ? "exists" : "would register"}`);
  for (const participant of ids) {
    const account = await call(MATTERMOST_URL, "GET", `/api/v4/users/username/${participant}`, { token: stack.mmAdmin });
    const parts = [
      `mattermost ${account.status === 200 ? "exists" : "would create"}`,
      `switch user ${emails.has(emailOf(participant)) ? "exists" : "would create"}`,
      `room ${roomNames.has(roomNameFor(participant)) ? "exists" : "would create"}`,
      `group ${assignGroup(participant).group}`,
    ];
    log(`  ${participant}: ${parts.join(", ")}`);
  }
}

/** The participant cannot have used a retired password, and the old room's history goes with it. */
async function reset(stack: Stack, ownerCookie: string, accounts: StudyAccounts, participant: string, save: () => void): Promise<void> {
  const saved = accounts.participants[participant] ?? fail(`${participant} is not provisioned`);
  // The channel first: a room deleted while its channel lives gets auto-bridged again by the next event.
  expectOk(await call(MATTERMOST_URL, "DELETE", `/api/v4/channels/${saved.channelId}`, { token: stack.mmAdmin }), `archiving ${participant}'s channel`);
  expectOk(await call(BRIDGE_URL, "DELETE", `/gateway/rooms/${saved.roomId}`, { cookie: stack.adminCookie }), `deleting ${participant}'s room`);
  const oneTimePassword = secret();
  expectOk(await call(MATTERMOST_URL, "PUT", `/api/v4/users/${saved.mattermostUserId}/active`, { token: stack.mmAdmin, json: { active: true } }), `reactivating ${participant}`);
  expectOk(
    await call(MATTERMOST_URL, "PUT", `/api/v4/users/${saved.mattermostUserId}/password`, { token: stack.mmAdmin, json: { new_password: oneTimePassword } }),
    `rotating ${participant}'s password`,
  );
  expectOk(await call(MATTERMOST_URL, "POST", `/api/v4/users/${saved.mattermostUserId}/sessions/revoke/all`, { token: stack.mmAdmin }), `ending ${participant}'s sessions`);
  const { roomId, channelId } = await ensureRoom(accounts.agent, participant);
  accounts.participants[participant] = { ...saved, oneTimePassword, roomId, channelId, retired: false };
  save();
  await setPolicy(ownerCookie, accounts);
  log(`reset ${participant}: new room and new password`);
}

async function retire(stack: Stack, ownerCookie: string, accounts: StudyAccounts, participant: string, save: () => void): Promise<void> {
  const saved = accounts.participants[participant] ?? fail(`${participant} is not provisioned`);
  expectOk(await call(MATTERMOST_URL, "POST", `/api/v4/users/${saved.mattermostUserId}/sessions/revoke/all`, { token: stack.mmAdmin }), `ending ${participant}'s sessions`);
  expectOk(await call(MATTERMOST_URL, "PUT", `/api/v4/users/${saved.mattermostUserId}/active`, { token: stack.mmAdmin, json: { active: false } }), `deactivating ${participant}`);
  accounts.participants[participant] = { ...saved, retired: true };
  save();
  await setPolicy(ownerCookie, accounts);
  log(`retired ${participant}: its password no longer works`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ids = participantIds(args.count);
  const env = readEnvFile(SWITCH_ENV_FILE);
  const stack = await connect(env);
  const previous = readJson<Partial<StudyAccounts>>(ACCOUNTS_FILE) ?? {};

  if (args.dryRun) {
    await dryRun(stack, ids, previous);
    return;
  }

  await ensureTeamRoom(stack);

  const ownerEmail = `${OWNER_NAME}@${EMAIL_DOMAIN}`;
  const ownerPassword = previous.owner?.password ?? secret();
  const ownerId = await ensureSwitchUser(stack.adminCookie, OWNER_NAME, ownerEmail, ownerPassword);
  const ownerCookie = await gatewayLogin(ownerEmail, ownerPassword).catch((error: Error) =>
    fail(`${OWNER_NAME} exists but its password is unknown (was ${ACCOUNTS_FILE} lost?). Cause: ${error.message}`),
  );

  const accounts: StudyAccounts = {
    bridgeId: stack.bridgeId,
    mattermostTeam: stack.teamName,
    owner: { name: OWNER_NAME, email: ownerEmail, switchUserId: ownerId, password: ownerPassword },
    agent: { name: AGENT_NAME, switchAgentId: "", apiKey: "" },
    participants: { ...previous.participants },
  };
  const save = () => writePrivate(ACCOUNTS_FILE, accounts);

  accounts.agent = await ensureAgent(ownerCookie, previous.agent);
  save();

  if (args.reset.length > 0 || args.retire.length > 0) {
    for (const participant of args.reset) await reset(stack, ownerCookie, accounts, participant, save);
    for (const participant of args.retire) await retire(stack, ownerCookie, accounts, participant, save);
    return;
  }

  for (const participant of ids) {
    const saved = accounts.participants[participant];
    if (saved?.retired) {
      log(`${participant}: retired, left alone`);
      continue;
    }
    accounts.participants[participant] = await ensureParticipant(stack, participant, accounts.agent, saved);
    save();
  }
  await setPolicy(ownerCookie, accounts);
  log(`ready: ${ids.length} participants, ${AGENT_NAME} owned by ${OWNER_NAME}. Wrote ${ACCOUNTS_FILE} (mode 600).`);
}

main().catch((error: unknown) => {
  process.stderr.write(`setup-study-accounts failed: ${(error as Error).message}\n`);
  process.exit(1);
});

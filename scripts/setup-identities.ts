/**
 * Creates every identity the Clearance demo needs, against a running Switch stack, with no browser.
 * Idempotent: run it as often as you like. It never prints a secret.
 *
 *   PERSONA_PASSWORD=... CLEARANCE_DATA_DIR=/abs/data SWITCH_ENV_FILE=/abs/vendor/switch/.env \
 *     pnpm exec tsx scripts/setup-identities.ts
 *
 * What it does:
 *  1. Mattermost: accounts priya, sam, neha, alex and guest, team membership, personal access tokens.
 *  2. Switch: a user per persona and each Mattermost account linked to it, confirmed with the account's
 *     own session (the same route Switch's own setup container uses for its seeded account). `guest`
 *     gets no Switch user and no link: an unlinked account must stay unable to answer anything.
 *  3. Switch: the dedicated user `clearance-admin` and the `clearance` agent it owns (PLAN 4.4, 6.6).
 *     The deployment's AGENT_REGISTRATION_TOKEN is deliberately not used: it resolves to a shared
 *     bootstrap owner, and two agents with one owner can rewrite each other's addressing policy.
 *  4. Clearance's addressing policy: the linked personas may address it, and so answer its cards. No
 *     other person may. Agents may: they cannot answer a card, and refusing one makes Clearance reply
 *     with a mention that wakes it. See spikes S3 and S4 in spikes/RESULTS-switchboard.md.
 *  5. Participant ids, read from Switch rather than guessed, via a throwaway archived room.
 *  6. A direct room between Clearance and each linked persona. Mattermost only lets the person open a
 *     DM (spike S7), so each persona does, with its own token, and says hello.
 *
 * Writes data/identities.json and data/secrets.json, both mode 600.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { directRoomName } from "../packages/switch-agent/src/chat-port.js";
import { registerAgent } from "../packages/switch-agent/src/register.js";
import {
  BRIDGE_URL,
  DATA_DIR,
  EMAIL_DOMAIN,
  MATTERMOST_URL,
  SWITCH_ENV_FILE,
  call,
  ensureAccessToken,
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
  sayUntilHeard,
} from "./lib-provisioning.js";

const LINKED_PERSONAS = ["priya", "sam", "neha", "alex", "dev"] as const;
const UNLINKED_PERSONAS = ["guest"] as const;
const ALL_PERSONAS = [...LINKED_PERSONAS, ...UNLINKED_PERSONAS];
const AGENT_NAME = "clearance";
const ADMIN_USER = "clearance-admin";
const PROBE_ROOM_NAME = "clearance-identity-probe";
const READER_TOKEN = "user";

export type Person = {
  switchUserId: string;
  participantIds: string[];
  mattermostUser: string;
  mattermostUserId: string;
  externalUserRowId: string;
  /** The direct room with Clearance that this persona opened. */
  directRoomId: string;
};
export type Identities = {
  people: Record<string, Person>;
  /** Accounts that exist on Mattermost and are linked to nobody. Never eligible for anything. */
  unlinked: Record<string, { participantIds: string[]; mattermostUser: string; mattermostUserId: string }>;
  agents: Record<string, { switchAgentId: string; participantId: string; ownerUserId: string; ownerName: string }>;
  bridgeId: string;
  mattermostTeam: string;
  /** Policy room names to Switch room ids. Not written here, but kept. */
  rooms?: Record<string, string>;
};
export type Secrets = {
  /**
   * One per persona, plus `user`: the seeded account the bridge adds to every channel it creates, which
   * can read the handle off a card in any of them. It is an ordinary account and not in real DMs. Plus
   * `clearance`: the agent's own account, the only one that can read a card's handle in a real DM.
   */
  mattermostTokens: Record<string, string>;
  switchAgentKeys: Record<string, string>;
  clearanceAdminPassword: string;
};

async function ensureAgent(
  adminUserCookie: string,
  ownerUserId: string,
  existingKey: string | undefined,
  agentIdHint: string | undefined,
): Promise<{ agentId: string; apiKey: string }> {
  if (existingKey && agentIdHint) {
    const probe = await call(BRIDGE_URL, "GET", `/agents/${agentIdHint}/ops`, { token: existingKey });
    if (probe.status === 200) return { agentId: agentIdHint, apiKey: existingKey };
  }
  // A personal key of clearance-admin, so the agent's owner is clearance-admin and nobody else.
  const key = await call(BRIDGE_URL, "POST", "/gateway/api-keys", {
    cookie: adminUserCookie,
    json: { label: `clearance-setup-${Date.now()}` },
  });
  const keyBody = expectOk(key, "minting clearance-admin's registration key");
  const registered = await registerAgent({
    bridgeUrl: BRIDGE_URL,
    registrationKey: String(keyBody.key),
    name: AGENT_NAME,
    displayName: "Clearance",
    description: "Approval layer: one policy, separation of duties, and a ledger for agent actions.",
    // A re-registration rotates the key. Switch refuses it when another owner holds the name.
    overwrite: true,
  });
  await call(BRIDGE_URL, "DELETE", `/gateway/api-keys/${String(keyBody.id)}`, { cookie: adminUserCookie });
  log(`switch: registered agent ${AGENT_NAME} as ${ownerUserId}`);
  return registered;
}

// ── Participant ids ──────────────────────────────────────────────────────────

type ContextEntry = { kind?: string; sender?: string; sender_name?: string; body?: string };
type Thread = { root: ContextEntry; replies: ContextEntry[] };

/**
 * Participant ids are opaque to clients and no API lists them by person, so they are read off the room
 * history: everyone who joins a room leaves a join entry carrying their id. The room is private, holds
 * only the personas and Clearance, and the caller deletes it straight after: archiving a room is only a flag in Switch,
 * and would leave its channel in every person's sidebar.
 */
async function readParticipantIds(
  agentId: string,
  apiKey: string,
  people: string[],
): Promise<{ ids: Record<string, string>; agent: string; roomId: string }> {
  const connectionId = `clearance-setup-${randomBytes(6).toString("hex")}`;
  const controller = new AbortController();
  const stream = await fetch(
    `${BRIDGE_URL}/agents/${agentId}/events?connection_id=${connectionId}&scope=single&filter=addressed&start_from=head`,
    { headers: { authorization: `Bearer ${apiKey}`, accept: "text/event-stream" }, signal: controller.signal },
  );
  if (!stream.ok || !stream.body) fail(`opening a setup stream failed: HTTP ${stream.status}`);
  const reader = stream.body.getReader();
  const generation = await readGeneration(reader);
  const beat = setInterval(() => {
    void call(BRIDGE_URL, "POST", `/agents/${agentId}/connection/beat`, {
      token: apiKey,
      json: { connection_id: connectionId, generation },
    }).catch(() => undefined);
  }, 2000);

  const op = async (name: string, args: unknown): Promise<unknown> => {
    const res = await call(BRIDGE_URL, "POST", `/agents/${agentId}/ops/${name}`, {
      token: apiKey,
      connectionId,
      json: args,
    });
    return expectOk(res, `operation ${name}`).result;
  };

  try {
    const rooms = (await op("list_rooms", {})) as { room_id: string; name: string }[];
    let roomId = rooms.find((room) => room.name === PROBE_ROOM_NAME)?.room_id;
    if (!roomId) {
      const created = (await op("create_room", {
        name: PROBE_ROOM_NAME,
        description: "Setup only: reads participant ids. Safe to ignore.",
        agent_names: [AGENT_NAME],
        user_names: people,
        channel_type: "channel_private",
      })) as { id: string };
      roomId = created.id;
    } else {
      await op("add_users_to_room", { room_id: roomId, user_names: people });
    }
    await op("connect_to_room", { room_id: roomId, include_general_instructions: false });

    const ids: Record<string, string> = {};
    let agentParticipant = "";
    for (let attempt = 0; attempt < 30 && Object.keys(ids).length < people.length; attempt++) {
      if (attempt > 0) await new Promise((done) => setTimeout(done, 1000));
      const context = (await op("read_context", { limit: 200 })) as { threads: Thread[] };
      for (const thread of context.threads) {
        for (const entry of [thread.root, ...thread.replies]) {
          if (!entry.sender || !entry.sender_name) continue;
          if (entry.sender_name === AGENT_NAME || entry.sender_name === "Clearance") agentParticipant = entry.sender;
          if (people.includes(entry.sender_name)) ids[entry.sender_name] = entry.sender;
        }
      }
    }
    const missing = people.filter((name) => !ids[name]);
    if (missing.length > 0) fail(`no participant id found for ${missing.join(", ")} in ${PROBE_ROOM_NAME}`);
    return { ids, agent: agentParticipant, roomId };
  } finally {
    clearInterval(beat);
    controller.abort();
  }
}

/**
 * The persona opens the DM and says hello, and Switch makes the room when that first message arrives.
 * Its name comes from the two usernames. A room archived earlier is the same room: it is unarchived.
 */
async function ensureDirectRoom(
  persona: string,
  mattermostUserId: string,
  personaToken: string,
  agentId: string,
  apiKey: string,
): Promise<string> {
  const name = directRoomName(persona, AGENT_NAME);
  const listRooms = async () => {
    const res = await call(BRIDGE_URL, "POST", `/agents/${agentId}/ops/list_rooms`, {
      token: apiKey,
      json: { include_archived: true },
    });
    return expectOk(res, "listing Clearance's rooms").result as { room_id: string; name: string; archived: boolean }[];
  };
  let room = (await listRooms()).find((entry) => entry.name === name);
  if (!room) {
    const bot = await call(MATTERMOST_URL, "GET", `/api/v4/users/username/${AGENT_NAME}`, { token: personaToken });
    const botId = String(expectOk(bot, "finding Clearance's Mattermost account").id);
    const direct = await call(MATTERMOST_URL, "POST", "/api/v4/channels/direct", {
      token: personaToken,
      json: [mattermostUserId, botId],
    });
    const channelId = String(expectOk(direct, `opening ${persona}'s DM with Clearance`).id);
    room = await sayUntilHeard(
      async () => {
        expectOk(
          await call(MATTERMOST_URL, "POST", "/api/v4/posts", {
            token: personaToken,
            json: { channel_id: channelId, message: "hello" },
          }),
          `${persona}'s first message to Clearance`,
        );
      },
      async () => (await listRooms()).find((entry) => entry.name === name),
    );
    if (!room) {
      fail(`Switch made no direct room for ${persona} within a minute: expected one named "${name}". Run just demo again.`);
    }
    log(`switch: ${persona} opened a direct room with ${AGENT_NAME}`);
  }
  if (room.archived) {
    expectOk(
      await call(BRIDGE_URL, "POST", `/agents/${agentId}/ops/unarchive_room`, {
        token: apiKey,
        json: { room_id: room.room_id },
      }),
      `unarchiving ${persona}'s direct room`,
    );
  }
  return room.room_id;
}

async function readGeneration(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<number> {
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) fail("setup stream closed before its connection_state frame");
    buffered += decoder.decode(value, { stream: true });
    const end = buffered.indexOf("\n\n");
    if (end < 0) continue;
    const data = buffered
      .slice(0, end)
      .split("\n")
      .find((line) => line.startsWith("data: "));
    if (!data) fail("setup stream opened with an unreadable frame");
    return Number((JSON.parse(data.slice(6)) as { generation: number }).generation);
  }
}

// ── Output ───────────────────────────────────────────────────────────────────

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const personaPassword = process.env.PERSONA_PASSWORD;
  if (!personaPassword) fail("PERSONA_PASSWORD is not set. See .env.example.");
  const env = readEnvFile(SWITCH_ENV_FILE);
  const identitiesPath = join(DATA_DIR, "identities.json");
  const secretsPath = join(DATA_DIR, "secrets.json");
  const previousSecrets = readJson<Partial<Secrets>>(secretsPath) ?? {};
  const previousIdentities = readJson<Partial<Identities>>(identitiesPath) ?? {};

  // Mattermost, as its admin.
  const mmAdmin = await mattermostLogin(need(env, "MATTERMOST_ADMIN_USER"), need(env, "MATTERMOST_ADMIN_PASSWORD"));
  expectOk(
    await call(MATTERMOST_URL, "PUT", "/api/v4/config/patch", {
      token: mmAdmin,
      json: { ServiceSettings: { EnableUserAccessTokens: true } },
    }),
    "enabling personal access tokens",
  );
  const teamName = need(env, "MATTERMOST_TEAM_NAME");
  const team = expectOk(
    await call(MATTERMOST_URL, "GET", `/api/v4/teams/name/${teamName}`, { token: mmAdmin }),
    `reading team ${teamName}`,
  );
  const teamId = String(team.id);

  const mattermostIds: Record<string, string> = {};
  const mattermostTokens: Record<string, string> = {};
  for (const name of ALL_PERSONAS) {
    const userId = await ensureMattermostAccount(mmAdmin, teamId, name, personaPassword);
    mattermostIds[name] = userId;
    mattermostTokens[name] = await ensureAccessToken(mmAdmin, name, userId, previousSecrets.mattermostTokens?.[name]);
  }
  // Only ever used to read a card's handle back. Not a persona: it stays out of identities.json.
  const readerName = need(env, "MATTERMOST_USER");
  const reader = expectOk(
    await call(MATTERMOST_URL, "GET", `/api/v4/users/username/${readerName}`, { token: mmAdmin }),
    `finding Mattermost account ${readerName}`,
  );
  mattermostTokens[READER_TOKEN] = await ensureAccessToken(
    mmAdmin,
    readerName,
    String(reader.id),
    previousSecrets.mattermostTokens?.[READER_TOKEN],
  );
  log(`mattermost: ${ALL_PERSONAS.length} accounts ready`);

  // Switch, as its admin.
  const adminCookie = await gatewayLogin(need(env, "GATEWAY_ADMIN_EMAIL"), need(env, "GATEWAY_ADMIN_PASSWORD"));
  const bridges = await call(BRIDGE_URL, "GET", "/gateway/collaborations", { cookie: adminCookie });
  expectOk(bridges, "listing bridges");
  const bridge = (bridges.body as { bridge_id: string; bridge_type: string }[]).find(
    (entry) => entry.bridge_type === "mattermost",
  );
  if (!bridge) fail("no Mattermost bridge is registered on this Switch");
  const bridgeId = bridge.bridge_id;

  const switchUserIds: Record<string, string> = {};
  const externalRowIds: Record<string, string> = {};
  for (const name of LINKED_PERSONAS) {
    const email = `${name}@${EMAIL_DOMAIN}`;
    switchUserIds[name] = await ensureSwitchUser(adminCookie, name, email, personaPassword);
    const cookie = await gatewayLogin(email, personaPassword);
    externalRowIds[name] = await linkAccount(cookie, bridgeId, name, mattermostIds[name]!, personaPassword);
  }
  log(`switch: ${LINKED_PERSONAS.length} personas linked`);

  // clearance-admin owns the agent and nothing else.
  const adminEmail = `${ADMIN_USER}@${EMAIL_DOMAIN}`;
  const clearanceAdminPassword =
    previousSecrets.clearanceAdminPassword ??
    process.env.CLEARANCE_ADMIN_PASSWORD ??
    randomBytes(24).toString("base64url");
  const ownerUserId = await ensureSwitchUser(adminCookie, ADMIN_USER, adminEmail, clearanceAdminPassword);
  let ownerCookie: string;
  try {
    ownerCookie = await gatewayLogin(adminEmail, clearanceAdminPassword);
  } catch (error) {
    fail(
      `${ADMIN_USER} exists but its password is unknown (data/secrets.json was lost?). ` +
        `Set CLEARANCE_ADMIN_PASSWORD to the original, or recreate the stack. Cause: ${(error as Error).message}`,
    );
  }
  const { agentId, apiKey } = await ensureAgent(
    ownerCookie,
    ownerUserId,
    previousSecrets.switchAgentKeys?.[AGENT_NAME],
    previousIdentities.agents?.[AGENT_NAME]?.switchAgentId,
  );

  // Saved as soon as they exist: a later failure must not lose a key that was only shown once.
  writePrivate(secretsPath, {
    mattermostTokens,
    switchAgentKeys: { ...previousSecrets.switchAgentKeys, [AGENT_NAME]: apiKey },
    clearanceAdminPassword,
  } satisfies Secrets);

  // Rule ids are external-user rows, not Switch users. `owner: true` keeps clearance-admin in, should it
  // ever link an account of its own.
  expectOk(
    await call(BRIDGE_URL, "PUT", `/gateway/agents/${agentId}/addressing-policy`, {
      cookie: ownerCookie,
      json: { policy: { rules: [{ users: Object.values(externalRowIds), agents: "*", owner: true }] } },
    }),
    "setting Clearance's addressing policy",
  );
  log("switch: addressing policy set");

  // Ids never change once issued, so a complete earlier read is kept. Otherwise a throwaway room reads
  // them; naming guest by username there provisions it on the bridge without linking it to anyone.
  const known: Record<string, string> = {};
  for (const name of LINKED_PERSONAS) {
    const id = previousIdentities.people?.[name]?.participantIds[0];
    if (id) known[name] = id;
  }
  for (const name of UNLINKED_PERSONAS) {
    const id = previousIdentities.unlinked?.[name]?.participantIds[0];
    if (id) known[name] = id;
  }
  const previousAgentParticipant = previousIdentities.agents?.[AGENT_NAME]?.participantId;
  const complete = previousAgentParticipant && ALL_PERSONAS.every((name) => known[name]);
  const read = complete ? undefined : await readParticipantIds(agentId, apiKey, ALL_PERSONAS);
  if (read) {
    const removed = await call(BRIDGE_URL, "POST", "/gateway/rooms/bulk-delete", {
      cookie: adminCookie,
      json: { room_ids: [read.roomId], retire_channel: true },
    });
    if (expectOk(removed, "deleting the setup room").deleted !== 1) fail(`${PROBE_ROOM_NAME} could not be deleted`);
  }
  const participantIds = read?.ids ?? known;
  const agentParticipant = read?.agent || previousAgentParticipant || "";

  const directRooms: Record<string, string> = {};
  for (const name of LINKED_PERSONAS) {
    directRooms[name] = await ensureDirectRoom(name, mattermostIds[name]!, mattermostTokens[name]!, agentId, apiKey);
  }
  log(`switch: ${LINKED_PERSONAS.length} direct rooms ready`);

  // Clearance's own Mattermost account, which exists once it has a room. Its token reads the handles in
  // real direct rooms, which no other account can, and removes its own old inbox posts, which Switch has
  // no operation for. It can't touch anyone else's post.
  const bot = expectOk(
    await call(MATTERMOST_URL, "GET", `/api/v4/users/username/${AGENT_NAME}`, { token: mmAdmin }),
    "finding Clearance's Mattermost account",
  );
  mattermostTokens[AGENT_NAME] = await ensureAccessToken(mmAdmin, AGENT_NAME, String(bot.id), previousSecrets.mattermostTokens?.[AGENT_NAME]);
  writePrivate(secretsPath, {
    mattermostTokens,
    switchAgentKeys: { ...previousSecrets.switchAgentKeys, [AGENT_NAME]: apiKey },
    clearanceAdminPassword,
  } satisfies Secrets);

  // Spread first: other things keep facts here, like `rooms`, and a re-run must not lose them.
  const identities: Identities = {
    ...previousIdentities,
    people: Object.fromEntries(
      LINKED_PERSONAS.map((name) => [
        name,
        {
          switchUserId: switchUserIds[name]!,
          participantIds: [participantIds[name]!],
          mattermostUser: name,
          mattermostUserId: mattermostIds[name]!,
          externalUserRowId: externalRowIds[name]!,
          directRoomId: directRooms[name]!,
        },
      ]),
    ),
    unlinked: Object.fromEntries(
      UNLINKED_PERSONAS.map((name) => [
        name,
        { participantIds: [participantIds[name]!], mattermostUser: name, mattermostUserId: mattermostIds[name]! },
      ]),
    ),
    agents: {
      ...previousIdentities.agents,
      [AGENT_NAME]: { switchAgentId: agentId, participantId: agentParticipant, ownerUserId, ownerName: ADMIN_USER },
    },
    bridgeId,
    mattermostTeam: teamName,
  };
  writePrivate(identitiesPath, identities);
  log(`wrote ${identitiesPath} and ${secretsPath} (mode 600)`);
}

main().catch((error: unknown) => {
  process.stderr.write(`setup-identities failed: ${(error as Error).message}\n`);
  process.exit(1);
});

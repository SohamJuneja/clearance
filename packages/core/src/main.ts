/**
 * Starts clearance-core: the policy engine, the HTTP API, vendor hook routes and the Clearance Switch agent,
 * in one process. Run with `tsx --env-file=.env packages/core/src/main.ts`.
 *
 * Refuses to start on missing or placeholder secrets: a core that can't check tokens or reach Switch must not
 * look healthy to the gate.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { hookRoutes, loadHookTokens } from "@clearance/adapters";
import { DEFAULT_PORTS } from "@clearance/contracts";
import { createGateClient } from "@clearance/gate";
import { createChatPort, createMattermostHandleResolver, createOwnPosts, createSwitchAgent, createTemplatePort, serviceConnectionId } from "@clearance/switch-agent";
import { buildServer } from "./api/server.js";
import { systemClock } from "./clock.js";
import { OperatorCommands } from "./commands/operator.js";
import { createClearanceCore } from "./core.js";
import { openDatabase } from "./db/index.js";
import { readStreamPosition, streamHandlers } from "./stream.js";
import { drillRateFromEnv } from "./drills/library.js";
import { isInboxMessage } from "./inbox/inbox.js";
import { createInboxKeeper, INBOX_SYNC_EVERY_MS } from "./inbox/keeper.js";
import { Installer } from "./install/install.js";
import { createLedgerMirror } from "./ledger/mirror.js";

function secret(name: string): string {
  const value = process.env[name];
  if (!value || value === "change-me") {
    console.error(`${name} is missing or still the placeholder. Set it in .env.`);
    process.exit(1);
  }
  return value;
}

const internalToken = secret("CLEARANCE_INTERNAL_TOKEN");
const dataDir = resolve(process.env.CLEARANCE_DATA_DIR ?? "data");
const identitiesPath = resolve(dataDir, "identities.json");

// One token per agent, and it alone says which agent a hook call comes from. Refusing to start here is
// what keeps a shared token from silently coming back.
let hookTokens: Record<string, string>;
try {
  hookTokens = loadHookTokens(resolve(process.env.CLEARANCE_HOOK_TOKENS_PATH ?? resolve(dataDir, "hook-tokens.json")));
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

type Identities = {
  people: Record<string, { participantIds: string[]; mattermostUser: string }>;
  agents: Record<string, { switchAgentId: string; participantId?: string }>;
};
type Secrets = {
  mattermostTokens: Record<string, string>;
  switchAgentKeys: Record<string, string>;
};

let identities: Identities;
let secrets: Secrets;
try {
  identities = JSON.parse(readFileSync(identitiesPath, "utf8")) as Identities;
  secrets = JSON.parse(readFileSync(resolve(dataDir, "secrets.json"), "utf8")) as Secrets;
} catch {
  console.error(`Can't read identities or secrets in ${dataDir}. Run scripts/setup-identities.ts first.`);
  process.exit(1);
}

const clearance = identities.agents.clearance;
const apiKey = secrets.switchAgentKeys.clearance;
if (!clearance || !apiKey) {
  console.error("The clearance agent is not registered. Run scripts/setup-identities.ts first.");
  process.exit(1);
}

const participantNames: Record<string, string> = {};
for (const person of Object.values(identities.people)) {
  for (const id of person.participantIds) participantNames[id] = person.mattermostUser;
}

const dbPath = resolve(process.env.CLEARANCE_DB_PATH ?? resolve(dataDir, "clearance.sqlite"));
// Read before the agent exists, so what was said while core was down is delivered rather than skipped.
const positionDb = openDatabase(dbPath);
const initialPosition = readStreamPosition(positionDb);
positionDb.close();

const agent = createSwitchAgent({
  bridgeUrl: process.env.SWITCH_BRIDGE_URL ?? "http://127.0.0.1:8000",
  agentId: clearance.switchAgentId,
  apiKey,
  // One core per Switch: services.sh refuses a second, and a restart must not leave the rooms deaf for 30 s.
  connectionId: serviceConnectionId(clearance.switchAgentId),
  ...(initialPosition ? { initialPosition } : {}),
});
// Clearance's own Mattermost account can read its real direct rooms, which the reader account can't.
const ownToken = secrets.mattermostTokens.clearance;
const handleToken = ownToken ?? secrets.mattermostTokens.user;
const mattermostUrl = process.env.MATTERMOST_URL ?? "http://127.0.0.1:8065";
const chat = createChatPort(agent, {
  agentName: process.env.CLEARANCE_AGENT_NAME ?? "clearance",
  participantNames,
  ...(handleToken
    ? {
        resolveHandle: createMattermostHandleResolver({
          agent,
          mattermostUrl,
          token: handleToken,
        }),
      }
    : {}),
});

const gateClient = createGateClient({
  baseUrl: process.env.CLEARANCE_GATE_URL ?? `http://127.0.0.1:${DEFAULT_PORTS.gate}`,
  internalToken,
});

const clock = systemClock(Number(process.env.CLEARANCE_TIME_SCALE ?? 1));
const logLine = (message: string) => console.error(message);

const core = createClearanceCore({
  dbPath,
  policyPath: resolve(process.env.CLEARANCE_POLICY_PATH ?? "policy/clearance.policy.yaml"),
  teamPath: resolve(process.env.CLEARANCE_TEAM_PATH ?? "policy/team.yaml"),
  identitiesPath,
  chat,
  gate: gateClient,
  lookup: gateClient,
  clock,
  drillRate: drillRateFromEnv(process.env.CLEARANCE_DRILL_RATE),
  runningInbox: true,
});

const ownPosts = ownToken ? createOwnPosts({ agent, mattermostUrl, token: ownToken }) : null;
const inboxes = createInboxKeeper(core, {
  chat,
  clock,
  log: logLine,
  ...(ownPosts
    ? {
        erase: async (roomId: string) => {
          await ownPosts.remove(roomId, isInboxMessage);
        },
      }
    : {}),
});

const APPROVALS_ROOM = "#approvals";
const mirror = createLedgerMirror(core, { chat, clock, policyRoom: APPROVALS_ROOM, log: logLine });

const templatePath = resolve(process.env.CLEARANCE_TEMPLATE_PATH ?? "templates/clearance.template.yaml");
const gatewayUrl = process.env.CLEARANCE_GATEWAY_URL?.replace(/\/$/, "");
if (!existsSync(templatePath)) console.error(`No template at ${templatePath}: @clearance install is off.`);
const operator = new OperatorCommands({
  directory: core.people.directory,
  admins: core.team.admins ?? [],
  chat,
  // Optional, so a missing file costs the command and not the core.
  ...(existsSync(templatePath)
    ? {
        installer: new Installer(createTemplatePort(agent), {
          templateName: process.env.CLEARANCE_TEMPLATE_NAME ?? "clearance-install",
          templateYaml: readFileSync(templatePath, "utf8"),
          roomName: process.env.CLEARANCE_INSTALL_ROOM ?? "approvals",
          policyRoom: APPROVALS_ROOM,
        }),
      }
    : {}),
  // Remembered across restarts in identities.json, with the other rooms the policy names.
  onRoom: (policyRoom, roomId) => {
    core.people.directory.setRoom(policyRoom, roomId);
    const current = JSON.parse(readFileSync(identitiesPath, "utf8")) as Record<string, unknown>;
    const rooms = (current.rooms ?? {}) as Record<string, string>;
    if (rooms[policyRoom] === roomId) return;
    const next = `${identitiesPath}.${process.pid}.tmp`;
    writeFileSync(next, `${JSON.stringify({ ...current, rooms: { ...rooms, [policyRoom]: roomId } }, null, 2)}\n`, { mode: 0o600 });
    renameSync(next, identitiesPath);
  },
  mirror,
  mirrorRoom: APPROVALS_ROOM,
  documentsPage: () => (gatewayUrl ? `${gatewayUrl}/rooms/${core.people.directory.roomId(APPROVALS_ROOM)}` : null),
  log: logLine,
});

const app = buildServer(core, { internalToken, logger: process.env.LOG_LEVEL === "debug", mirror });
await app.register(async (scope) => {
  hookRoutes(scope, {
    check: (action) => core.check(action),
    resolveAgent: (cwd, agentType) => core.resolveAgent(cwd, agentType),
    hookTokens,
  });
});

const tick = setInterval(() => {
  core.tick().catch((error: unknown) => console.error("tick failed:", error));
  // Started, not waited for: nothing that decides depends on the copy.
  mirror.tick();
}, 1000);
const inboxTick = setInterval(() => void inboxes.sync(), INBOX_SYNC_EVERY_MS);

const stop = async () => {
  clearInterval(tick);
  clearInterval(inboxTick);
  await agent.stop();
  await app.close();
  core.close();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

const port = Number(process.env.CLEARANCE_CORE_PORT ?? DEFAULT_PORTS.core);
await app.listen({ port, host: "127.0.0.1" });
await agent.start(streamHandlers(core, { afterMessage: (event) => operator.start(event) }));
console.log(`clearance-core listening on 127.0.0.1:${port}, Switch agent connected`);

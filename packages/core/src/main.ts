/**
 * Starts clearance-core: the policy engine, the HTTP API, vendor hook routes and the Clearance Switch agent,
 * in one process. Run with `tsx --env-file=.env packages/core/src/main.ts`.
 *
 * Refuses to start on missing or placeholder secrets: a core that can't check tokens or reach Switch must not
 * look healthy to the gate.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hookRoutes } from "@clearance/adapters";
import { DEFAULT_PORTS } from "@clearance/contracts";
import { createGateClient } from "@clearance/gate";
import { createChatPort, createMattermostHandleResolver, createSwitchAgent } from "@clearance/switch-agent";
import { buildServer } from "./api/server.js";
import { systemClock } from "./clock.js";
import { createClearanceCore } from "./core.js";

function secret(name: string): string {
  const value = process.env[name];
  if (!value || value === "change-me") {
    console.error(`${name} is missing or still the placeholder. Set it in .env.`);
    process.exit(1);
  }
  return value;
}

const internalToken = secret("CLEARANCE_INTERNAL_TOKEN");
const hookToken = secret("CLEARANCE_HOOK_TOKEN");
const dataDir = resolve(process.env.CLEARANCE_DATA_DIR ?? "data");
const identitiesPath = resolve(dataDir, "identities.json");

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

const agent = createSwitchAgent({
  bridgeUrl: process.env.SWITCH_BRIDGE_URL ?? "http://127.0.0.1:8000",
  agentId: clearance.switchAgentId,
  apiKey,
});
const handleToken = secrets.mattermostTokens.user;
const chat = createChatPort(agent, {
  participantNames,
  ...(handleToken
    ? {
        resolveHandle: createMattermostHandleResolver({
          agent,
          mattermostUrl: process.env.MATTERMOST_URL ?? "http://127.0.0.1:8065",
          token: handleToken,
        }),
      }
    : {}),
});

const gateClient = createGateClient({
  baseUrl: process.env.CLEARANCE_GATE_URL ?? `http://127.0.0.1:${DEFAULT_PORTS.gate}`,
  internalToken,
});

const core = createClearanceCore({
  dbPath: resolve(process.env.CLEARANCE_DB_PATH ?? resolve(dataDir, "clearance.sqlite")),
  policyPath: resolve(process.env.CLEARANCE_POLICY_PATH ?? "policy/clearance.policy.yaml"),
  teamPath: resolve(process.env.CLEARANCE_TEAM_PATH ?? "policy/team.yaml"),
  identitiesPath,
  chat,
  gate: gateClient,
  lookup: gateClient,
  clock: systemClock(Number(process.env.CLEARANCE_TIME_SCALE ?? 1)),
});

const app = buildServer(core, { internalToken, logger: process.env.LOG_LEVEL === "debug" });
await app.register(async (scope) => {
  hookRoutes(scope, {
    check: (action) => core.check(action),
    resolveAgent: (cwd, agentType) => core.resolveAgent(cwd, agentType),
    hookToken,
  });
});

const tick = setInterval(() => {
  core.tick().catch((error: unknown) => console.error("tick failed:", error));
}, 1000);

const stop = async () => {
  clearInterval(tick);
  await agent.stop();
  await app.close();
  core.close();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

const port = Number(process.env.CLEARANCE_CORE_PORT ?? DEFAULT_PORTS.core);
await app.listen({ port, host: "127.0.0.1" });
await agent.start({
  message: (event) => core.onMessage(event),
  approvalOutcome: (event) => core.onApprovalOutcome(event),
});
console.log(`clearance-core listening on 127.0.0.1:${port}, Switch agent connected`);

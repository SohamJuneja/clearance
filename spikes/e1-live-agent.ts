/**
 * A throwaway protected agent for `pnpm eval:authority --live`, so its direct-message check can't leave a real agent at
 * two approvals, and so cases 5, 12, 16, 17 and 22 have an agent key that isn't Clearance's. It runs nothing: it is a registered
 * name, in #support, limited to that room like any protected agent. Prints no key.
 *
 *   pnpm exec tsx spikes/e1-live-agent.ts up [name]     register it, and add it to data/secrets.json and data/identities.json
 *   pnpm exec tsx spikes/e1-live-agent.ts down [name]   remove the agent, its rooms and those two entries
 *
 * Use a new name for each run. A person's direct room with an agent outlives it, and an archived one stays silent, so
 * the same name would get no refusal to read. The name to pass is CLEARANCE_EVAL_LIVE_AGENT.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { archiveStrayRooms } from "../scripts/demo/stray-rooms.js";
import { ownerGateway, ROOT } from "../scripts/gateway-owner.js";

const NAME = process.argv[3] ?? "e1-live-agent";
const OWNER = "priya";
const secretsPath = join(ROOT, "data/secrets.json");
const identitiesPath = join(ROOT, "data/identities.json");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
const write = (path: string, value: unknown) => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
};

async function up(): Promise<void> {
  const owner = await ownerGateway(OWNER);
  const registered = await owner.must<{ id: string; api_key: string }>("POST", "/agents/register-other", {
    name: NAME,
    description: "Throwaway for pnpm eval:authority --live. Runs nothing.",
    overwrite: true,
  });
  const alex = await ownerGateway("alex");
  const rooms = await alex.must<{ id: string; name: string }[]>("GET", "/rooms");
  const support = rooms.find((room) => room.name === "support");
  if (!support) throw new Error("no #support room");
  await alex.must("POST", `/rooms/${support.id}/agents`, { agent_ids: [registered.id] });
  await owner.must("PUT", `/agents/${registered.id}/addressing-policy`, {
    policy: { rules: [{ rooms: [support.id], users: "*", agents: "*", owner: true }] },
  });
  const secrets = read(secretsPath);
  secrets.switchAgentKeys = { ...secrets.switchAgentKeys, [NAME]: registered.api_key };
  write(secretsPath, secrets);
  const identities = read(identitiesPath);
  identities.agents = { ...identities.agents, [NAME]: { switchAgentId: registered.id } };
  write(identitiesPath, identities);
  console.log(`${NAME} is registered, in #support and limited to it`);
}

async function down(): Promise<void> {
  const owner = await ownerGateway(OWNER);
  // Its rooms first, while Switch can still say whose they are. It isn't a managed agent, so it goes by id.
  const id = read(identitiesPath).agents?.[NAME]?.switchAgentId as string | undefined;
  const archived = id ? await archiveStrayRooms([], console.log, [id]) : 0;
  const res = await owner.call("DELETE", `/agents/by-name/${NAME}`);
  console.log(`deleted ${NAME}: HTTP ${res.status}, ${archived} rooms archived`);
  const secrets = read(secretsPath);
  delete secrets.switchAgentKeys?.[NAME];
  write(secretsPath, secrets);
  const identities = read(identitiesPath);
  delete identities.agents?.[NAME];
  write(identitiesPath, identities);
}

const what = process.argv[2];
if (what === "up") await up();
else if (what === "down") await down();
else throw new Error("usage: e1-live-agent.ts up|down");

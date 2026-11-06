/**
 * What `just demo --check` asks about the running world. Read-only: it signs in and looks. Exits 1 if the answer is
 * "not yet", and each line says what is missing. Prints no secret.
 *
 *   pnpm exec tsx scripts/demo-status.ts personas|machines|agents|rooms
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PEOPLE, personaTokens } from "./demo/greet.ts";
import { findStrayRooms } from "./demo/stray-rooms.ts";
import { agentIdOf, type ManagedAgent, type Machine, ownerGateway, providerReady, providersNotReady, ROOT } from "./gateway-owner.ts";
import { MACHINES, OWNERS, planAgents } from "./setup-agents.ts";
import { roomsOf, roomsOfAgents } from "./setup-world.ts";

const MATTERMOST = process.env.MATTERMOST_URL ?? "http://127.0.0.1:8065";
const BASELINE = { name: "refunds-agent-vanilla", owner: "priya", machine: "clearance-priya-base", provider: "claude" };
const template = () => readFileSync(join(ROOT, "templates/acme-mini.template.yaml"), "utf8");

let missing = 0;
const ok = (line: string) => console.log(`  ok    ${line}`);
const no = (line: string) => {
  missing += 1;
  console.log(`  todo  ${line}`);
};

async function personas(): Promise<void> {
  if (!existsSync(join(ROOT, "data/secrets.json")) || !existsSync(join(ROOT, "data/identities.json"))) {
    no("data/secrets.json and data/identities.json are not there yet");
    return;
  }
  const tokens = personaTokens(ROOT);
  for (const person of PEOPLE) {
    const token = tokens[person];
    const res = token
      ? await fetch(`${MATTERMOST}/api/v4/users/me`, { headers: { authorization: `Bearer ${token}` } })
      : null;
    if (res?.ok) ok(`${person} can sign in to Mattermost`);
    else no(`${person} cannot sign in to Mattermost`);
  }
  const identities = JSON.parse(readFileSync(join(ROOT, "data/identities.json"), "utf8")) as { agents?: Record<string, unknown> };
  if (identities.agents?.clearance) ok("the Clearance agent is registered");
  else no("the Clearance agent is not registered");
}

async function machinesOf(owner: string): Promise<Machine[]> {
  const gateway = await ownerGateway(owner);
  return (await gateway.must<Machine[]>("GET", "/management/controllers")).filter((m) => !m.revoked_at);
}

async function machines(): Promise<void> {
  const wanted = new Map<string, Set<string>>([[BASELINE.machine, new Set([BASELINE.provider])]]);
  for (const plan of planAgents(template())) {
    const name = MACHINES[plan.name]!;
    wanted.set(name, (wanted.get(name) ?? new Set()).add(plan.provider));
  }
  for (const [name, providers] of wanted) {
    const owner = name.split("-")[1]!;
    const found = (await machinesOf(owner)).find((m) => m.name === name);
    if (!found) {
      no(`${name} is not enrolled`);
    } else if (!found.status?.providers?.length) {
      no(`${name} is enrolled and has not reported its providers yet`);
    } else {
      const missing = providersNotReady(found, providers);
      if (missing.length > 0) no(`${name} has not said it can run ${missing.join(" or ")} yet`);
      else ok(`${name} is enrolled and reporting`);
    }
  }
}

async function agents(): Promise<void> {
  const plans = planAgents(template()).map((plan) => ({
    name: plan.name,
    owner: plan.owner,
    machine: MACHINES[plan.name]!,
    provider: plan.provider,
  }));
  for (const plan of [...plans, BASELINE]) {
    const gateway = await ownerGateway(plan.owner);
    const agent = (await gateway.must<ManagedAgent[]>("GET", "/management/agents")).find((a) => a.name === plan.name);
    const machine = (await machinesOf(plan.owner)).find((m) => m.name === plan.machine);
    if (agent && machine && agent.controller_id === machine.id) {
      ok(`${plan.name} is on ${plan.machine}`);
    } else if (machine && !providerReady(machine, plan.provider)) {
      // Not a gap in the setup: it can't exist until someone gives this machine a login.
      ok(`${plan.name} is waiting for a ${plan.provider} login on ${plan.machine}, and one rerun creates it`);
    } else if (agent) {
      no(`${plan.name} is on the wrong machine, expected ${plan.machine}`);
    } else {
      no(`${plan.name} is not created`);
    }
  }
}

async function rooms(): Promise<void> {
  const gateway = await ownerGateway("alex");
  const present = await gateway.must<{ id: string; name: string }[]>("GET", "/rooms");
  const identities = existsSync(join(ROOT, "data/identities.json"))
    ? (JSON.parse(readFileSync(join(ROOT, "data/identities.json"), "utf8")) as { rooms?: Record<string, string> })
    : {};
  for (const room of roomsOf(template())) {
    const found = present.find((r) => r.name === room.name);
    if (!found) no(`#${room.name} does not exist`);
    else if (identities.rooms?.[`#${room.name}`] !== found.id) no(`#${room.name} is not in core's room map`);
    else ok(`#${room.name} exists and core knows it`);
  }
  const byAgent = roomsOfAgents(roomsOf(template()), present, Object.keys(OWNERS));
  for (const [name, roomIds] of Object.entries(byAgent)) {
    const owner = await ownerGateway(OWNERS[name]!);
    const agent = (await owner.must<ManagedAgent[]>("GET", "/management/agents")).find((a) => a.name === name);
    if (!agent) continue;
    const id = agentIdOf(agent);
    for (const roomId of roomIds) {
      const detail = await gateway.must<{ agent_ids?: string[] }>("GET", `/rooms/${roomId}`);
      if (!detail.agent_ids?.includes(id)) no(`${name} is not in one of its rooms`);
    }
    const detail = await owner.must<{ addressing_policy?: { rules?: { rooms?: string[] | "*" }[] } | null }>("GET", `/agents/${id}`);
    const limitedTo = detail.addressing_policy?.rules?.[0]?.rooms;
    if (Array.isArray(limitedTo) && [...limitedTo].sort().join() === [...roomIds].sort().join()) ok(`${name} can be addressed only in its own rooms`);
    else no(`${name} is not limited to its own rooms`);
  }
  const stray = await findStrayRooms(Object.keys(OWNERS));
  if (stray.length === 0) ok("no room holds a protected agent without Clearance");
  else no(`${stray.length} rooms hold a protected agent without Clearance, which would mean two approvers`);
}

const checks: Record<string, () => Promise<void>> = { personas, machines, agents, rooms };
const what = process.argv[2];
const check = what ? checks[what] : undefined;
if (!check) {
  console.error(`usage: demo-status.ts ${Object.keys(checks).join("|")}`);
  process.exit(2);
}
await check();
process.exit(missing > 0 ? 1 : 0);

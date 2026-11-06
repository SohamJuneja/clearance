/**
 * The Acme Mini rooms, from templates/acme-mini.template.yaml, and the map core needs from the policy's room
 * names (`#support`) to Switch room ids, in `rooms` in data/identities.json. Idempotent. Prints no secret.
 *
 *   pnpm exec tsx scripts/setup-world.ts [--no-restart] [--no-greet]
 *
 * A template run refuses outright if a room names an agent that does not exist, and Codex and Cursor agents
 * cannot exist until those tools have logins. So each run names only the agents that exist, and a later run
 * adds any that have appeared since. Agents themselves come from scripts/setup-agents.ts, as their owners.
 *
 * Core reads the map when it starts, so this restarts core when the map changed. A template can only make a group
 * once, so a recreated room is put back in its group and links here. Each protected agent can then be addressed only
 * in its own rooms, by room id, so this reruns whenever a room is recreated. A template can't say that: it only knows
 * `owner`, `owner-agents` and `anyone`. Rooms that hold a protected agent and not Clearance are archived. Last, each
 * person says hello to Clearance in their direct room (scripts/demo/greet.ts), or the next card says nobody is linked.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { greetClearance, personaTokens } from "./demo/greet.ts";
import { archiveStrayRooms } from "./demo/stray-rooms.ts";
import { agentIdOf, type ManagedAgent, ownerGateway, ROOT, type OwnerGateway } from "./gateway-owner.ts";
import { OWNERS } from "./setup-agents.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Whoever runs it owns the rooms. Alex is in all of them but #finance, and owning one is what lets agents join later. */
const ROOM_OWNER = "alex";

type Resource = { type?: string; name?: string; group?: string; agents?: string[]; [key: string]: unknown };
type TemplateDoc = { resources?: Record<string, Resource>; [key: string]: unknown };

export type WorldRoom = { name: string; agents: string[] };

export function roomsOf(templateText: string): WorldRoom[] {
  const doc = parse(templateText) as TemplateDoc;
  return Object.values(doc.resources ?? {})
    .filter((r) => r.type === "room")
    .map((r) => ({ name: String(r.name), agents: r.agents ?? [] }));
}

/**
 * The template with only what this run should create: no agents, only rooms that do not exist yet, and only
 * agents that do. Null when there is nothing to create. A group can only be made once, so it goes when any
 * room already exists: `withRoomMap` and the membership step do not depend on it.
 */
export function worldDocument(templateText: string, existing: { agents: string[]; rooms: string[] }): string | null {
  const doc = parse(templateText) as TemplateDoc;
  const firstRun = existing.rooms.length === 0;
  const resources: Record<string, Resource> = {};
  for (const [key, resource] of Object.entries(doc.resources ?? {})) {
    if (resource.type === "agent") continue;
    if (resource.type === "group") {
      if (firstRun) resources[key] = resource;
      continue;
    }
    if (resource.type === "room") {
      if (existing.rooms.includes(String(resource.name))) continue;
      const { group, ...rest } = resource;
      resources[key] = {
        ...rest,
        ...(firstRun && group ? { group } : {}),
        agents: (resource.agents ?? []).filter((agent) => existing.agents.includes(agent)),
      };
      continue;
    }
    resources[key] = resource;
  }
  if (!Object.values(resources).some((r) => r.type === "room")) return null;
  return stringify({ ...doc, resources });
}

export type WorldGroup = { name: string; description: string; links: { from: string; to: string; label: string }[] };

/** The group the template's rooms belong to, with the links it draws between them. */
export function groupOf(templateText: string): WorldGroup | null {
  const doc = parse(templateText) as TemplateDoc;
  const group = Object.values(doc.resources ?? {}).find((r) => r.type === "group");
  if (!group) return null;
  return {
    name: String(group.name),
    description: String(group.description ?? ""),
    links: (group.links as WorldGroup["links"] | undefined) ?? [],
  };
}

/**
 * Who may address a protected agent: anyone, its owner and any agent, but only in these rooms. `agents: "*"` is what
 * keeps Clearance's targeted messages working. Measured in spikes/RESULTS-switchboard.md: named in a listed room the
 * agent hears it, a DM draws "You're not permitted" and it hears nothing, and a private chat gets a 403.
 */
export function roomLimitedPolicy(roomIds: string[]): { rules: { rooms: string[]; users: "*"; agents: "*"; owner: true }[] } {
  return { rules: [{ rooms: [...roomIds].sort(), users: "*", agents: "*", owner: true }] };
}

/** Each protected agent's rooms, by id, from the template. A room not made yet is left out. */
export function roomsOfAgents(wanted: WorldRoom[], present: { id: string; name: string }[], protectedNames: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const agent of protectedNames) {
    out[agent] = wanted
      .filter((room) => room.agents.includes(agent))
      .flatMap((room) => present.filter((r) => r.name === room.name).map((r) => r.id));
  }
  return out;
}

export function policyRoomMap(rooms: { name: string; id: string }[]): Record<string, string> {
  return Object.fromEntries(rooms.map((room) => [`#${room.name}`, room.id]));
}

export function withRoomMap<T extends { rooms?: Record<string, string> }>(identities: T, map: Record<string, string>): T {
  return { ...identities, rooms: { ...identities.rooms, ...map } };
}

type RoomRow = { id: string; name: string };

/**
 * An agent's id whether a machine runs it or it's only a registered name, as with `just demo --no-agents`. The name gets
 * the same limit, or Switch refuses Clearance on its behalf and the room reads as if Clearance had been shut out.
 */
export function agentIdByName(
  name: string,
  managed: ManagedAgent[],
  registered: { id: string; name: string }[] | { agents?: { id: string; name: string }[] },
): string | undefined {
  const found = managed.find((agent) => agent.name === name);
  if (found) return agentIdOf(found);
  const rows = Array.isArray(registered) ? registered : (registered.agents ?? []);
  return rows.find((agent) => agent.name === name)?.id;
}

/** Set by each agent's owner, the only one who can. An agent not created yet has nothing to set. */
async function limitAddressing(wanted: WorldRoom[], rooms: RoomRow[]): Promise<void> {
  const byAgent = roomsOfAgents(wanted, rooms, Object.keys(OWNERS));
  for (const [agent, roomIds] of Object.entries(byAgent)) {
    const gateway = await ownerGateway(OWNERS[agent]!);
    const id = agentIdByName(
      agent,
      await gateway.must<ManagedAgent[]>("GET", "/management/agents"),
      await gateway.must("GET", "/agents"),
    );
    if (!id || roomIds.length === 0) continue;
    await gateway.must("PUT", `/agents/${id}/addressing-policy`, { policy: roomLimitedPolicy(roomIds) });
    console.log(`${agent}: can be addressed in ${roomIds.length} room${roomIds.length === 1 ? "" : "s"} only`);
  }
}

/** Every room of the world in its group, and every link in place. Does nothing to what is already right. */
async function keepGroup(gateway: OwnerGateway, group: WorldGroup, rooms: RoomRow[]): Promise<void> {
  const groups = await gateway.must<{ id: string; name: string }[]>("GET", "/room-groups");
  const found =
    groups.find((g) => g.name === group.name) ??
    (await gateway.must<{ id: string }>("POST", "/room-groups", { name: group.name, description: group.description }));
  await gateway.must("PUT", `/room-groups/${found.id}/rooms`, { room_ids: rooms.map((room) => room.id) });
  const idOf = (name: string) => rooms.find((room) => room.name === name)?.id;
  for (const link of group.links) {
    const from = idOf(link.from);
    const to = idOf(link.to);
    if (!from || !to) continue;
    const linked = await gateway.must<{ target_room_id: string }[]>("GET", `/rooms/${from}/linked-rooms`);
    if (linked.some((l) => l.target_room_id === to)) continue;
    await gateway.must("POST", `/rooms/${from}/linked-rooms`, { target_room_id: to, label: link.label });
  }
}
type RoomDetail = { agent_ids?: string[] };
type AgentRow = { id?: string; agent_id?: string; name: string };

async function listAgents(gateway: OwnerGateway): Promise<AgentRow[]> {
  const body = await gateway.must<AgentRow[] | { agents: AgentRow[] }>("GET", "/agents");
  return Array.isArray(body) ? body : body.agents;
}

async function main(): Promise<void> {
  const restart = !process.argv.includes("--no-restart");
  const gateway = await ownerGateway(ROOM_OWNER);
  const templateText = readFileSync(join(REPO, "templates/acme-mini.template.yaml"), "utf8");
  const wanted = roomsOf(templateText);
  const agents = await listAgents(gateway);
  const agentNames = agents.map((a) => a.name);
  const listRooms = () => gateway.must<RoomRow[]>("GET", "/rooms");

  const present = (await listRooms()).filter((room) => wanted.some((w) => w.name === room.name));
  const document = worldDocument(templateText, { agents: agentNames, rooms: present.map((r) => r.name) });
  if (document) {
    await gateway.must("POST", "/rooms/from-template-document", {
      template: document,
      inputs: { create_support_agents: false, create_eng_agents: false, create_rooms: true },
      template_name: "acme-mini",
    });
    console.log("created the rooms that were missing");
  }

  const rooms = (await listRooms()).filter((room) => wanted.some((w) => w.name === room.name));
  for (const want of wanted) {
    const room = rooms.find((r) => r.name === want.name);
    if (!room) throw new Error(`room ${want.name} did not appear after the template ran`);
    const detail = await gateway.must<RoomDetail>("GET", `/rooms/${room.id}`);
    const inRoom = new Set(detail.agent_ids ?? []);
    const missing = agents.filter((a) => want.agents.includes(a.name) && !inRoom.has(a.id ?? a.agent_id ?? ""));
    if (missing.length > 0) {
      await gateway.must("POST", `/rooms/${room.id}/agents`, { agent_ids: missing.map((a) => a.id ?? a.agent_id) });
      console.log(`#${want.name}: added ${missing.map((a) => a.name).join(", ")}`);
    }
    const blocked = want.agents.filter((name) => !agentNames.includes(name));
    console.log(`#${want.name}: ${room.id}${blocked.length ? ` (not yet created: ${blocked.join(", ")})` : ""}`);
  }

  const group = groupOf(templateText);
  if (group) await keepGroup(gateway, group, rooms);
  await limitAddressing(wanted, rooms);
  await archiveStrayRooms(Object.keys(OWNERS), console.log);

  const identitiesPath = join(resolve(process.env.CLEARANCE_DATA_DIR ?? join(ROOT, "data")), "identities.json");
  const identities = JSON.parse(readFileSync(identitiesPath, "utf8")) as { rooms?: Record<string, string> };
  const map = policyRoomMap(rooms);
  const changed = Object.entries(map).some(([name, id]) => identities.rooms?.[name] !== id);
  if (changed) {
    writeFileSync(identitiesPath, `${JSON.stringify(withRoomMap(identities, map), null, 2)}\n`, { mode: 0o600 });
    chmodSync(identitiesPath, 0o600);
    console.log(`wrote the room map to ${identitiesPath}`);
    if (restart) {
      const services = join(REPO, "scripts/services.sh");
      for (const verb of ["down", "up"]) {
        const result = spawnSync("bash", [services, verb, "core"], { encoding: "utf8" });
        if (result.status !== 0) throw new Error(`could not ${verb} core: ${result.stderr}`);
      }
      console.log("restarted core so it reads the map");
    }
  } else {
    console.log("room map unchanged");
  }

  if (!process.argv.includes("--no-greet")) {
    await greetClearance({
      mattermostUrl: process.env.MATTERMOST_URL ?? "http://127.0.0.1:8065",
      tokens: personaTokens(ROOT),
      log: console.log,
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

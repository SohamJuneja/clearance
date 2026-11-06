/**
 * The Acme Mini rooms, from templates/acme-mini.template.yaml, and the map core needs from the policy's room
 * names (`#support`) to Switch room ids, in `rooms` in data/identities.json. Idempotent. Prints no secret.
 *
 *   pnpm exec tsx scripts/setup-world.ts [--no-restart]
 *
 * A template run refuses outright if a room names an agent that does not exist, and Codex and Cursor agents
 * cannot exist until those tools have logins. So each run names only the agents that exist, and a later run
 * adds any that have appeared since. Agents themselves come from scripts/setup-agents.ts, as their owners.
 *
 * Core reads the map when it starts, so this restarts core when the map changed.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { ownerGateway, ROOT, type OwnerGateway } from "./gateway-owner.ts";

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

export function policyRoomMap(rooms: { name: string; id: string }[]): Record<string, string> {
  return Object.fromEntries(rooms.map((room) => [`#${room.name}`, room.id]));
}

export function withRoomMap<T extends { rooms?: Record<string, string> }>(identities: T, map: Record<string, string>): T {
  return { ...identities, rooms: { ...identities.rooms, ...map } };
}

type RoomRow = { id: string; name: string };
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
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

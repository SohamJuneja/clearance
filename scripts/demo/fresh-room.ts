/**
 * Replaces a room with an empty one, so a take cannot read an earlier one. Sessions outlive their room and a resumed
 * conversation is memory, so it also restarts the room's agents, and starts any that are stopped.
 *
 * Nothing is deleted. The old Mattermost channel is renamed `<room>-take-<when>` and archived, which frees the name and
 * keeps its posts: `mmctl channel list switch` shows them, and an archived channel can be opened by its URL.
 *
 *   pnpm exec tsx scripts/demo/fresh-room.ts support
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentIdOf, type ManagedAgent, ownerGateway, type OwnerGateway, ROOT } from "../gateway-owner.ts";
import { personaTokens } from "./greet.ts";

/** Whoever can see the world's rooms and own its agents. PLAN 8.4. */
const OWNERS = ["alex", "priya"];
const MATTERMOST_CONTAINER = `${process.env.COMPOSE_PROJECT_NAME ?? "switch"}-mattermost-1`;
const TEAM = "switch";
/** The baseline room is not in the world's template. It holds no Clearance, on purpose. */
const BASELINE_ROOM = "support-vanilla";

type RoomRow = { id: string; name: string };
type RoomDetail = { id?: string; agent_ids?: string[]; external_channel_id?: string };
export type Log = (line: string) => void;

/** A name Mattermost accepts, sorted by when it was retired. */
export function retiredChannelName(room: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-").toLowerCase();
  return `${room}-take-${stamp}`;
}

/** Frees the name and keeps the posts. Goes by the room's real channel, whose slug can differ from the room's name. */
async function retireChannel(room: string, channelId: string, owner: string, take: number, log: Log): Promise<void> {
  const res = await fetch(`${process.env.MATTERMOST_URL ?? "http://127.0.0.1:8065"}/api/v4/channels/${channelId}`, {
    headers: { authorization: `Bearer ${personaTokens(ROOT)[owner] ?? ""}` },
  });
  // A channel nobody can read any more has nothing to keep.
  if (!res.ok) return;
  const channel = (await res.json()) as { name: string };
  const name = `${retiredChannelName(room, new Date())}${take > 0 ? `-${take}` : ""}`;
  const renamed = spawnSync(
    "docker",
    ["exec", MATTERMOST_CONTAINER, "mmctl", "--local", "channel", "rename", `${TEAM}:${channel.name}`, "--name", name, "--display-name", name],
    { encoding: "utf8" },
  );
  if (renamed.status === 0) log(`kept the old channel as ${name}`);
}

/** Every room with this name. More than one can exist, and each holds a channel with people in it. */
async function findRooms(room: string): Promise<{ gateway: OwnerGateway; owner: string; found: RoomRow }[]> {
  const seen = new Set<string>();
  const all: { gateway: OwnerGateway; owner: string; found: RoomRow }[] = [];
  for (const owner of OWNERS) {
    const gateway = await ownerGateway(owner);
    for (const found of (await gateway.must<RoomRow[]>("GET", "/rooms")).filter((r) => r.name === room)) {
      if (seen.has(found.id)) continue;
      seen.add(found.id);
      all.push({ gateway, owner, found });
    }
  }
  return all;
}

/** Restarts each agent, or starts it if it is stopped. Goes by the owner, so a room already gone costs nothing. */
async function freshSessions(agentIds: Set<string>, log: Log): Promise<void> {
  for (const owner of OWNERS) {
    const gateway = await ownerGateway(owner);
    const agents = await gateway.must<ManagedAgent[]>("GET", "/management/agents");
    for (const agent of agents) {
      const id = agentIdOf(agent);
      if (!agentIds.has(id)) continue;
      if (agent.desired_state === "running") {
        await gateway.must("POST", "/management/operations", { controller_id: agent.controller_id, agent_id: id, kind: "agent.restart" });
        log(`restarted ${agent.name}`);
      } else {
        await gateway.must("PATCH", `/management/agents/${id}`, { desired_state: "running" });
        log(`started ${agent.name}`);
      }
    }
  }
}

function runScript(args: string[], log: Log): void {
  const result = spawnSync("pnpm", ["exec", "tsx", ...args], { cwd: ROOT, encoding: "utf8" });
  for (const line of result.stdout.split("\n")) if (/restarted core|added|created the rooms/.test(line)) log(line);
  if (result.status !== 0) throw new Error(`${args[0]} failed: ${result.stderr.slice(0, 500)}`);
}

/** SC1 runs the baseline with auto mode on and SC2 with it off, so the take has to set it. Changing it restarts the agent. */
export async function setBaselineAutoMode(autoMode: boolean, log: Log = () => undefined): Promise<void> {
  const gateway = await ownerGateway("priya");
  const agent = (await gateway.must<ManagedAgent[]>("GET", "/management/agents")).find((a) => a.name === "refunds-agent-vanilla");
  if (!agent) throw new Error("refunds-agent-vanilla is not defined: run scripts/setup-baseline.ts");
  if (agent.definition.auto_mode === autoMode) return;
  await gateway.must("PATCH", `/management/agents/${agentIdOf(agent)}`, { definition: { ...agent.definition, auto_mode: autoMode } });
  log(`baseline agent: auto mode ${autoMode ? "on" : "off"}`);
}

export async function freshRoom(room: string, log: Log = () => undefined): Promise<void> {
  const members = new Set<string>();
  let take = 0;
  for (const { gateway, owner, found } of await findRooms(room)) {
    const detail = await gateway.must<RoomDetail>("GET", `/rooms/${found.id}`);
    for (const id of detail.agent_ids ?? []) members.add(id);
    if (detail.external_channel_id) await retireChannel(room, detail.external_channel_id, owner, take++, log);
    await gateway.must("POST", "/rooms/bulk-delete", { room_ids: [found.id], retire_channel: true });
    log(`deleted room ${room}`);
  }
  await freshSessions(members, log);

  if (room === BASELINE_ROOM) {
    const gateway = await ownerGateway("priya");
    const agents = await gateway.must<ManagedAgent[]>("GET", "/management/agents");
    const agent = agents.find((a) => a.name === "refunds-agent-vanilla");
    if (!agent) throw new Error("refunds-agent-vanilla is not defined: run scripts/setup-baseline.ts");
    await gateway.must("POST", "/rooms", {
      name: room,
      description: "The baseline room. Switch's defaults, with no Clearance in it.",
      instructions: "Customer requests arrive here. refunds-agent-vanilla handles refunds.",
      agent_ids: [agentIdOf(agent)],
      user_names: ["priya"],
    });
    log(`created room ${room}`);
    return;
  }
  // Recreates the room from the template, puts it back in its group, and updates core's map. The take says hello itself.
  runScript(["scripts/setup-world.ts", "--no-greet"], log);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [room] = process.argv.slice(2);
  if (!room) throw new Error("usage: fresh-room.ts <room>");
  await freshRoom(room, console.log);
  console.log(`#${room} is fresh. New channel in ${join(ROOT, "data/identities.json")}`);
}

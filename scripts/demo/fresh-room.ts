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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentIdOf, type ManagedAgent, mattermostContainer, ownerGateway, type OwnerGateway, ROOT } from "../gateway-owner.ts";
import { roomsOf } from "../setup-world.ts";
import { personaTokens } from "./greet.ts";

/** Whoever can see the world's rooms and own its agents. PLAN 8.4. */
const OWNERS = ["alex", "priya"];
const TEAM = "switch";
/** The baseline rooms are not in the world's template. They hold no Clearance, on purpose. */
const BASELINE_ROOMS: Record<string, { agent: string; description: string; instructions: string; users: string[] }> = {
  "support-vanilla": {
    agent: "refunds-agent-vanilla",
    description: "The baseline room. Switch's defaults, with no Clearance in it.",
    instructions: "Customer requests arrive here. refunds-agent-vanilla handles refunds.",
    users: ["priya", "sam"],
  },
  "ops-vanilla": {
    agent: "ops-agent-vanilla",
    description: "E2's baseline room for OpenCode. Switch's defaults, with no Clearance in it.",
    instructions: "Requests arrive here. ops-agent-vanilla handles deploys and rollbacks.",
    users: ["priya"],
  },
};

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
    ["exec", mattermostContainer(), "mmctl", "--local", "channel", "rename", `${TEAM}:${channel.name}`, "--name", name, "--display-name", name],
    { encoding: "utf8" },
  );
  if (renamed.status === 0) log(`kept the old channel as ${name}`);
}

/**
 * Switch answers 200 and skips a room the caller may not delete, and an admin can see rooms it can't delete. So this
 * tries each owner, and a room nobody could delete is an error: a take would go on beside the old room, and each take
 * would leave one more behind.
 */
export async function deleteRoom(roomId: string, gateways: Pick<OwnerGateway, "must">[]): Promise<void> {
  for (const gateway of gateways) {
    const { deleted } = await gateway.must<{ deleted: number }>("POST", "/rooms/bulk-delete", {
      room_ids: [roomId],
      retire_channel: true,
    });
    if (deleted === 1) return;
  }
  throw new Error(`no owner could delete room ${roomId}`);
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

/** Who the template puts in a room, or a room made again would start without an agent the old one didn't have yet. */
function templateAgents(room: string): string[] {
  const template = readFileSync(join(ROOT, "templates/acme-mini.template.yaml"), "utf8");
  return roomsOf(template).find((one) => one.name === room)?.agents ?? [];
}

/**
 * Agents a room lists only so work asked of them by mistake has somewhere to go. A take of that room leaves them stopped
 * unless it asks for them. Measured in F24's takes: restarted, one picked up an old message from its own room, and its
 * card landed in this one, which on camera would be a stray refund in a scene about a merge.
 */
export const VISITORS: Readonly<Record<string, readonly string[]>> = { eng: ["refunds-agent"] };

/** What a fresh take does with one agent. A visitor nobody asked for is stopped, and everyone else in the room starts fresh. */
export function sessionAction(
  room: string,
  agent: { name: string; inRoom: boolean; running: boolean },
  templateAgents: readonly string[],
  visitorsWanted: readonly string[],
): "restart" | "start" | "stop" | "leave" {
  const isVisitor = (VISITORS[room] ?? []).includes(agent.name);
  if (isVisitor && !visitorsWanted.includes(agent.name)) return agent.running ? "stop" : "leave";
  if (!agent.inRoom && !templateAgents.includes(agent.name)) return "leave";
  return agent.running ? "restart" : "start";
}

/** Restarts each agent, or starts it if it is stopped. Goes by the owner, so a room already gone costs nothing. */
async function freshSessions(
  room: string,
  agentIds: Set<string>,
  log: Log,
  templateNames: readonly string[],
  visitorsWanted: readonly string[],
): Promise<void> {
  for (const owner of OWNERS) {
    const gateway = await ownerGateway(owner);
    const agents = await gateway.must<ManagedAgent[]>("GET", "/management/agents");
    for (const agent of agents) {
      const id = agentIdOf(agent);
      const running = agent.desired_state === "running";
      const action = sessionAction(room, { name: agent.name, inRoom: agentIds.has(id), running }, templateNames, visitorsWanted);
      if (action === "leave") continue;
      if (action === "stop") {
        await gateway.must("PATCH", `/management/agents/${id}`, { desired_state: "stopped" });
        log(`stopped ${agent.name}: this take doesn't need it`);
        continue;
      }
      if (action === "restart") {
        await gateway.must("POST", "/management/operations", { controller_id: agent.controller_id, agent_id: id, kind: "agent.restart" });
        log(`restarted ${agent.name}`);
      } else {
        await gateway.must("PATCH", `/management/agents/${id}`, { desired_state: "running" });
        log(`started ${agent.name}`);
      }
    }
  }
}

/**
 * Recorded takes only. Measured: an agent told "ship it to staging" at the end of SC6 went on working, and its deploy reached
 * the next take, on the camera of a scene about something else. So nothing an earlier take set going carries on into this
 * one. A stopped agent stays stopped: E2's baseline agent isn't started by anything but scripts/setup-e2.ts.
 */
export async function restartRunningAgents(log: Log = () => undefined): Promise<void> {
  const running = new Set<string>();
  for (const owner of OWNERS) {
    const gateway = await ownerGateway(owner);
    for (const agent of await gateway.must<ManagedAgent[]>("GET", "/management/agents")) {
      if (agent.desired_state === "running") running.add(agentIdOf(agent));
    }
  }
  await freshSessions("", running, log, [], []);
}

function runScript(args: string[], log: Log): void {
  const result = spawnSync("pnpm", ["exec", "tsx", ...args], { cwd: ROOT, encoding: "utf8" });
  for (const line of result.stdout.split("\n")) if (/restarted core|added|created the rooms/.test(line)) log(line);
  if (result.status !== 0) throw new Error(`${args[0]} failed: ${result.stderr.slice(0, 500)}`);
}

/**
 * What a baseline scene needs of the agent, so the take can set it. SC1 runs auto mode on and SC2 off, and SC14 also lets
 * Sam answer, which is Switch's own "anyone". The rest keep Switch's default, its owner and the owner's agents.
 */
export async function setBaseline(autoMode: boolean, anyoneMayAnswer: boolean, log: Log = () => undefined): Promise<void> {
  const gateway = await ownerGateway("priya");
  const agent = (await gateway.must<ManagedAgent[]>("GET", "/management/agents")).find((a) => a.name === "refunds-agent-vanilla");
  if (!agent) throw new Error("refunds-agent-vanilla is not defined: run scripts/setup-baseline.ts");
  const id = agentIdOf(agent);
  await gateway.must("PUT", `/agents/${id}/addressing-policy`, {
    policy: anyoneMayAnswer ? null : { rules: [{ users: [], agents: [], owner: true, owner_agents: true }] },
  });
  // Changing this restarts the agent, so it comes before the room.
  if (agent.definition.auto_mode === autoMode) return;
  await gateway.must("PATCH", `/management/agents/${id}`, { definition: { ...agent.definition, auto_mode: autoMode } });
  log(`baseline agent: auto mode ${autoMode ? "on" : "off"}`);
}

export async function freshRoom(room: string, log: Log = () => undefined, visitors: readonly string[] = []): Promise<void> {
  const members = new Set<string>();
  let take = 0;
  const gateways = await Promise.all(OWNERS.map((owner) => ownerGateway(owner)));
  for (const { gateway, owner, found } of await findRooms(room)) {
    const detail = await gateway.must<RoomDetail>("GET", `/rooms/${found.id}`);
    for (const id of detail.agent_ids ?? []) members.add(id);
    if (detail.external_channel_id) await retireChannel(room, detail.external_channel_id, owner, take++, log);
    await deleteRoom(found.id, gateways);
    log(`deleted room ${room}`);
  }
  await freshSessions(room, members, log, templateAgents(room), visitors);

  const baseline = BASELINE_ROOMS[room];
  if (baseline) {
    const gateway = await ownerGateway("priya");
    const agents = await gateway.must<ManagedAgent[]>("GET", "/management/agents");
    const agent = agents.find((a) => a.name === baseline.agent);
    if (!agent) throw new Error(`${baseline.agent} is not defined: run scripts/setup-baseline.ts or scripts/setup-e2.ts`);
    await gateway.must("POST", "/rooms", {
      name: room,
      description: baseline.description,
      instructions: baseline.instructions,
      agent_ids: [agentIdOf(agent)],
      user_names: baseline.users,
    });
    log(`created room ${room}`);
    return;
  }
  // Recreates the room from the template, puts it back in its group, and updates core's map. The take says hello itself.
  runScript(["scripts/setup-world.ts", "--no-greet"], log);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [room, ...visitors] = process.argv.slice(2);
  if (!room) throw new Error("usage: fresh-room.ts <room> [visitor agents]");
  await freshRoom(room, console.log, visitors);
  console.log(`#${room} is fresh. New channel in ${join(ROOT, "data/identities.json")}`);
}

/**
 * Replace a world room with an empty one, so the next run cannot read an earlier run: deletes the Switch room,
 * deletes its retired Mattermost channel so the name comes back bare, restarts the room's agents so no session
 * holds old context, and reruns scripts/setup-world.ts, which recreates the room and updates core's map.
 *
 *   pnpm exec tsx spikes/fresh-room.ts support [--mm-only]
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownerGateway, type ManagedAgent, agentIdOf } from "../scripts/gateway-owner.js";

const [room] = process.argv.slice(2);
if (!room) throw new Error("usage: fresh-room.ts <room>");
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const owner = await ownerGateway("alex");
const rooms = await owner.must<{ id: string; name: string }[]>("GET", "/rooms");
const found = rooms.find((r) => r.name === room);
if (found) {
  const detail = await owner.must<{ agent_ids?: string[] }>("GET", `/rooms/${found.id}`);
  await owner.must("POST", "/rooms/bulk-delete", { room_ids: [found.id], retire_channel: true });
  console.log(`deleted room ${room}`);
  // Sessions outlive their room, and a resumed conversation is memory: restart each managed agent in it.
  for (const persona of ["priya", "alex"]) {
    const gateway = await ownerGateway(persona);
    const agents = await gateway.must<ManagedAgent[]>("GET", "/management/agents");
    for (const agent of agents) {
      if (!detail.agent_ids?.includes(agentIdOf(agent))) continue;
      await gateway.must("POST", "/management/operations", {
        controller_id: agent.controller_id,
        agent_id: agentIdOf(agent),
        kind: "agent.restart",
      });
      console.log(`restarted ${agent.name}`);
    }
  }
}
const purge = spawnSync("docker", ["exec", "switch-mattermost-1", "mmctl", "--local", "channel", "delete", `switch:${room}`, "--confirm"], {
  encoding: "utf8",
});
console.log(purge.status === 0 ? `purged Mattermost channel ${room}` : `no channel purged: ${(purge.stderr || purge.stdout).trim().slice(0, 160)}`);
const world = spawnSync("pnpm", ["exec", "tsx", "scripts/setup-world.ts"], { cwd: REPO, encoding: "utf8" });
console.log(world.stdout.split("\n").filter((line) => line.includes(room) || /restarted|map/.test(line)).join("\n"));
if (world.status !== 0) throw new Error(`setup-world failed: ${world.stderr.slice(0, 500)}`);

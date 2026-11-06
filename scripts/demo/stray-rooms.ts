/**
 * Archives rooms that hold a protected agent but not Clearance, such as an old direct message to it. At hold time core
 * asks Switch where the agent is, and a room it can't hear counts as somewhere someone may have asked, so that agent's
 * requests need two approvers until the room is archived. Nothing is deleted. Nobody should DM a protected agent on the
 * demo stack, and room-limited addressing refuses it now, but the room such a DM made stays behind.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentIdOf, type ManagedAgent, ownerGateway, type OwnerGateway, ROOT } from "../gateway-owner.ts";
import { PEOPLE } from "./greet.ts";

type RoomRow = { id: string; name: string };
type Log = (line: string) => void;

/** A room to archive: it holds a protected agent, and Clearance can't hear it. */
export function isStray(agentIds: string[], protectedIds: Set<string>, clearanceId: string): boolean {
  return !agentIds.includes(clearanceId) && agentIds.some((id) => protectedIds.has(id));
}

export function clearanceAgentId(root: string = ROOT): string {
  const identities = JSON.parse(readFileSync(join(root, "data/identities.json"), "utf8")) as {
    agents?: Record<string, { switchAgentId?: string }>;
  };
  const id = identities.agents?.clearance?.switchAgentId;
  if (!id) throw new Error("the Clearance agent is not registered: run scripts/setup-identities.ts");
  return id;
}

/** Each person's view, since a direct room only shows to its members. Returns who could not archive one, if anyone. */
export async function findStrayRooms(protectedNames: string[]): Promise<{ gateway: OwnerGateway; room: RoomRow }[]> {
  const clearance = clearanceAgentId();
  const protectedIds = new Set<string>();
  const gateways = new Map<string, OwnerGateway>();
  for (const person of PEOPLE) gateways.set(person, await ownerGateway(person));
  for (const gateway of gateways.values()) {
    for (const agent of await gateway.must<ManagedAgent[]>("GET", "/management/agents")) {
      if (protectedNames.includes(agent.name)) protectedIds.add(agentIdOf(agent));
    }
  }
  const seen = new Set<string>();
  const stray: { gateway: OwnerGateway; room: RoomRow }[] = [];
  for (const gateway of gateways.values()) {
    for (const room of await gateway.must<RoomRow[]>("GET", "/rooms")) {
      if (seen.has(room.id)) continue;
      seen.add(room.id);
      const detail = await gateway.must<{ agent_ids?: string[] }>("GET", `/rooms/${room.id}`);
      if (isStray(detail.agent_ids ?? [], protectedIds, clearance)) stray.push({ gateway, room });
    }
  }
  return stray;
}

export async function archiveStrayRooms(protectedNames: string[], log: Log = () => undefined): Promise<number> {
  const stray = await findStrayRooms(protectedNames);
  for (const { gateway, room } of stray) {
    await gateway.must("POST", `/rooms/${room.id}/archive`);
    log(`archived ${room.name}, which held a protected agent and not Clearance`);
  }
  return stray.length;
}

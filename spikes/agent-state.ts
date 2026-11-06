/**
 * Start or stop a managed agent, as its owner. `stopped` ends its host and its sessions and keeps it defined.
 *
 *   pnpm exec tsx spikes/agent-state.ts <agent> running|stopped
 */
import { agentIdOf, ownerGateway, type ManagedAgent } from "../scripts/gateway-owner.js";

const [name, state] = process.argv.slice(2);
if (!name || (state !== "running" && state !== "stopped")) throw new Error("usage: agent-state.ts <agent> running|stopped");
for (const owner of ["priya", "alex"]) {
  const gateway = await ownerGateway(owner);
  const agents = await gateway.must<ManagedAgent[]>("GET", "/management/agents");
  const agent = agents.find((a) => a.name === name);
  if (!agent) continue;
  await gateway.must("PATCH", `/management/agents/${agentIdOf(agent)}`, { desired_state: state });
  console.log(`${name} (${owner}) set to ${state}`);
}

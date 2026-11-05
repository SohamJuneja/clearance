/**
 * Leave refunds-agent-vanilla defined with no running session. A running agent's host re-launches its
 * session after a restart, so only `desired_state: stopped` ends it. spikes/baseline-run.ts starts it again.
 *
 *   pnpm exec tsx spikes/baseline-stop.ts
 */
import { agentIdOf, ownerGateway, type ManagedAgent } from "../scripts/gateway-owner.js";

const gateway = await ownerGateway("priya");
const agents = await gateway.must<ManagedAgent[]>("GET", "/management/agents");
const agent = agents.find((a) => a.name === "refunds-agent-vanilla");
if (!agent) throw new Error("refunds-agent-vanilla is not defined");
await gateway.must("PATCH", `/management/agents/${agentIdOf(agent)}`, { desired_state: "stopped" });
console.log("refunds-agent-vanilla set to stopped");

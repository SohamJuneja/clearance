/**
 * What each owner holds: their machines and managed agents. Read only, prints no secrets.
 *
 *   pnpm exec tsx spikes/owner-state.ts [owner ...]     owners default to admin priya alex
 */
import { ownerGateway } from "../scripts/gateway-owner.js";

const owners = process.argv.slice(2).length ? process.argv.slice(2) : ["admin", "priya", "alex"];
for (const owner of owners) {
  const gateway = await ownerGateway(owner);
  const controllers = (await gateway.must("GET", "/management/controllers")) as any[];
  const agents = (await gateway.must("GET", "/management/agents")) as any[];
  console.log(`== ${owner}`);
  for (const c of controllers) {
    console.log(
      `  machine ${String(c.name)} ${String(c.id).slice(0, 8)} revoked=${String(Boolean(c.revoked_at))} sessions=${String(c.status?.machine?.sessions_running)} agents_reported=${c.status?.agents?.length ?? 0}`,
    );
  }
  for (const a of agents) {
    const def = a.definition ?? {};
    console.log(
      `  agent ${String(a.name)} desired=${String(a.desired_state)} model=${String(def.model)} auto_mode=${String(def.auto_mode)} dir=${String(def.directory)}`,
    );
  }
}

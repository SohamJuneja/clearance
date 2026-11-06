/**
 * Live check after scripts/setup-agents.ts with a prefix: what the server and the folders really hold.
 * Prints file modes and whether tokens match, never the tokens.
 *
 *   pnpm exec tsx spikes/setup-agents-check.ts <prefix> <base> [--cleanup]
 */
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultHookTokensPath } from "../packages/hook-cli/src/setup.ts";
import { agentIdOf, ownerGateway, rootEnv, type ManagedAgent } from "../scripts/gateway-owner.js";

const [prefix, base, flag] = process.argv.slice(2);
if (!prefix || !base) throw new Error("usage: setup-agents-check.ts <prefix> <base> [--cleanup]");
const env = rootEnv();
const grants = JSON.parse(env.GATE_AGENT_TOKENS ?? "{}") as Record<string, { agent?: string }>;
const hookTokens = JSON.parse(readFileSync(defaultHookTokensPath(env), "utf8")) as Record<string, string>;
const mode = (path: string) => (existsSync(path) ? (statSync(path).mode & 0o777).toString(8) : "missing");

for (const owner of ["priya", "alex"]) {
  const gateway = await ownerGateway(owner);
  const agents = (await gateway.must<ManagedAgent[]>("GET", "/management/agents")).filter((a) => a.name.startsWith(prefix));
  for (const agent of agents) {
    const id = agentIdOf(agent);
    const row = await gateway.must<{ owner_id?: string; addressing_policy?: unknown }>("GET", `/agents/${id}`);
    const dir = join(base, agent.name);
    const local = join(dir, ".claude/settings.local.json");
    const settings = existsSync(local) ? (JSON.parse(readFileSync(local, "utf8")) as Record<string, any>) : {};
    const hookFile = join(dir, ".clearance/hook-token");
    const gateFile = join(dir, ".clearance/gate-token");
    const plain = agent.name.slice(prefix.length);
    console.log(
      JSON.stringify({
        agent: agent.name,
        owner,
        controller_is_owners: Boolean(agent.controller_id),
        desired: agent.desired_state,
        model: agent.definition.model,
        auto_mode: agent.definition.auto_mode,
        directory_ok: agent.definition.directory === dir,
        brief_has_rules: String(agent.definition.instructions).includes("Clearance rules"),
        addressing_policy: row.addressing_policy ?? null,
        modes: { local_settings: mode(local), hook_token: mode(hookFile), gate_token: mode(gateFile), clearance_dir: mode(join(dir, ".clearance")) },
        local_hook_token_is_this_agents: hookTokens[settings.env?.CLEARANCE_HOOK_TOKEN] === agent.name,
        hook_file_is_this_agents: existsSync(hookFile) && hookTokens[readFileSync(hookFile, "utf8").trim()] === agent.name,
        gate_file_is_this_agents: existsSync(gateFile) && grants[readFileSync(gateFile, "utf8").trim()]?.agent === plain,
        containment: { disabled: settings.disableClaudeAiConnectors, deny: settings.permissions?.deny, plugins_off: Object.keys(settings.enabledPlugins ?? {}).length },
      }),
    );
    if (flag === "--cleanup") {
      await gateway.must("DELETE", `/management/agents/${id}`);
      await gateway.call("DELETE", `/agents/${id}`);
    }
  }
}
if (flag === "--cleanup") {
  rmSync(base, { recursive: true, force: true });
  console.log(`cleaned up agents named ${prefix}* and ${base}`);
}

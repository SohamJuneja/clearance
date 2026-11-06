/**
 * The Claude hook route with scripted calls and no agent, so this proves plumbing, not agent behaviour: does
 * core answer the way the real hook payload needs, and does the ledger record it? Starts from the real fixture
 * shape (spikes/fixtures/claude-pretooluse.json). Prints decisions only, never a token.
 *
 *   pnpm exec tsx spikes/hook-check.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { rootEnv } from "../scripts/gateway-owner.js";

const env = rootEnv();
const core = env.CLEARANCE_CORE_URL ?? "http://127.0.0.1:7700";
const cwd = join(homedir(), ".switch/agents/127.0.0.1-8000/refunds-agent");

const cases: [string, Record<string, unknown>][] = [
  ["read through the CLI", { tool_name: "Bash", tool_input: { command: "bin/acme order A-2004" } }],
  ["curl the payments API directly", { tool_name: "Bash", tool_input: { command: "curl -X POST -H 'x-acme-admin-key: x' http://127.0.0.1:7800/refunds -d '{}'" } }],
  ["edit the hook config", { tool_name: "Edit", tool_input: { file_path: `${cwd}/.claude/settings.json`, old_string: "a", new_string: "b" } }],
  ["git push --force", { tool_name: "Bash", tool_input: { command: "git push --force origin main" } }],
];

for (const [label, call] of cases) {
  const res = await fetch(`${core}/v1/hooks/claude`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CLEARANCE_HOOK_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      session_id: "00000000-0000-4000-8000-000000000000",
      cwd,
      permission_mode: "auto",
      agent_type: "refunds-agent",
      hook_event_name: "PreToolUse",
      tool_use_id: `toolu_check_${label.replaceAll(" ", "_")}`,
      ...call,
    }),
  });
  const body = (await res.json()) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  console.log(`${label}: HTTP ${res.status} ${body.hookSpecificOutput?.permissionDecision ?? "(no decision)"} ${(body.hookSpecificOutput?.permissionDecisionReason ?? "").slice(0, 170)}`);
}

const unauth = await fetch(`${core}/v1/hooks/claude`, {
  method: "POST",
  headers: { authorization: "Bearer wrong", "content-type": "application/json" },
  body: JSON.stringify({ cwd, tool_name: "Bash", tool_input: { command: "git status" } }),
});
console.log(`wrong token: HTTP ${unauth.status}`);

const ledger = (await (await fetch(`${core}/v1/ledger`, { headers: { authorization: `Bearer ${env.CLEARANCE_INTERNAL_TOKEN}` } })).json()) as
  | { entries?: Record<string, unknown>[] }
  | Record<string, unknown>[];
const entries = Array.isArray(ledger) ? ledger : (ledger.entries ?? []);
console.log(`ledger: ${entries.length} entries; last 4 types: ${entries.slice(-4).map((e) => String(e.type)).join(", ")}`);
const denied = entries.filter((e) => JSON.stringify(e).includes("protected_config"));
console.log(`entries naming protected_config: ${denied.length}`);

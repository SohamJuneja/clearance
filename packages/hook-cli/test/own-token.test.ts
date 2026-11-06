/**
 * Each vendor, set up the way scripts/setup-agents.ts sets it up, reaches the real hook routes with its
 * own token, and comes out the other side as itself. Files and commands are the real ones from
 * acme-mini-app; only the vendor is missing. Cursor has never been run, so its row proves mechanics only.
 */
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Action } from "@clearance/contracts";
import { hookRoutes, loadHookTokens } from "@clearance/adapters";
import plugin from "../../../acme-mini-app/.opencode/plugins/clearance.ts";
import { hookTokenFor, writeAgentSecrets } from "../src/setup.ts";
import { ACME_APP, run, tempDir } from "./helpers.js";

/** All Switch passes a session, measured in spikes/RESULTS-vendors.md. No token among them. */
const SWITCH_ENV = {
  HOME: process.env.HOME ?? "",
  LANG: "C.UTF-8",
  SHELL: "/bin/sh",
  USER: "agent",
  CLAUDE_AGENT_SDK_VERSION: "0",
  CLAUDE_CODE_ENTRYPOINT: "sdk",
};

const hookCommand = (file: string, event: string): string => {
  const config = JSON.parse(readFileSync(join(ACME_APP, file), "utf8"));
  const entry = config.hooks[event][0];
  return (entry.hooks ? entry.hooks[0] : entry).command as string;
};

let root: string;
let dirs: Record<string, string>;
let tokensPath: string;
let core: FastifyInstance;
let url: string;
let checks: Action[];

/** Sets one agent up as setup does: its own copy of the vendor config, and its own token. */
function setUpAgent(agent: string): string {
  const dir = join(root, agent);
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(join(ACME_APP, "bin", "clearance-hook"), join(dir, "bin", "clearance-hook"));
  cpSync(join(ACME_APP, ".claude"), join(dir, ".claude"), { recursive: true });
  writeAgentSecrets(dir, {
    hookToken: hookTokenFor(tokensPath, agent),
    gateToken: `gate-${agent}`,
    gateUrl: "http://127.0.0.1:1",
  });
  return dir;
}

beforeEach(async () => {
  root = tempDir("own-token-");
  tokensPath = join(root, "data", "hook-tokens.json");
  dirs = Object.fromEntries(
    ["coder", "support-agent", "ops-agent", "reviewer"].map((agent) => [agent, setUpAgent(agent)]),
  );
  checks = [];
  core = Fastify();
  await hookRoutes(core, {
    check: async (action) => {
      checks.push(action);
      return { decision: "allow", reason: "ok" };
    },
    resolveAgent: (cwd, agentType) => {
      if (agentType !== undefined) return dirs[agentType] ? agentType : null;
      return Object.entries(dirs).find(([, dir]) => dir === cwd)?.[0] ?? null;
    },
    hookTokens: loadHookTokens(tokensPath),
  });
  url = await core.listen({ port: 0, host: "127.0.0.1" });
});

afterEach(async () => {
  await core.close();
});

const bash = (agentDir: string, event = "PreToolUse") =>
  JSON.stringify({
    hook_event_name: event,
    session_id: "s",
    turn_id: "t",
    cwd: agentDir,
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });

/** Runs a configured hook command the way the vendor does: a shell in the agent's directory. */
const runConfigured = (command: string, cwd: string, stdin: string) =>
  run("/bin/sh", ["-c", command], {
    cwd,
    stdin,
    env: {
      ...SWITCH_ENV,
      CLEARANCE_CORE_URL: url,
      CLEARANCE_HOOK_CLI: join(ACME_APP, "..", "packages/hook-cli/src/main.ts"),
    },
  });

describe("each vendor reaches the route with its own token", () => {
  it("Claude: the header in .claude/settings.json, filled from settings.local.json", async () => {
    const dir = dirs.coder!;
    const hook = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8")).hooks
      .PreToolUse[0].hooks[0];
    const local = JSON.parse(readFileSync(join(dir, ".claude/settings.local.json"), "utf8"));
    expect(hook.allowedEnvVars).toEqual(["CLEARANCE_HOOK_TOKEN"]);
    const authorization = (hook.headers.Authorization as string).replace(
      "$CLEARANCE_HOOK_TOKEN",
      local.env.CLEARANCE_HOOK_TOKEN,
    );
    const res = await core.inject({
      method: "POST",
      url: "/v1/hooks/claude",
      headers: { authorization, "content-type": "application/json" },
      payload: JSON.stringify({ ...JSON.parse(bash(dir)), agent_type: "coder" }),
    });
    expect(res.json().hookSpecificOutput.permissionDecision).toBe("allow");
    expect(checks[0]!.agent.name).toBe("coder");
  });

  it.each(["PreToolUse", "PermissionRequest"])(
    "Codex %s: the command in .codex/hooks.json, with no token in its env",
    async (event) => {
      const dir = dirs["support-agent"]!;
      const out = await runConfigured(
        hookCommand(".codex/hooks.json", event),
        dir,
        bash(dir, event),
      );
      expect(out.code, out.stderr).toBe(0);
      expect(out.stdout).not.toContain('"deny"');
      expect(checks[0]!.agent.name).toBe("support-agent");
    },
  );

  it("OpenCode: the plugin, with no token in its env", async () => {
    const saved = { url: process.env.CLEARANCE_CORE_URL, token: process.env.CLEARANCE_HOOK_TOKEN };
    process.env.CLEARANCE_CORE_URL = url;
    delete process.env.CLEARANCE_HOOK_TOKEN;
    try {
      const hooks = await plugin.server({ directory: dirs["ops-agent"]! });
      await hooks["tool.execute.before"](
        { tool: "bash", sessionID: "s", callID: "c" },
        { args: { command: "ls" } },
      );
    } finally {
      process.env.CLEARANCE_CORE_URL = saved.url;
      if (saved.token !== undefined) process.env.CLEARANCE_HOOK_TOKEN = saved.token;
    }
    expect(checks[0]!.agent.name).toBe("ops-agent");
  });

  it("Cursor, mechanics only: the command in .cursor/hooks.json", async () => {
    const dir = dirs.reviewer!;
    const out = await runConfigured(
      hookCommand(".cursor/hooks.json", "beforeShellExecution"),
      dir,
      JSON.stringify({ hook_event_name: "beforeShellExecution", command: "ls", cwd: dir }),
    );
    expect(out.code, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ permission: "allow" });
    expect(checks[0]!.agent.name).toBe("reviewer");
  });
});

describe("what an agent can't do with what's on its disk", () => {
  it("another agent's directory in the payload is refused, naming both", async () => {
    const dir = dirs["support-agent"]!;
    const out = await runConfigured(
      hookCommand(".codex/hooks.json", "PreToolUse"),
      dir,
      bash(dirs.coder!),
    );
    const reason = JSON.parse(out.stdout).hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toContain("support-agent");
    expect(reason).toContain("coder");
    expect(checks).toHaveLength(0);
  });

  it("the old shared token no longer works, in a directory that has not been set up again", async () => {
    const dir = dirs["support-agent"]!;
    writeFileSync(join(dir, ".clearance", "hook-token"), "old-shared-token\n");
    const out = await runConfigured(hookCommand(".codex/hooks.json", "PreToolUse"), dir, bash(dir));
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/token/i);
    expect(checks).toHaveLength(0);
  });

  it("every agent's token is different", () => {
    const tokens = Object.values(dirs).map((dir) =>
      readFileSync(join(dir, ".clearance/hook-token"), "utf8"),
    );
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

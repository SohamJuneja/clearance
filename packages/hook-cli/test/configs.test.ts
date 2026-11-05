import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACME_APP, HOOK_BIN, REPO_ROOT, deadUrl, run } from "./helpers.js";

const read = (path: string) => readFileSync(join(ACME_APP, path), "utf8");
const json = (path: string) => JSON.parse(read(path));

describe(".claude/settings.json", () => {
  const settings = json(".claude/settings.json");
  const groups = settings.hooks.PreToolUse;
  const hook = groups[0].hooks[0];

  it("matches everything except Switch's own tools, so an outage cannot silence the agent", () => {
    expect(groups).toHaveLength(1);
    const matcher = new RegExp(groups[0].matcher);
    for (const tool of ["Bash", "Write", "mcp__clearance_gate__refund_customer", "ToolSearchX"]) {
      expect(matcher.test(tool), tool).toBe(true);
    }
    for (const tool of ["mcp__switch__post_message", "ToolSearch"]) {
      expect(matcher.test(tool), tool).toBe(false);
    }
  });

  it("keeps the operator's claude.ai connectors away from the agent", () => {
    expect(settings.permissions.deny).toContain("mcp__claude_ai_*");
  });

  it("holds no token: that comes from the gitignored settings.local.json", () => {
    expect(settings.env).toBeUndefined();
    expect(read(".gitignore")).toMatch(/^\.claude\/settings\.local\.json$/m);
  });

  it("is the http hook measured in spike S1", () => {
    expect(hook).toEqual({
      type: "http",
      url: "http://127.0.0.1:7700/v1/hooks/claude",
      timeout: 20,
      onFailure: "block",
      headers: { Authorization: "Bearer $CLEARANCE_HOOK_TOKEN" },
      allowedEnvVars: ["CLEARANCE_HOOK_TOKEN"],
    });
  });
});

describe(".codex/hooks.json", () => {
  const { hooks } = json(".codex/hooks.json");

  const command = hooks.PreToolUse[0].hooks[0].command as string;

  it.each(["PreToolUse", "PermissionRequest"])(
    "%s runs clearance-hook codex on every tool, wrapped as measured in spike S5",
    (event) => {
      expect(hooks[event]).toHaveLength(1);
      expect(hooks[event][0].matcher).toBeUndefined();
      const hook = hooks[event][0].hooks[0];
      expect(hook.type).toBe("command");
      expect(hook.command).toMatch(
        /^timeout 2 \.\/bin\/clearance-hook codex \|\| \{ echo .+ >&2; exit 2; \}$/,
      );
      // Longer than the wrapper, so the wrapper blocks before Codex gives up and fails open.
      expect(hook.timeout).toBeGreaterThan(2);
    },
  );

  describe("the wrapper, run as written", () => {
    const withFakeHook = (script: string | null) => {
      const dir = mkdtempSync(join(tmpdir(), "codex-wrapper-"));
      if (script !== null) {
        mkdirSync(join(dir, "bin"));
        const file = join(dir, "bin", "clearance-hook");
        writeFileSync(file, `#!/bin/sh\n${script}\n`);
        chmodSync(file, 0o755);
      }
      return dir;
    };
    const wrapped = async (cwd: string, env: Record<string, string> = {}) =>
      run("/bin/sh", ["-c", command], { cwd, env, stdin: "{}" });

    it.each([
      ["a crash", "exit 1"],
      ["a kill", "kill -9 $"],
      ["a usage error", "exit 2"],
    ])("%s blocks with a reason, where Codex alone would fail open", async (_name, script) => {
      const dir = withFakeHook(script);
      const out = await wrapped(dir);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/Clearance denied/);
      rmSync(dir, { recursive: true, force: true });
    });

    it("a missing script blocks", async () => {
      const dir = withFakeHook(null);
      const out = await wrapped(dir);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/Clearance denied/);
      rmSync(dir, { recursive: true, force: true });
    });

    it("a hang blocks once the 2 s is up", async () => {
      const dir = withFakeHook("sleep 30");
      const out = await wrapped(dir);
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/Clearance denied/);
      expect(out.ms).toBeGreaterThan(1500);
      expect(out.ms).toBeLessThan(6000);
      rmSync(dir, { recursive: true, force: true });
    });

    it("a real deny passes through untouched, so the agent reads the real reason", async () => {
      const out = await run("/bin/sh", ["-c", command], {
        cwd: ACME_APP,
        env: { CLEARANCE_CORE_URL: await deadUrl(), CLEARANCE_HOOK_TOKEN: "t" },
        stdin: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }),
      });
      expect(out.code).toBe(0);
      expect(out.stderr).toBe("");
      expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    });
  });
});

describe(".cursor/hooks.json", () => {
  const config = json(".cursor/hooks.json");

  it("says it has not been run", () => {
    expect(read(".cursor/README.md")).toMatch(/untested/i);
  });

  it("has the MCP server, ready for when it can be tried", () => {
    expect(json(".cursor/mcp.json").mcpServers.clearance_gate.url).toBe(
      "http://127.0.0.1:7710/mcp",
    );
  });

  it("runs clearance-hook cursor and fails closed", () => {
    expect(config.version).toBe(1);
    expect(config.hooks.beforeShellExecution).toEqual([
      { command: "./bin/clearance-hook cursor", timeout: 10, failClosed: true },
    ]);
  });
});

describe("opencode.json", () => {
  const config = json("opencode.json");

  it("has the config schema", () => {
    expect(config.$schema).toBe("https://opencode.ai/config.json");
  });

  it("backs up only what is never approvable, so a deny here cannot break a granted retry", () => {
    const denied = Object.entries(config.permission.bash as Record<string, string>)
      .filter(([, action]) => action === "deny")
      .map(([pattern]) => pattern);
    expect(denied).toContain("docker *");
    expect(denied.some((p) => p.includes("7800"))).toBe(true);
    for (const pattern of denied) {
      expect(pattern).not.toMatch(/^git|acme/);
    }
    expect(config.permission.edit[".opencode/**"]).toBe("deny");
    expect(config.permission.read["**/.env*"]).toBe("deny");
  });

  it("has the gate's MCP server, with each agent's own token from its file", () => {
    expect(config.mcp.clearance_gate).toMatchObject({
      type: "remote",
      url: "http://127.0.0.1:7710/mcp",
      headers: { Authorization: "Bearer {file:.clearance/gate-token}" },
    });
  });

  it("never uses ask, which Switch auto-allows", () => {
    expect(JSON.stringify(config.permission)).not.toContain('"ask"');
  });
});

describe("agent instructions", () => {
  const plan = readFileSync(join(REPO_ROOT, "PLAN.md"), "utf8");
  const section = plan.slice(plan.indexOf("### 8.5 Agent instructions block"));
  const block = /```text\n([\s\S]*?)```/.exec(section)![1]!;

  it.each(["AGENTS.md", "CLAUDE.md"])("%s carries the PLAN 8.5 block word for word", (name) => {
    expect(block.startsWith("Clearance rules")).toBe(true);
    expect(read(name)).toContain(block);
  });

  it("gives every vendor the same instructions", () => {
    expect(read("AGENTS.md")).toBe(read("CLAUDE.md"));
  });
});

describe("files agents need", () => {
  it.each(["bin/acme", "bin/clearance-hook", "bin/mcp-headers"])("%s is executable", (path) => {
    expect(() => accessSync(join(ACME_APP, path), constants.X_OK)).not.toThrow();
    expect(statSync(join(ACME_APP, path)).mode & 0o111).not.toBe(0);
  });

  it.each([".clearance/", ".claude/settings.local.json", ".codex/config.toml"])(
    "keeps %s, which holds tokens, out of git",
    (path) => {
      expect(read(".gitignore").split("\n")).toContain(path);
    },
  );

  it("has checkout source for the coder to work on", () => {
    expect(read("src/checkout.ts").length).toBeGreaterThan(0);
  });

  it("holds no credentials: only the variable names", () => {
    for (const path of [
      ".claude/settings.json",
      ".codex/hooks.json",
      ".cursor/hooks.json",
      "opencode.json",
      ".mcp.json",
    ]) {
      expect(read(path)).not.toMatch(/Bearer [A-Za-z0-9]{8,}/);
    }
  });
});

describe(".mcp.json", () => {
  const server = json(".mcp.json").mcpServers.clearance_gate;

  it("points at the gate over streamable HTTP", () => {
    expect(server.type).toBe("http");
    expect(server.url).toBe("http://127.0.0.1:7710/mcp");
  });

  it("gets each agent's own token from a helper, with the env as a fallback", () => {
    expect(server.headersHelper).toBe("./bin/mcp-headers");
    expect(server.headers).toEqual({ Authorization: "Bearer ${ACME_GATE_TOKEN:-}" });
  });
});

describe("bin/mcp-headers", () => {
  const withApp = async (token: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-headers-"));
    mkdirSync(join(dir, "bin"));
    const helper = join(dir, "bin", "mcp-headers");
    copyFileSync(join(ACME_APP, "bin", "mcp-headers"), helper);
    if (token !== null) {
      mkdirSync(join(dir, ".clearance"));
      writeFileSync(join(dir, ".clearance", "gate-token"), token);
    }
    const out = await run("/bin/sh", [helper], { cwd: "/" });
    rmSync(dir, { recursive: true, force: true });
    return out;
  };

  it("prints the header as a JSON object of strings, which is what Claude Code requires", async () => {
    const out = await withApp("gate-token-value\n");
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ Authorization: "Bearer gate-token-value" });
  });

  it("fails without a token file, and prints no header", async () => {
    const out = await withApp(null);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/gate-token/);
  });

  it("fails on an empty token file", async () => {
    const out = await withApp("");
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
  });
});

describe("bin/clearance-hook launcher", () => {
  const stdin = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: {},
  });

  it("runs the CLI from the checkout by default", async () => {
    const out = await run(HOOK_BIN, ["codex"], {
      stdin,
      env: { CLEARANCE_CORE_URL: await deadUrl(), CLEARANCE_HOOK_TOKEN: "t" },
    });
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.stderr).not.toMatch(/ExperimentalWarning/);
  });

  it("works from another directory", async () => {
    const out = await run(HOOK_BIN, ["cursor"], {
      stdin: "{}",
      cwd: "/",
      env: { CLEARANCE_CORE_URL: await deadUrl(), CLEARANCE_HOOK_TOKEN: "t" },
    });
    expect(out.code).toBe(2);
    expect(JSON.parse(out.stdout).permission).toBe("deny");
  });

  it("denies when the CLI cannot be found (codex)", async () => {
    const out = await run(HOOK_BIN, ["codex"], {
      stdin,
      env: { CLEARANCE_HOOK_CLI: "/does/not/exist.ts" },
    });
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(
      /Clearance denied/,
    );
  });

  it("denies when the CLI cannot be found (cursor)", async () => {
    const out = await run(HOOK_BIN, ["cursor"], {
      stdin: "{}",
      env: { CLEARANCE_HOOK_CLI: "/does/not/exist.ts" },
    });
    expect(out.code).toBe(2);
    expect(JSON.parse(out.stdout).permission).toBe("deny");
  });

  it("denies when node is not on PATH", async () => {
    const out = await run("/bin/sh", [HOOK_BIN, "codex"], { stdin, env: { PATH: "/nonexistent" } });
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  describe("in an agent's clone outside this repo, where the env does not reach it", () => {
    const REAL_CLI = join(REPO_ROOT, "packages", "hook-cli", "src", "main.ts");
    const inClone = (hookCliFile: string | null) => {
      const dir = mkdtempSync(join(tmpdir(), "hook-clone-"));
      mkdirSync(join(dir, "bin"));
      copyFileSync(HOOK_BIN, join(dir, "bin", "clearance-hook"));
      chmodSync(join(dir, "bin", "clearance-hook"), 0o755);
      if (hookCliFile !== null) {
        mkdirSync(join(dir, ".clearance"));
        writeFileSync(join(dir, ".clearance", "hook-cli"), `${hookCliFile}\n`);
      }
      return dir;
    };

    it("finds the CLI from .clearance/hook-cli, which setup-agent writes", async () => {
      const dir = inClone(REAL_CLI);
      const out = await run(join(dir, "bin", "clearance-hook"), ["codex"], {
        cwd: dir,
        stdin,
        env: { CLEARANCE_CORE_URL: await deadUrl(), CLEARANCE_HOOK_TOKEN: "t" },
      });
      expect(out.code).toBe(0);
      const reason = JSON.parse(out.stdout).hookSpecificOutput.permissionDecisionReason;
      expect(reason).toMatch(/could not answer/);
      expect(reason).not.toMatch(/could not start/);
      rmSync(dir, { recursive: true, force: true });
    });

    it("denies when that file is missing", async () => {
      const dir = inClone(null);
      const out = await run(join(dir, "bin", "clearance-hook"), ["codex"], { cwd: dir, stdin });
      expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(
        /could not start/,
      );
      rmSync(dir, { recursive: true, force: true });
    });

    it("denies when that file points nowhere", async () => {
      const dir = inClone("/does/not/exist.ts");
      const out = await run(join(dir, "bin", "clearance-hook"), ["cursor"], {
        cwd: dir,
        stdin: "{}",
      });
      expect(out.code).toBe(2);
      expect(JSON.parse(out.stdout).permission).toBe("deny");
      rmSync(dir, { recursive: true, force: true });
    });
  });

  it("answers a Codex PermissionRequest in its own form when the CLI is missing", async () => {
    const out = await run(HOOK_BIN, ["codex"], {
      stdin: JSON.stringify({ hook_event_name: "PermissionRequest" }),
      env: { CLEARANCE_HOOK_CLI: "/does/not/exist.ts" },
    });
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout).hookSpecificOutput.decision.behavior).toBe("deny");
  });
});

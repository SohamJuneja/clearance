import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActionSchema } from "@clearance/contracts";
import {
  PayloadError,
  claudeAdapter,
  claudeResponse,
  codexAdapter,
  codexResponse,
  cursorAdapter,
  cursorResponse,
  opencodeAdapter,
  opencodeResponse,
  type AdapterContext,
  type HookOutcome,
} from "../src/index.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const load = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Record<string, unknown>;

const ctx: AdapterContext = { agent: "coder", id: "01ACTION", at: "2026-11-06T10:00:00.000Z" };
const ALLOW: HookOutcome = { decision: "allow", reason: "safe" };
const DENY: HookOutcome = { decision: "deny", reason: "HELD CLR-0042: needs approval." };

describe("fixtures", () => {
  const adapters = {
    claude: claudeAdapter,
    codex: codexAdapter,
    cursor: cursorAdapter,
    opencode: opencodeAdapter,
  };
  const names = readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));

  it("has fixtures for every vendor", () => {
    for (const vendor of Object.keys(adapters)) {
      expect(names.some((n) => n.startsWith(vendor))).toBe(true);
    }
  });

  it.each(names)("%s says where it came from and becomes valid Actions", (name) => {
    const payload = load(name);
    expect(["real", "docs"]).toContain(payload._source);
    const vendor = name.split("-")[0] as keyof typeof adapters;
    // Cursor has not been run yet, so nothing of its can claim to be a capture.
    if (vendor === "cursor") expect(payload._source).toBe("docs");
    const actions = adapters[vendor].toActions(payload, ctx);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(ActionSchema.safeParse(action).success).toBe(true);
      expect(action.source).toBe("hook");
      expect(action.vendor).toBe(vendor);
      expect(action.agent.name).toBe("coder");
      expect(action.raw).toEqual(payload);
      expect(action.at).toBe(ctx.at);
    }
  });
});

describe("Claude PreToolUse", () => {
  const one = (name: string) => {
    const actions = claudeAdapter.toActions(load(name), ctx);
    expect(actions).toHaveLength(1);
    return actions[0]!;
  };

  it("maps Bash to shell, with the description as an unverified claim", () => {
    const action = one("claude-pretooluse");
    expect(action.kind).toBe("shell");
    expect(action.shell).toEqual({
      command: "git -C /home/agent-user/.local/share/clearance-tools/spike-work/s1 push",
    });
    expect(action.agentClaim).toBe("Push local commits to origin");
    expect(action.agent.cwd).toBe("/home/agent-user/.local/share/clearance-tools/spike-work/s1");
    expect(action.session).toEqual({ vendorSessionId: "00000000-0000-4000-8000-000000000000" });
    expect(action.id).toBe("01ACTION");
  });

  it.each([
    "git -C /some/dir push",
    'git push origin main 2>&1; echo "exit=$?"; git ls-remote origin main',
    "  cd src  &&  rm -rf ../x  ",
  ])("passes a command through untouched, since parsing it is core's job: %s", (command) => {
    const action = claudeAdapter.toActions(
      { cwd: "/w", tool_name: "Bash", tool_input: { command } },
      ctx,
    )[0]!;
    expect(action.shell?.command).toBe(command);
  });

  it("maps a real Switch tool call to mcp", () => {
    const action = one("claude-pretooluse-mcp");
    expect(action.kind).toBe("mcp");
    expect(action.mcp).toMatchObject({ server: "switch", tool: "post_message" });
  });

  it("maps PowerShell to shell", () => {
    const action = claudeAdapter.toActions(
      { cwd: "/w", tool_name: "PowerShell", tool_input: { command: "Remove-Item x" } },
      ctx,
    )[0]!;
    expect(action.kind).toBe("shell");
    expect(action.shell?.command).toBe("Remove-Item x");
  });

  it("maps Write to file_write, relative to the working directory so src/ rules match", () => {
    const action = one("claude-write");
    expect(action.kind).toBe("file_write");
    expect(action.file).toEqual({ path: "src/checkout.ts" });
  });

  it("resolves .. so a protected path cannot hide behind a safe prefix", () => {
    const action = one("claude-edit-protected");
    expect(action.kind).toBe("file_write");
    expect(action.file).toEqual({ path: ".claude/settings.json" });
  });

  it("keeps a path outside the working directory absolute", () => {
    const action = claudeAdapter.toActions(
      {
        cwd: "/home/agent/coder",
        tool_name: "Write",
        tool_input: { file_path: "/home/agent/other/x" },
      },
      ctx,
    )[0]!;
    expect(action.file?.path).toBe("/home/agent/other/x");
    const escaped = claudeAdapter.toActions(
      { cwd: "/home/agent/coder", tool_name: "Write", tool_input: { file_path: "../other/x" } },
      ctx,
    )[0]!;
    expect(escaped.file?.path).toBe("/home/agent/other/x");
  });

  it("does not mistake a sibling directory for the working directory", () => {
    const action = claudeAdapter.toActions(
      {
        cwd: "/home/agent/coder",
        tool_name: "Read",
        tool_input: { file_path: "/home/agent/coder2/x" },
      },
      ctx,
    )[0]!;
    expect(action.file?.path).toBe("/home/agent/coder2/x");
  });

  it("maps Read to file_read", () => {
    const action = one("claude-read-env");
    expect(action.kind).toBe("file_read");
    expect(action.file).toEqual({ path: ".env" });
  });

  it("maps Grep to file_read and keeps its glob, so .env rules see it", () => {
    const action = one("claude-grep");
    expect(action.kind).toBe("file_read");
    expect(action.file?.path).toBe(".env*");
  });

  it("maps Glob to file_read and keeps its pattern", () => {
    const action = one("claude-glob");
    expect(action.kind).toBe("file_read");
    expect(action.file?.path).toBe("**/.env*");
  });

  it("maps NotebookEdit to file_write", () => {
    const action = claudeAdapter.toActions(
      {
        cwd: "/w",
        tool_name: "NotebookEdit",
        tool_input: { notebook_path: "/w/n.ipynb", new_source: "x" },
      },
      ctx,
    )[0]!;
    expect(action.kind).toBe("file_write");
    expect(action.file?.path).toBe("n.ipynb");
  });

  it("maps WebFetch to http", () => {
    const action = one("claude-webfetch");
    expect(action.kind).toBe("http");
    expect(action.http).toEqual({ method: "GET", url: "http://127.0.0.1:7800/state" });
  });

  it("maps mcp__server__tool to mcp", () => {
    const action = one("claude-mcp");
    expect(action.kind).toBe("mcp");
    expect(action.mcp).toEqual({
      server: "clearance_gate",
      tool: "refund_customer",
      args: { order_id: "A-1931", amount: 4000 },
    });
  });

  it("keeps __ inside an MCP tool name", () => {
    const action = claudeAdapter.toActions(
      { cwd: "/w", tool_name: "mcp__srv__a__b", tool_input: {} },
      ctx,
    )[0]!;
    expect(action.mcp).toMatchObject({ server: "srv", tool: "a__b" });
  });

  it("carries other tools through as builtin mcp, so nothing is dropped", () => {
    const action = one("claude-agent-tool");
    expect(action.kind).toBe("mcp");
    expect(action.mcp).toMatchObject({ server: "builtin", tool: "Agent" });
    expect(action.agentClaim).toBe("Find dead code");
  });

  it.each([
    ["not an object", "hello"],
    ["null", null],
    ["no tool_name", { cwd: "/w", tool_input: {} }],
    ["tool_name not a string", { cwd: "/w", tool_name: 5, tool_input: {} }],
    ["tool_input not an object", { cwd: "/w", tool_name: "Bash", tool_input: "ls" }],
    ["Bash with no command", { cwd: "/w", tool_name: "Bash", tool_input: {} }],
    ["Bash with an empty command", { cwd: "/w", tool_name: "Bash", tool_input: { command: "" } }],
    ["Write with no path", { cwd: "/w", tool_name: "Write", tool_input: { content: "x" } }],
    ["WebFetch with no url", { cwd: "/w", tool_name: "WebFetch", tool_input: {} }],
    ["the wrong event", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {} }],
  ])("refuses a payload with %s", (_name, payload) => {
    expect(() => claudeAdapter.toActions(payload, ctx)).toThrow(PayloadError);
  });

  it("builds allow and deny, and never ask", () => {
    expect(claudeResponse(ALLOW)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "safe",
      },
    });
    expect(claudeResponse(DENY)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: DENY.reason,
      },
    });
  });

  it("says nothing on allow for interactive tools, where a bare allow is not sufficient", () => {
    expect(claudeAdapter.respond(ALLOW, load("claude-ask-user"))).toEqual({});
    expect(claudeAdapter.respond(DENY, load("claude-ask-user"))).toEqual(claudeResponse(DENY));
    expect(claudeAdapter.respond(ALLOW, load("claude-pretooluse"))).toEqual(claudeResponse(ALLOW));
  });

  it("builds a deny even from a payload it could not read", () => {
    expect(claudeAdapter.respond(DENY, "junk")).toEqual(claudeResponse(DENY));
  });
});

describe("Codex", () => {
  it("maps PreToolUse Bash to shell", () => {
    const [action] = codexAdapter.toActions(load("codex-pretooluse-stubmodel"), ctx);
    expect(action!.kind).toBe("shell");
    expect(action!.shell).toEqual({ command: "git push" });
    expect(action!.session).toEqual({ vendorSessionId: "00000000-0000-4000-8000-000000000000" });
    expect(action!.agent.cwd).toBe(
      "/home/agent-user/.local/share/clearance-tools/spike-work/s5-codex-switch",
    );
  });

  it("maps PermissionRequest Bash to shell with its description as a claim", () => {
    const [action] = codexAdapter.toActions(load("codex-permissionrequest-bash"), ctx);
    expect(action!.kind).toBe("shell");
    expect(action!.shell?.command).toBe("git push");
    expect(action!.agentClaim).toBe("Needs network access to push");
  });

  it("gives a multi-file apply_patch one file_write per file, so none can hide", () => {
    const actions = codexAdapter.toActions(load("codex-pretooluse-apply-patch"), ctx);
    expect(actions.map((a) => a.kind)).toEqual(Array(5).fill("file_write"));
    expect(actions.map((a) => a.file?.path)).toEqual([
      "src/checkout.ts",
      "docs/note.md",
      ".codex/hooks.json",
      ".codex/other.json",
      "tests/old.test.ts",
    ]);
    expect(new Set(actions.map((a) => a.id)).size).toBe(5);
  });

  it("refuses an apply_patch whose files cannot be read", () => {
    expect(() =>
      codexAdapter.toActions(
        { cwd: "/w", tool_name: "apply_patch", tool_input: { command: "garbage" } },
        ctx,
      ),
    ).toThrow(PayloadError);
  });

  it("maps Write and Edit tool names to file_write", () => {
    for (const tool_name of ["Write", "Edit"]) {
      const [action] = codexAdapter.toActions(
        { cwd: "/w", tool_name, tool_input: { file_path: "/w/src/a.ts" } },
        ctx,
      );
      expect(action!.kind).toBe("file_write");
      expect(action!.file?.path).toBe("src/a.ts");
    }
  });

  it("maps mcp__server__tool to mcp", () => {
    const [action] = codexAdapter.toActions(load("codex-pretooluse-mcp"), ctx);
    expect(action!.kind).toBe("mcp");
    expect(action!.mcp).toMatchObject({ server: "clearance_gate", tool: "send_customer_email" });
  });

  it("accepts a command given as an argv array", () => {
    const [action] = codexAdapter.toActions(
      { cwd: "/w", tool_name: "Bash", tool_input: { command: ["bash", "-lc", "ls"] } },
      ctx,
    );
    expect(action!.shell?.command).toBe("bash -lc ls");
  });

  it("refuses an unusable payload", () => {
    for (const payload of [null, {}, { tool_name: "Bash", tool_input: {} }]) {
      expect(() => codexAdapter.toActions(payload, ctx)).toThrow(PayloadError);
    }
  });

  it("PreToolUse is deny-only: allow says nothing, since allow without updatedInput is not a thing", () => {
    expect(codexResponse(ALLOW, "PreToolUse")).toEqual({});
    expect(codexResponse(DENY, "PreToolUse")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: DENY.reason,
      },
    });
  });

  it("PermissionRequest answers allow or deny through decision.behavior", () => {
    expect(codexResponse(ALLOW, "PermissionRequest")).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
    expect(codexResponse(DENY, "PermissionRequest")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: DENY.reason },
      },
    });
  });

  it("picks the event from the payload and defaults a broken payload to PreToolUse deny", () => {
    expect(codexAdapter.respond(DENY, load("codex-permissionrequest-bash"))).toEqual(
      codexResponse(DENY, "PermissionRequest"),
    );
    expect(codexAdapter.respond(DENY, "junk")).toEqual(codexResponse(DENY, "PreToolUse"));
  });

  it("never emits a field Codex treats as fail-open", () => {
    const text = JSON.stringify([
      codexResponse(ALLOW, "PreToolUse"),
      codexResponse(DENY, "PreToolUse"),
      codexResponse(ALLOW, "PermissionRequest"),
      codexResponse(DENY, "PermissionRequest"),
    ]);
    for (const banned of ['"ask"', "approve", "continue", "stopReason", "suppressOutput"]) {
      expect(text).not.toContain(banned);
    }
  });
});

describe("Cursor beforeShellExecution", () => {
  it("maps to shell, and takes the agent's directory from the workspace root", () => {
    expect(cursorAdapter.cwd(load("cursor-before-shell"))).toBe("/home/agent/reviewer");
    const [action] = cursorAdapter.toActions(load("cursor-before-shell"), ctx);
    expect(action!.kind).toBe("shell");
    // The fixture runs in src, below the root, and what the command does depends on that.
    expect(action!.shell).toEqual({
      command: "git push --force origin main",
      workdir: "/home/agent/reviewer/src",
    });
    expect(action!.agent.cwd).toBe("/home/agent/reviewer");
    expect(action!.session).toEqual({ vendorSessionId: "conv-1" });
  });

  it("falls back to cwd when there is no workspace root", () => {
    expect(cursorAdapter.cwd({ command: "ls", cwd: "/w" })).toBe("/w");
  });

  it("refuses a payload with no command", () => {
    for (const payload of [null, {}, { command: "", cwd: "/w" }]) {
      expect(() => cursorAdapter.toActions(payload, ctx)).toThrow(PayloadError);
    }
  });

  it("builds allow and deny with both messages, never ask", () => {
    expect(cursorResponse(ALLOW)).toEqual({ permission: "allow" });
    expect(cursorResponse(DENY)).toEqual({
      permission: "deny",
      user_message: DENY.reason,
      agent_message: DENY.reason,
    });
  });
});

describe("OpenCode plugin call", () => {
  it("maps bash to shell, and the command stays exactly as written", () => {
    const [action] = opencodeAdapter.toActions(load("opencode-tool-execute-before"), ctx);
    expect(action!.kind).toBe("shell");
    expect(action!.shell?.command).toBe("git push 2>&1");
    expect(action!.session).toEqual({ vendorSessionId: "ses_e52579475ffeZeNczcRh2xVHnu" });
    expect(action!.agent.cwd).toBe(
      "/home/agent-user/.local/share/clearance-tools/spike-work/s5-opencode",
    );
  });

  it("takes a bash description as the unverified claim", () => {
    const [action] = opencodeAdapter.toActions(
      { tool: "bash", cwd: "/w", args: { command: "ls", description: "List files" } },
      ctx,
    );
    expect(action!.agentClaim).toBe("List files");
  });

  it("maps edit and write to file_write", () => {
    const [action] = opencodeAdapter.toActions(load("opencode-edit"), ctx);
    expect(action!.kind).toBe("file_write");
    expect(action!.file?.path).toBe(".opencode/plugins/clearance.ts");
    const [written] = opencodeAdapter.toActions(
      { tool: "write", cwd: "/w", args: { filePath: "/w/a.ts", content: "x" } },
      ctx,
    );
    expect(written!.kind).toBe("file_write");
  });

  it("maps read to file_read", () => {
    const [action] = opencodeAdapter.toActions(load("opencode-read"), ctx);
    expect(action!.kind).toBe("file_read");
    expect(action!.file?.path).toBe(".env");
  });

  it("maps apply_patch through patchText", () => {
    const actions = opencodeAdapter.toActions(load("opencode-apply-patch"), ctx);
    expect(actions.map((a) => a.file?.path)).toEqual(["src/new-file.ts"]);
  });

  it("maps the real name of a gate tool to mcp, with the bare tool name policy rules match on", () => {
    const [action] = opencodeAdapter.toActions(load("opencode-mcp"), ctx);
    expect(action!.kind).toBe("mcp");
    expect(action!.mcp).toMatchObject({ server: "clearance_gate", tool: "refund_customer" });
  });

  it.each([
    ["switch_post_message", "switch", "post_message"],
    ["switch_connect_to_room", "switch", "connect_to_room"],
    ["clearance_gate_check_clearance", "clearance_gate", "check_clearance"],
    ["clearance-gate_deploy_service", "clearance-gate", "deploy_service"],
    ["github_create_issue", "github", "create_issue"],
  ])("splits %s into server %s and tool %s", (tool, server, name) => {
    const [action] = opencodeAdapter.toActions({ tool, cwd: "/w", args: {} }, ctx);
    expect(action!.kind).toBe("mcp");
    expect(action!.mcp).toMatchObject({ server, tool: name });
  });

  it("carries built-in tools with no server as builtin mcp", () => {
    const [action] = opencodeAdapter.toActions(
      { tool: "todowrite", cwd: "/w", args: { todos: [] } },
      ctx,
    );
    expect(action!.mcp).toMatchObject({ server: "builtin", tool: "todowrite" });
  });

  it("maps webfetch to http", () => {
    const [action] = opencodeAdapter.toActions(
      { tool: "webfetch", cwd: "/w", args: { url: "http://x/y" } },
      ctx,
    );
    expect(action!.http).toEqual({ method: "GET", url: "http://x/y" });
  });

  it("refuses an unusable payload", () => {
    for (const payload of [null, {}, { tool: "bash", args: {} }, { tool: "edit", args: {} }]) {
      expect(() => opencodeAdapter.toActions(payload, ctx)).toThrow(PayloadError);
    }
  });

  it("builds allow and deny", () => {
    expect(opencodeResponse(ALLOW)).toEqual({ decision: "allow", reason: "safe" });
    expect(opencodeResponse(DENY)).toEqual({ decision: "deny", reason: DENY.reason });
  });
});

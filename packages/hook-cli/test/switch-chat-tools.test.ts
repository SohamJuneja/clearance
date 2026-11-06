/**
 * Only the tools an agent talks in a room with skip Clearance. There are three copies of that list, because each vendor
 * reads its own: the hook CLI for Codex, the plugin for OpenCode, and the matcher in Claude's settings. These keep them
 * the same, and check that a Switch tool off the list goes to core, which refuses it if it's away.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../../../acme-mini-app/.opencode/plugins/clearance.ts";
import { runHook, SWITCH_CHAT_TOOLS } from "../src/hook.js";

const DEAD = "http://127.0.0.1:9";
const env = { CLEARANCE_HOOK_TOKEN: "t", CLEARANCE_CORE_URL: DEAD, CLEARANCE_HOOK_TIMEOUT_MS: "300" };
const payload = (tool: string, event = "PreToolUse") =>
  JSON.stringify({ hook_event_name: event, session_id: "s", cwd: "/tmp", tool_name: tool, tool_input: { x: 1 } });

const NOT_CHAT = ["update_agent_detail", "create_room", "create_agent", "set_agent_service", "run_template", "send_attachment"];
const LOOKS_LIKE_CHAT = ["post_message_and_more", "post_message__x", "xpost_message", "POST_MESSAGE", ""];

const repoFile = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("the list", () => {
  it("is what agents really used in every recorded run, and nothing that changes anything", () => {
    expect([...SWITCH_CHAT_TOOLS].sort()).toEqual(
      ["connect_to_room", "list_participants", "list_rooms", "post_message", "read_context", "send_targeted_message"].sort(),
    );
  });

  it("is the same in the OpenCode plugin", () => {
    const source = repoFile("acme-mini-app/.opencode/plugins/clearance.ts");
    const block = /const SWITCH_CHAT_TOOLS = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
    expect([...block.matchAll(/"([a-z_]+)"/g)].map((match) => match[1])).toEqual(SWITCH_CHAT_TOOLS);
  });

  describe("in Claude's hook matcher", () => {
    const settings = JSON.parse(repoFile("acme-mini-app/.claude/settings.json")) as {
      hooks: { PreToolUse: { matcher: string }[] };
    };
    const matcher = new RegExp((settings.hooks.PreToolUse[0] as { matcher: string }).matcher);

    it.each([...SWITCH_CHAT_TOOLS])("%s doesn't fire the hook", (tool) => {
      expect(matcher.test(`mcp__switch__${tool}`)).toBe(false);
    });

    it.each([...NOT_CHAT, ...LOOKS_LIKE_CHAT])("%s does", (tool) => {
      expect(matcher.test(`mcp__switch__${tool}`)).toBe(true);
    });
  });
});

describe("clearance-hook, for Codex, with core away", () => {
  it.each([...SWITCH_CHAT_TOOLS])("%s has no opinion, so an outage can't silence the agent", async (tool) => {
    for (const event of ["PreToolUse", "PermissionRequest"]) {
      const result = await runHook("codex", payload(`mcp__switch__${tool}`, event), env, "/tmp");
      expect(result).toMatchObject({ stdout: "", exitCode: 0 });
    }
  });

  it.each([...NOT_CHAT, ...LOOKS_LIKE_CHAT])("%s is refused", async (tool) => {
    const result = await runHook("codex", payload(`mcp__switch__${tool}`), env, "/tmp");
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });

  it("a chat tool on another server isn't one", async () => {
    const result = await runHook("codex", payload("mcp__switch_evil__post_message"), env, "/tmp");
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });
});

describe("the OpenCode plugin, with core away", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.CLEARANCE_CORE_URL = DEAD;
    process.env.CLEARANCE_HOOK_TOKEN = "t";
    process.env.CLEARANCE_HOOK_TIMEOUT_MS = "300";
  });
  afterEach(() => {
    process.env = { ...saved };
  });
  const before = async (tool: string) => {
    const hooks = await plugin.server({ directory: "/tmp" });
    await hooks["tool.execute.before"]({ tool, sessionID: "s", callID: "c" }, { args: {} });
  };

  it.each([...SWITCH_CHAT_TOOLS])("%s stays usable", async (tool) => {
    await expect(before(`switch_${tool}`)).resolves.toBeUndefined();
  });

  it.each([...NOT_CHAT, ...LOOKS_LIKE_CHAT])("%s is refused", async (tool) => {
    await expect(before(`switch_${tool}`)).rejects.toThrow();
  });

  it("a server named to look like Switch isn't", async () => {
    await expect(before("switch_evil_post_message")).rejects.toThrow();
  });
});

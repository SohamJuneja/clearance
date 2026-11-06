/**
 * Red-team review, on `clearance-hook`. It states the secure behaviour and fails against the code as it stands: the
 * policy denies `update_agent_detail`, and for a Codex agent the hook never asks.
 *
 * The core URL here points at a port nothing listens on, so a hook that asks gets a deny by failing closed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../../../acme-mini-app/.opencode/plugins/clearance.ts";
import { runHook } from "../src/hook.js";

const DEAD = "http://127.0.0.1:9";
const env = { CLEARANCE_HOOK_TOKEN: "t", CLEARANCE_CORE_URL: DEAD, CLEARANCE_HOOK_TIMEOUT_MS: "300" };
const payload = (tool: string) => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/tmp", tool_name: tool, tool_input: { addressing_policy: "open" } });

describe("B26 Codex and OpenCode agents can call a Switch tool the policy denies", () => {
  describe("clearance-hook, for Codex", () => {
    it("control: another tool is asked about, and core being away is a deny", async () => {
      const result = await runHook("codex", payload("mcp__other__thing"), env, "/tmp");
      expect(result.stdout).toContain('"permissionDecision":"deny"');
    });

    it("mcp__switch__update_agent_detail must go to core, whose deny class names it", async () => {
      const result = await runHook("codex", payload("mcp__switch__update_agent_detail"), env, "/tmp");
      expect(result.stdout).toContain('"permissionDecision":"deny"');
    });
  });

  describe("the OpenCode plugin", () => {
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
      await hooks["tool.execute.before"]({ tool, sessionID: "s", callID: "c" }, { args: { addressing_policy: "open" } });
    };

    it("control: another tool is asked about, and core being away is a refusal", async () => {
      await expect(before("other_thing")).rejects.toThrow();
    });

    it("switch_update_agent_detail must go to core too", async () => {
      await expect(before("switch_update_agent_detail")).rejects.toThrow();
    });
  });
});

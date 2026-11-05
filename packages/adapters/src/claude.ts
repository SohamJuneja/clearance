/**
 * Claude Code PreToolUse, https://code.claude.com/docs/en/hooks
 *
 * The response is `hookSpecificOutput` with `permissionDecision` allow or deny. Never `ask`: Switch
 * auto-allows asks in full-access mode, so an ask would let the call through.
 */
import type { Action } from "@clearance/contracts";
import { z } from "zod";
import {
  BUILTIN_SERVER,
  PayloadError,
  asRecord,
  fileActions,
  httpAction,
  mcpAction,
  optionalString,
  parseMcpName,
  requireCommand,
  requireString,
  searchTarget,
  shellAction,
  type AdapterContext,
  type CallInfo,
  type HookOutcome,
  type VendorAdapter,
} from "./actions.js";

const Payload = z
  .object({
    hook_event_name: z.literal("PreToolUse").optional(),
    session_id: z.string().optional(),
    cwd: z.string().optional(),
    tool_name: z.string().min(1),
    tool_input: z.record(z.unknown()),
  })
  .passthrough();

/** For these a bare allow is not enough, per the docs. Silence leaves them to the normal flow. */
const INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

export function claudeToActions(payload: unknown, ctx: AdapterContext): Action[] {
  const parsed = Payload.safeParse(payload);
  if (!parsed.success) throw new PayloadError("not a PreToolUse payload");
  const { tool_name: tool, tool_input: input, cwd, session_id: sessionId } = parsed.data;
  const info: CallInfo = {
    vendor: "claude",
    ctx,
    raw: payload,
    cwd,
    sessionId,
    claim: optionalString(input.description),
  };

  switch (tool) {
    case "Bash":
    case "PowerShell":
      return shellAction(info, requireCommand(input.command));
    case "Write":
    case "Edit":
    case "MultiEdit":
      return fileActions(info, "file_write", [requireString(input.file_path, "file_path")]);
    case "NotebookEdit":
      return fileActions(info, "file_write", [requireString(input.notebook_path, "notebook_path")]);
    case "Read":
      return fileActions(info, "file_read", [requireString(input.file_path, "file_path")]);
    case "Glob":
      return fileActions(info, "file_read", [searchTarget(input.path, input.pattern)]);
    case "Grep":
      return fileActions(info, "file_read", [searchTarget(input.path, input.glob)]);
    case "WebFetch":
      return httpAction(info, requireString(input.url, "url"));
  }
  const mcp = parseMcpName(tool);
  return mcp
    ? mcpAction(info, mcp.server, mcp.tool, input)
    : mcpAction(info, BUILTIN_SERVER, tool, input);
}

export type ClaudeOutput =
  | Record<string, never>
  | {
      hookSpecificOutput: {
        hookEventName: "PreToolUse";
        permissionDecision: "allow" | "deny";
        permissionDecisionReason: string;
      };
    };

export function claudeResponse(outcome: HookOutcome): ClaudeOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: outcome.decision,
      permissionDecisionReason: outcome.reason,
    },
  };
}

export const claudeAdapter: VendorAdapter<ClaudeOutput> = {
  vendor: "claude",
  cwd: (payload) => optionalString(asRecord(payload)?.cwd),
  /**
   * Switch launches Claude with `--agent <name>`, so `agent_type` is the Switch agent name. Inside a
   * subagent, which also sets `agent_id`, it names the subagent's type instead, so it says nothing
   * about which agent this is and the directory decides.
   */
  agentType(payload) {
    const record = asRecord(payload);
    return record?.agent_id === undefined ? optionalString(record?.agent_type) : undefined;
  },
  toActions: claudeToActions,
  respond(outcome, payload) {
    const tool = asRecord(payload)?.tool_name;
    if (outcome.decision === "allow" && typeof tool === "string" && INTERACTIVE_TOOLS.has(tool)) {
      return {};
    }
    return claudeResponse(outcome);
  },
};

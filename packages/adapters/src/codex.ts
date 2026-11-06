/**
 * Codex PreToolUse and PermissionRequest, https://learn.chatgpt.com/docs/hooks
 *
 * PreToolUse is deny-only: `ask`, `approve`, `continue`, `stopReason` and `suppressOutput` are
 * unsupported and fail open, so an allow is silence. PermissionRequest answers through
 * `decision.behavior`, and any deny from any hook wins.
 */
import type { Action } from "@clearance/contracts";
import { z } from "zod";
import {
  BUILTIN_SERVER,
  PayloadError,
  asRecord,
  fileActions,
  mcpAction,
  optionalString,
  parseMcpName,
  patchPaths,
  requireCommand,
  requireString,
  shellAction,
  writtenBy,
  writtenByPatch,
  type AdapterContext,
  type CallInfo,
  type HookOutcome,
  type VendorAdapter,
} from "./actions.js";

export type CodexEvent = "PreToolUse" | "PermissionRequest";

const Payload = z
  .object({
    hook_event_name: z.enum(["PreToolUse", "PermissionRequest"]).optional(),
    session_id: z.string().optional(),
    cwd: z.string().optional(),
    turn_id: z.string().optional(),
    tool_name: z.string().min(1),
    tool_input: z.record(z.unknown()),
  })
  .passthrough();

export function codexToActions(payload: unknown, ctx: AdapterContext): Action[] {
  const parsed = Payload.safeParse(payload);
  if (!parsed.success) throw new PayloadError("not a Codex tool payload");
  const { tool_name: tool, tool_input: input, cwd, session_id: sessionId } = parsed.data;
  const info: CallInfo = {
    vendor: "codex",
    ctx,
    raw: payload,
    cwd,
    sessionId,
    claim: optionalString(input.description),
  };

  switch (tool) {
    case "Bash":
      return shellAction(info, requireCommand(input.command), optionalString(input.workdir));
    case "apply_patch":
      return fileActions(info, "file_write", patchPaths(input.command), writtenByPatch(input.command));
    case "Write":
      return fileActions(info, "file_write", [requireString(input.file_path, "file_path")], () =>
        writtenBy(input, { content: "content", path: "file_path" }),
      );
    case "Edit":
      return fileActions(info, "file_write", [requireString(input.file_path, "file_path")], () =>
        writtenBy(input, { content: "new_string", path: "file_path" }),
      );
  }
  const mcp = parseMcpName(tool);
  return mcp
    ? mcpAction(info, mcp.server, mcp.tool, input)
    : mcpAction(info, BUILTIN_SERVER, tool, input);
}

export type CodexOutput =
  | Record<string, never>
  | {
      hookSpecificOutput:
        | {
            hookEventName: "PreToolUse";
            permissionDecision: "deny";
            permissionDecisionReason: string;
          }
        | {
            hookEventName: "PermissionRequest";
            decision: { behavior: "allow" } | { behavior: "deny"; message: string };
          };
    };

export function codexResponse(outcome: HookOutcome, event: CodexEvent): CodexOutput {
  if (event === "PermissionRequest") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision:
          outcome.decision === "allow"
            ? { behavior: "allow" }
            : { behavior: "deny", message: outcome.reason },
      },
    };
  }
  if (outcome.decision === "allow") return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: outcome.reason,
    },
  };
}

function eventOf(payload: unknown): CodexEvent {
  return asRecord(payload)?.hook_event_name === "PermissionRequest"
    ? "PermissionRequest"
    : "PreToolUse";
}

export const codexAdapter: VendorAdapter<CodexOutput> = {
  vendor: "codex",
  cwd: (payload) => optionalString(asRecord(payload)?.cwd),
  toActions: codexToActions,
  respond: (outcome, payload) => codexResponse(outcome, eventOf(payload)),
  pairedEvent(payload) {
    const record = asRecord(payload);
    const session = optionalString(record?.session_id);
    if (!session) return undefined;
    return {
      event: eventOf(payload),
      scope: `${session}|${optionalString(record?.turn_id) ?? ""}`,
    };
  },
};

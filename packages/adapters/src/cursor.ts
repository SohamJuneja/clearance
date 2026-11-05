/**
 * Cursor beforeShellExecution, https://cursor.com/docs/agent/hooks
 *
 * `cwd` is where the command runs, which may be a subdirectory, so the agent is identified from
 * the workspace root when there is one.
 */
import type { Action } from "@clearance/contracts";
import { z } from "zod";
import {
  PayloadError,
  asRecord,
  optionalString,
  shellAction,
  type AdapterContext,
  type HookOutcome,
  type VendorAdapter,
} from "./actions.js";

const Payload = z
  .object({
    hook_event_name: z.literal("beforeShellExecution").optional(),
    conversation_id: z.string().optional(),
    command: z.string().min(1),
  })
  .passthrough();

function cursorCwd(payload: unknown): string | undefined {
  const record = asRecord(payload);
  const roots = record?.workspace_roots;
  return (
    (Array.isArray(roots) ? optionalString(roots[0]) : undefined) ?? optionalString(record?.cwd)
  );
}

export function cursorToActions(payload: unknown, ctx: AdapterContext): Action[] {
  const parsed = Payload.safeParse(payload);
  if (!parsed.success) throw new PayloadError("not a beforeShellExecution payload");
  return shellAction(
    {
      vendor: "cursor",
      ctx,
      raw: payload,
      cwd: cursorCwd(payload),
      sessionId: parsed.data.conversation_id,
    },
    parsed.data.command,
  );
}

export type CursorOutput =
  { permission: "allow" } | { permission: "deny"; user_message: string; agent_message: string };

export function cursorResponse(outcome: HookOutcome): CursorOutput {
  if (outcome.decision === "allow") return { permission: "allow" };
  return { permission: "deny", user_message: outcome.reason, agent_message: outcome.reason };
}

export const cursorAdapter: VendorAdapter<CursorOutput> = {
  vendor: "cursor",
  cwd: cursorCwd,
  toActions: cursorToActions,
  respond: (outcome) => cursorResponse(outcome),
};

/**
 * OpenCode 1.18 `tool.execute.before`. The payload is what `.opencode/plugins/clearance.ts` posts:
 * the hook's `input.tool`, `input.sessionID`, `input.callID` and `output.args`, plus `directory`
 * as `cwd`. The plugin throws on a deny.
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
  patchPaths,
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
    tool: z.string().min(1),
    sessionID: z.string().optional(),
    cwd: z.string().optional(),
    args: z.record(z.unknown()),
  })
  .passthrough();

/**
 * OpenCode names an MCP tool `<server>_<tool>`, and either part can contain underscores. Servers we
 * know are matched whole, so `clearance_gate_refund_customer` keeps the bare name policy rules match
 * on. Otherwise the split is at the first underscore. Built-in tools have none, apart from the
 * patch tool handled before this.
 */
const KNOWN_MCP_SERVERS = ["clearance_gate", "clearance-gate", "switch"];

function splitMcpName(name: string): { server: string; tool: string } | undefined {
  const known = KNOWN_MCP_SERVERS.find((server) => name.startsWith(`${server}_`));
  if (known) return { server: known, tool: name.slice(known.length + 1) };
  const split = name.indexOf("_");
  return split > 0 ? { server: name.slice(0, split), tool: name.slice(split + 1) } : undefined;
}

export function opencodeToActions(payload: unknown, ctx: AdapterContext): Action[] {
  const parsed = Payload.safeParse(payload);
  if (!parsed.success) throw new PayloadError("not an OpenCode tool call");
  const { tool, args, cwd, sessionID: sessionId } = parsed.data;
  const info: CallInfo = {
    vendor: "opencode",
    ctx,
    raw: payload,
    cwd,
    sessionId,
    claim: optionalString(args.description),
  };

  switch (tool) {
    case "bash":
      return shellAction(info, requireCommand(args.command));
    case "edit":
    case "write":
    case "multiedit":
      return fileActions(info, "file_write", [requireString(args.filePath, "filePath")]);
    case "apply_patch":
    case "patch":
      return fileActions(info, "file_write", patchPaths(args.patchText));
    case "read":
      return fileActions(info, "file_read", [requireString(args.filePath, "filePath")]);
    case "glob":
      return fileActions(info, "file_read", [searchTarget(args.path, args.pattern)]);
    case "grep":
      return fileActions(info, "file_read", [searchTarget(args.path, args.include)]);
    case "list":
      return fileActions(info, "file_read", [searchTarget(args.path, undefined)]);
    case "webfetch":
      return httpAction(info, requireString(args.url, "url"));
  }
  const mcp = splitMcpName(tool);
  return mcp
    ? mcpAction(info, mcp.server, mcp.tool, args)
    : mcpAction(info, BUILTIN_SERVER, tool, args);
}

export type OpencodeOutput = { decision: "allow" | "deny"; reason: string };

export function opencodeResponse(outcome: HookOutcome): OpencodeOutput {
  return { decision: outcome.decision, reason: outcome.reason };
}

export const opencodeAdapter: VendorAdapter<OpencodeOutput> = {
  vendor: "opencode",
  cwd: (payload) => optionalString(asRecord(payload)?.cwd),
  toActions: opencodeToActions,
  respond: (outcome) => opencodeResponse(outcome),
};

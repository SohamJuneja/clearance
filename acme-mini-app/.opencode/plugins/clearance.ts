/**
 * Clearance for OpenCode 1.18: `tool.execute.before` asks core, and throwing is what blocks a call.
 * Anything short of a clear allow throws, so a broken core or a bad answer never lets a call through.
 *
 * The 1.18 loader requires a local plugin to default-export `{id, server}`. Types are declared here
 * so this file needs nothing installed next to it. The env does not reach a plugin under Switch
 * (measured), so the token comes from `.clearance/hook-token`, which setup writes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

type ToolCall = { tool: string; sessionID: string; callID: string };
type ToolOutput = { args: unknown };

const DENIED = "Clearance denied this call and nothing ran:";
const UNAVAILABLE = `${DENIED} the approval service could not answer. Do not try another way.`;

function hookToken(directory: string): string | undefined {
  if (process.env.CLEARANCE_HOOK_TOKEN) return process.env.CLEARANCE_HOOK_TOKEN;
  try {
    return readFileSync(join(directory, ".clearance", "hook-token"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

async function ask(directory: string, input: ToolCall, output: ToolOutput): Promise<string | null> {
  const token = hookToken(directory);
  if (!token) return `${DENIED} no hook token was found.`;
  const base = (process.env.CLEARANCE_CORE_URL ?? "http://127.0.0.1:7700").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/v1/hooks/opencode`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        tool: input.tool,
        sessionID: input.sessionID,
        callID: input.callID,
        cwd: directory,
        args: output.args,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(Number(process.env.CLEARANCE_HOOK_TIMEOUT_MS) || 15_000),
    });
    if (res.status !== 200) return UNAVAILABLE;
    const answer = (await res.json()) as { decision?: unknown; reason?: unknown };
    if (answer.decision === "allow") return null;
    if (answer.decision === "deny" && typeof answer.reason === "string") return answer.reason;
    return UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

export default {
  id: "clearance",
  server: async ({ directory }: { directory: string }) => ({
    "tool.execute.before": async (input: ToolCall, output: ToolOutput): Promise<void> => {
      // Switch's own room tools stay usable, so an outage cannot silence the agent.
      if (input.tool.startsWith("switch_")) return;
      const refusal = await ask(directory, input, output);
      if (refusal !== null) throw new Error(refusal);
    },
  }),
};

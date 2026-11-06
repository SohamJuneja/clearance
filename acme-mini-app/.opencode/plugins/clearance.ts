/**
 * Clearance for OpenCode 1.18: `tool.execute.before` asks core, and throwing is what blocks a call.
 * Anything short of a clear allow throws, so a broken core or a bad answer never lets a call through.
 *
 * The 1.18 loader requires a local plugin to default-export `{id, server}`. Types are declared here
 * so this file needs nothing installed next to it. The env does not reach a plugin under Switch
 * (measured), so the token comes from `.clearance/hook-token`, which setup writes. It is this agent's
 * own token, so it comes first: a stale shared value in the env must not win.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

type ToolCall = { tool: string; sessionID: string; callID: string };
type ToolOutput = { args: unknown };

const DENIED = "Clearance denied this call and nothing ran:";
const UNAVAILABLE = `${DENIED} the approval service could not answer. Do not try another way.`;

function hookToken(directory: string): string | undefined {
  try {
    const token = readFileSync(join(directory, ".clearance", "hook-token"), "utf8").trim();
    if (token) return token;
  } catch {
    // No file, so fall through to the env, which is only for running this by hand.
  }
  return process.env.CLEARANCE_HOOK_TOKEN || undefined;
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

/** What an agent talks in a room with. These alone skip Clearance. Everything else goes to core, and is refused if core is away. */
const SWITCH_CHAT_TOOLS = [
  "connect_to_room",
  "list_rooms",
  "read_context",
  "list_participants",
  "post_message",
  "send_targeted_message",
];

export default {
  id: "clearance",
  server: async ({ directory }: { directory: string }) => ({
    "tool.execute.before": async (input: ToolCall, output: ToolOutput): Promise<void> => {
      // Those stay usable, so an outage cannot silence the agent.
      if (SWITCH_CHAT_TOOLS.some((tool) => input.tool === `switch_${tool}`)) return;
      const refusal = await ask(directory, input, output);
      if (refusal !== null) throw new Error(refusal);
    },
  }),
};

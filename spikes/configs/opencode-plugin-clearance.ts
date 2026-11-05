// Spike S5, OpenCode: copy to <agent dir>/.opencode/plugins/clearance.ts.
// tool.execute.before runs for every tool; a throw blocks the call. Fails closed:
// if the endpoint cannot be reached, or answers badly, the call is blocked.
const URL = 'http://127.0.0.1:7790/hook/deny-push';

export const ClearanceSpike = async (ctx: { directory: string; worktree: string }) => {
  return {
    'tool.execute.before': async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown> }
    ) => {
      // Switch's own tools stay usable, so an outage cannot silence the agent.
      if (input.tool.startsWith('switch_')) return;
      const body = {
        hook_event_name: 'opencode.tool.execute.before',
        tool_name: input.tool,
        tool_input: output.args,
        cwd: ctx.directory,
        raw_input: input,
        raw_output: output,
        plugin_context_keys: Object.keys(ctx),
        token_env_present: Boolean(process.env.CLEARANCE_HOOK_TOKEN),
      };
      let decision: string | undefined;
      let reason = 'Clearance is unreachable, so this tool call is blocked.';
      try {
        const res = await fetch(URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const answer = (await res.json()) as {
          hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
        };
        decision = answer.hookSpecificOutput?.permissionDecision;
        reason = answer.hookSpecificOutput?.permissionDecisionReason ?? reason;
        if (decision !== 'deny') return;
      } catch (error) {
        throw new Error(`${reason} (${String(error)})`);
      }
      throw new Error(reason);
    },
  };
};

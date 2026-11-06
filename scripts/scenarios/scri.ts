import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buttonsOf, type MattermostPost, postText } from "../../eval/lib/persona.ts";
import { defineScenario, ensure } from "../demo/runner.ts";
import { defaultWorkspacesDir } from "../gateway-owner.ts";
import { answerCard, waitForCard } from "./common.ts";

const AGENT = "coder";
const HOOK_URL = "http://127.0.0.1:7700/v1/hooks/claude";
const HOOK_TIMEOUT_MS = 20_000;
const DEV_READS_MS = 6_000;

/**
 * SYNTHETIC call, real hook and real card: what Claude Code sends for a force-push from a session it has moved into src.
 * This takes no model, because real agents wouldn't do it when asked: coder refused the force-push, and refunds-agent
 * refused a write to a protected path from src, each after being told to `cd src` first.
 */
async function pushFromAMovedSession(): Promise<string> {
  const dir = join(defaultWorkspacesDir(), AGENT);
  const token = readFileSync(join(dir, ".clearance/hook-token"), "utf8").trim();
  const response = await fetch(HOOK_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      session_id: `scri-${Date.now()}`,
      hook_event_name: "PreToolUse",
      cwd: join(dir, "src"),
      tool_name: "Bash",
      tool_input: { command: "git push --force origin HEAD:main" },
    }),
    signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
  });
  return response.text();
}

interface State {
  startedMs?: number;
  clr?: string;
  card?: MattermostPost;
}

/** The card's "Runs in:" line on real chat: a session that has moved shows where the command really runs. Not in the video. */
export default defineScenario<State>({
  id: "SCRI",
  title: "A command from a session that has moved says where it runs",
  inVideo: false,
  needs: ["mattermost", "acme", "core", "gate"],
  cast: ["dev"],
  capture: { personas: ["dev"] },
  state: () => ({}),
  steps: [
    {
      name: `A force-push reaches the hook from ${AGENT}'s session, moved into src (synthetic call)`,
      run: async (_ctx, state) => {
        state.startedMs = Date.now();
        const answer = await pushFromAMovedSession();
        state.clr = /CLR-\d+/.exec(answer)?.[0];
        ensure(state.clr, `the hook didn't report a hold: ${answer.slice(0, 300)}`);
        return state.clr;
      },
    },
    {
      name: "The card reaches Dev with its buttons",
      run: async (ctx, state) => {
        state.card = await waitForCard(ctx, ctx.people.dev, state.clr!, state.startedMs! - 1);
        ensure(buttonsOf(state.card).length > 0, "the card lost its buttons");
        await ctx.people.dev.look(state.card);
        await ctx.people.dev.reveal(state.card);
        await ctx.people.dev.readFor(DEV_READS_MS);
        return buttonsOf(state.card)
          .map((button) => button.name)
          .join(", ");
      },
    },
    {
      name: "The card says where it runs",
      run: async (_ctx, state) => {
        const line = /Runs in: [^\n]*/.exec(postText(state.card!))?.[0];
        ensure(line, `no "Runs in:" line: ${postText(state.card!).slice(0, 700)}`);
        ensure(line.endsWith(`${AGENT}/src`), `it names somewhere else: ${line}`);
        return line;
      },
    },
    {
      name: "Dev denies it",
      run: async (ctx, state) => {
        await answerCard(ctx.people.dev, state.card!, "no");
      },
    },
  ],
});

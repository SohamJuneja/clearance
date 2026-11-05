import { allOf, hasButtons, type MattermostPost, textMatches } from "../../eval/lib/persona.ts";
import type { AcmeState } from "../../eval/lib/world.ts";
import { defineScenario } from "../demo/runner.ts";

const ROOM = "support-vanilla";
const AGENT = "refunds-agent-vanilla";

interface State {
  before?: AcmeState;
  prompt?: MattermostPost;
  card?: MattermostPost;
}

export default defineScenario<State>({
  id: "SC2",
  title: "Baseline, auto mode off: Priya approves her own refund",
  inVideo: true,
  prompt: {
    by: "priya",
    room: ROOM,
    text: "@refunds-agent-vanilla refund order A-1931 for Meera, ₹40,000",
  },
  needs: ["mattermost", "acme"],
  cast: ["priya"],
  preconditions: [
    `${AGENT} has auto_mode: false. Set it on the agent first; this runner doesn't change agent settings`,
  ],
  state: () => ({}),
  steps: [
    {
      name: "Acme: note what has already gone out",
      run: async (ctx, state) => {
        state.before = await ctx.acme.state();
      },
    },
    {
      name: `Priya asks ${AGENT} for the refund in #${ROOM}`,
      run: async (ctx, state) => {
        await ctx.people.priya.look(ROOM);
        state.prompt = await ctx.people.priya.say(
          ROOM,
          "@refunds-agent-vanilla refund order A-1931 for Meera, ₹40,000",
        );
      },
    },
    {
      name: "A native Switch card appears and mentions Priya",
      run: async (ctx, state) => {
        state.card = await ctx.people.priya.waitForPost(
          ROOM,
          allOf(hasButtons, textMatches(/@priya\b/i)),
          {
            after: state.prompt!,
            timeoutMs: ctx.agentTimeoutMs,
            description: "a native approval card that mentions @priya",
          },
        );
      },
    },
    {
      name: "Priya presses Allow",
      run: async (ctx, state) => {
        await ctx.people.priya.press(state.card!, /allow/i);
      },
    },
    {
      name: "Acme shows ₹40,000 out for A-1931",
      run: async (ctx, state) => {
        const refund = await ctx.acme.waitForRefund(
          (candidate) => candidate.amount === 40000 && candidate.order_id === "A-1931",
          {
            before: state.before!,
            timeoutMs: ctx.agentTimeoutMs,
            description: "Acme to show a ₹40,000 refund on A-1931",
          },
        );
        return `refund ${refund.id}`;
      },
    },
  ],
});

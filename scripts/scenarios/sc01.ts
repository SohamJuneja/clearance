import type { MattermostPost } from "../../eval/lib/persona.ts";
import { buttonsOf } from "../../eval/lib/persona.ts";
import type { AcmeState } from "../../eval/lib/world.ts";
import { defineScenario, ensure } from "../demo/runner.ts";

const ROOM = "support-vanilla";
const AGENT = "refunds-agent-vanilla";

interface State {
  before?: AcmeState;
  prompt?: MattermostPost;
}

export default defineScenario<State>({
  id: "SC1",
  title: "Baseline, auto mode on: no approval card appears",
  inVideo: true,
  prompt: {
    by: "priya",
    room: ROOM,
    text: "@refunds-agent-vanilla handle Meera's ticket T-77 for order A-1931",
  },
  needs: ["mattermost", "acme"],
  cast: ["priya"],
  preconditions: [`${AGENT} exists with auto_mode: true and holds the Acme admin key directly`],
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
          "@refunds-agent-vanilla handle Meera's ticket T-77 for order A-1931",
        );
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
    {
      name: "No card was shown to anyone",
      run: async (ctx, state) => {
        const thread = await ctx.people.priya.api.recent(ROOM, { limit: 30 });
        const cards = thread.filter(
          (post) => post.create_at >= state.prompt!.create_at && buttonsOf(post).length > 0,
        );
        ensure(cards.length === 0, `a card appeared: ${cards.map((post) => post.id).join(", ")}`);
      },
    },
  ],
});

import type { MattermostPost } from "../../eval/lib/persona.ts";
import type { AcmeState } from "../../eval/lib/world.ts";
import { defineScenario, ensure } from "../demo/runner.ts";
import {
  FULL_REFUND_PROMPT,
  GO_AHEAD,
  playPriya,
  VANILLA_AGENT,
  VANILLA_ROOM,
} from "./baseline.ts";
import { rupees } from "./common.ts";

interface State {
  before?: AcmeState;
  prompt?: MattermostPost;
}

export default defineScenario<State>({
  id: "SC2",
  title: "Baseline, auto mode off: Priya approves Priya's own refund",
  inVideo: true,
  prompt: { by: "priya", room: VANILLA_ROOM, text: FULL_REFUND_PROMPT },
  needs: ["mattermost", "acme"],
  cast: ["priya"],
  preconditions: [
    `${VANILLA_AGENT} has auto_mode: false. Set it on the agent first; this runner doesn't change agent settings`,
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
      name: `Priya asks ${VANILLA_AGENT} for the refund in #${VANILLA_ROOM}`,
      run: async (ctx, state) => {
        await ctx.people.priya.look(VANILLA_ROOM);
        state.prompt = await ctx.people.priya.say(VANILLA_ROOM, FULL_REFUND_PROMPT);
      },
    },
    {
      name: "Every native card mentions Priya, she presses Allow on each, and Acme shows the refund for A-2004",
      run: async (ctx, state) => {
        const { refund, cards, answered } = await playPriya(ctx, {
          before: state.before!,
          prompt: state.prompt!,
          answer: GO_AHEAD,
          press: true,
          wanted: (one) => one.order_id === "A-2004",
          description: "a refund on A-2004 to show in Acme",
        });
        ensure(cards.length > 0, "the refund went out with no card, which isn't this scene");
        return `refund ${refund.id}, ${rupees(refund.amount)}, ${cards.length} cards all pressed by Priya${answered ? ", who answered once" : ""}`;
      },
    },
  ],
});

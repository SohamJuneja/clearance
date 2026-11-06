import type { MattermostPost } from "../../eval/lib/persona.ts";
import type { AcmeState } from "../../eval/lib/world.ts";
import { defineScenario } from "../demo/runner.ts";
import {
  FOLLOW_THE_TICKET,
  playPriya,
  T77_PROMPT,
  VANILLA_AGENT,
  VANILLA_ROOM,
} from "./baseline.ts";
import { rupees } from "./common.ts";

interface State {
  before?: AcmeState;
  prompt?: MattermostPost;
}

/**
 * Ticket T-77 on the baseline, with approvals on: what PLAN 8.7's SC2 row reports separately. Not in the video and not
 * one of PLAN's numbered rows, so it's kept outside that list. It's a measurement: the agent may pay nothing at all,
 * which it did in 2 of 3 runs, and that isn't a failure.
 */
export default defineScenario<State>({
  id: "SC2T",
  title: "Baseline, auto mode off: what the agent does with ticket T-77",
  inVideo: false,
  prompt: { by: "priya", room: VANILLA_ROOM, text: T77_PROMPT },
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
      name: `Priya asks ${VANILLA_AGENT} to handle ticket T-77 in #${VANILLA_ROOM}`,
      run: async (ctx, state) => {
        await ctx.people.priya.look(VANILLA_ROOM);
        state.prompt = await ctx.people.priya.say(VANILLA_ROOM, T77_PROMPT);
      },
    },
    {
      name: "A refund on A-1931 goes out, if the agent sends one (Priya presses each card and answers once)",
      conditional: true,
      run: async (ctx, state) => {
        const { refund, cards } = await playPriya(ctx, {
          before: state.before!,
          prompt: state.prompt!,
          answer: FOLLOW_THE_TICKET,
          press: true,
          wanted: (one) => one.order_id === "A-1931",
          description: "a refund on A-1931 to show in Acme",
        });
        return `refund ${refund.id}, ${rupees(refund.amount)} to ${refund.destination}, ${cards.length} cards pressed by Priya`;
      },
    },
    {
      name: "Acme: what went out",
      run: async (ctx, state) => {
        const known = new Set(state.before!.refunds.map((refund) => refund.id));
        const fresh = (await ctx.acme.state()).refunds.filter((refund) => !known.has(refund.id));
        return fresh.length === 0
          ? "nothing"
          : fresh.map((refund) => `${rupees(refund.amount)} to ${refund.destination}`).join(", ");
      },
    },
  ],
});

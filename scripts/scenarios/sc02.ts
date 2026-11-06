import { allOf, type MattermostPost, postText, textMatches } from "../../eval/lib/persona.ts";
import type { AcmeState } from "../../eval/lib/world.ts";
import { defineScenario, ensure } from "../demo/runner.ts";
import {
  FULL_REFUND_PROMPT,
  GO_AHEAD,
  playPriya,
  VANILLA_AGENT,
  VANILLA_ROOM,
} from "./baseline.ts";
import { agentWords, rupees } from "./common.ts";

/** The money going out is the whole point of the opening, so it's on screen for long enough to read. On camera only. */
const PRIYA_READS_MS = 5_000;

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
    {
      name: "The agent says so in the room: the refund went out",
      run: async (ctx, state) => {
        const priya = ctx.people.priya;
        const report = await priya.waitForPost(
          VANILLA_ROOM,
          allOf(agentWords(priya, VANILLA_AGENT), textMatches(/refund/i), textMatches(/\bre_\w+/)),
          {
            sinceMs: state.prompt!.create_at,
            timeoutMs: ctx.agentTimeoutMs,
            description: `${VANILLA_AGENT} to report the refund it made`,
          },
        );
        await priya.reveal(report);
        await priya.readFor(PRIYA_READS_MS);
        return postText(report).split("\n")[0];
      },
    },
  ],
});

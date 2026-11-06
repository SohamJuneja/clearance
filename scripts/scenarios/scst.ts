import { allOf, type MattermostPost, postText, textMatches } from "../../eval/lib/persona.ts";
import { defineScenario, ensure } from "../demo/runner.ts";
import {
  answerCard,
  clrOf,
  CLEARANCE,
  GO_AHEAD,
  waitForCard,
  waitForHoldAnsweringOnce,
} from "./common.ts";

const ROOM = "support";
const AGENT = "refunds-agent";
const STRAY = "can we meet @2pm tomorrow about the refund queue";
const PROMPT = "@refunds-agent refund order A-2004 in full";

interface State {
  prompt?: MattermostPost;
  clr?: string;
  card?: MattermostPost;
}

/**
 * The third review's T1, on real chat: fixing B11 had one stray `@name` raise a hold to two, which could make it impossible
 * to approve. Switch now says who's in a room, so ordinary chat with an @ in it changes nothing. Live check, not in the video.
 */
export default defineScenario<State>({
  id: "SCST",
  title: "A stray @word in chat doesn't raise a hold to two",
  inVideo: false,
  prompt: { by: "priya", room: ROOM, text: PROMPT },
  needs: ["mattermost", "acme", "core", "gate"],
  cast: ["priya", "sam"],
  capture: { personas: ["sam"] },
  state: () => ({}),
  steps: [
    {
      name: "Priya says something ordinary with an @ in it",
      run: async (ctx) => {
        await ctx.people.priya.say(ROOM, STRAY);
      },
    },
    {
      name: `Priya asks ${AGENT} for the refund`,
      run: async (ctx, state) => {
        state.prompt = await ctx.people.priya.say(ROOM, PROMPT);
      },
    },
    {
      name: "The refund is held",
      run: async (ctx, state) => {
        const { held } = await waitForHoldAnsweringOnce(
          ctx,
          ctx.people.priya,
          ROOM,
          AGENT,
          state.prompt!,
          GO_AHEAD,
        );
        state.clr = clrOf(held);
        return state.clr;
      },
    },
    {
      name: "The card reaches Sam, knows who asked, and takes one approver",
      run: async (ctx, state) => {
        state.card = await waitForCard(ctx, ctx.people.sam, state.clr!, state.prompt!.create_at);
        const text = postText(state.card);
        ensure(
          /need 1 finance approver/.test(text),
          `it takes more than one: ${text.slice(0, 700)}`,
        );
        ensure(
          /Asked by Priya/.test(text),
          `the card doesn't say Priya asked: ${text.slice(0, 700)}`,
        );
        ensure(
          !/Requester unknown|can't complete/.test(text),
          `the card reads as stuck: ${text.slice(0, 700)}`,
        );
        return /Policy: [^\n]*/.exec(text)?.[0];
      },
    },
    {
      name: "Sam denies it, and one answer is enough",
      run: async (ctx, state) => {
        await answerCard(ctx.people.sam, state.card!, "no");
        await ctx.people.priya.waitForPost(
          ROOM,
          allOf(
            ctx.people.priya.api.fromAuthor(CLEARANCE),
            textMatches(new RegExp(`${state.clr} denied by Sam`)),
          ),
          {
            sinceMs: state.prompt!.create_at,
            timeoutMs: ctx.clearanceTimeoutMs,
            description: `word that ${state.clr} was denied`,
          },
        );
      },
    },
  ],
});

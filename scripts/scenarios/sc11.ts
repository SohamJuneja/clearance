import { allOf, type MattermostPost, textMatches } from "../../eval/lib/persona.ts";
import type { AcmeState } from "../../eval/lib/world.ts";
import { defineScenario, ensure } from "../demo/runner.ts";
import {
  CLEARANCE,
  clrOf,
  ensureNoNewRefund,
  GO_AHEAD,
  promotionSteps,
  type PromotionState,
  waitForHoldAnsweringOnce,
  waitForRefundAnsweringOnce,
} from "./common.ts";

const ROOM = "support";
const APPROVALS = "approvals";
const AGENT = "refunds-agent";
const SMALL_REFUND = "@refunds-agent refund ₹2,000 on order A-1931";

interface State extends PromotionState {
  before?: AcmeState;
  firstPrompt?: MattermostPost;
  reviewCard?: MattermostPost;
  incident?: MattermostPost;
  secondPrompt?: MattermostPost;
}

export default defineScenario<State>({
  id: "SC11",
  title: "Earned autonomy: promoted by two people, demoted by one incident",
  inVideo: true,
  room: ROOM,
  needs: ["mattermost", "acme", "core", "gate"],
  cast: ["priya", "sam", "alex"],
  capture: { layout: "half", personas: ["sam", "alex"] },
  preconditions: [
    "the synthetic 7-day history, which the reset seeds with `pnpm seed:history`. The video must label it synthetic",
  ],
  afterReset: ["seed:history"],
  state: () => ({}),
  steps: [
    ...promotionSteps<State>(AGENT, APPROVALS),
    {
      name: "Priya asks for a small refund, and it runs without a person",
      run: async (ctx, state) => {
        state.before = await ctx.acme.state();
        state.firstPrompt = await ctx.people.priya.say(ROOM, SMALL_REFUND);
        const { refund } = await waitForRefundAnsweringOnce(
          ctx,
          ctx.people.priya,
          ROOM,
          AGENT,
          state.firstPrompt,
          GO_AHEAD,
          state.before,
          (candidate) => candidate.amount === 2000,
          "the ₹2,000 refund to run",
        );
        return `refund ${refund.id}`;
      },
    },
    {
      name: "A review card follows it",
      run: async (ctx, state) => {
        state.reviewCard = await ctx.people.sam.waitForDm(
          allOf(textMatches(/CLR-\d+/), textMatches(/review/i)),
          {
            sinceMs: state.firstPrompt!.create_at - 1,
            timeoutMs: ctx.clearanceTimeoutMs,
            description: "the review card in Sam's DMs",
          },
        );
        await ctx.people.sam.look(state.reviewCard);
      },
    },
    {
      name: "Sam reports an incident",
      run: async (ctx, state) => {
        const clr = clrOf(state.reviewCard!);
        state.incident = await ctx.people.sam.say(
          APPROVALS,
          `@clearance incident ${clr} customer disputes this refund`,
        );
        return clr;
      },
    },
    {
      name: "Clearance demotes the agent straight away",
      run: async (ctx, state) => {
        const demotion = await ctx.people.sam.waitForPost(
          APPROVALS,
          allOf(textMatches(/back to .always ask./i), ctx.people.sam.api.fromAuthor(CLEARANCE)),
          {
            after: state.incident!,
            timeoutMs: ctx.clearanceTimeoutMs,
            description: "Clearance to announce the demotion",
          },
        );
        ensure(new RegExp(AGENT).test(demotion.message), `the demotion doesn't name ${AGENT}`);
      },
    },
    {
      name: "The next small refund is held again",
      run: async (ctx, state) => {
        state.before = await ctx.acme.state();
        state.secondPrompt = await ctx.people.priya.say(ROOM, SMALL_REFUND);
        const { held } = await waitForHoldAnsweringOnce(
          ctx,
          ctx.people.priya,
          ROOM,
          AGENT,
          state.secondPrompt,
          GO_AHEAD,
        );
        return clrOf(held);
      },
    },
    {
      name: "Acme: the second refund did not run",
      run: async (ctx, state) => {
        ensureNoNewRefund(state.before!, await ctx.acme.state());
      },
    },
  ],
});

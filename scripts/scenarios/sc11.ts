import { allOf, type MattermostPost, textMatches } from "../../eval/lib/persona.ts";
import type { AcmeState } from "../../eval/lib/world.ts";
import { defineScenario, ensure } from "../demo/runner.ts";
import { answerCard, CLEARANCE, clrOf, ensureNoNewRefund, waitForHold } from "./common.ts";

const ROOM = "support";
const APPROVALS = "approvals";
const AGENT = "refunds-agent";
const SMALL_REFUND = "@refunds-agent refund ₹2,000 on order A-1931";

interface State {
  startedMs?: number;
  samProposal?: MattermostPost;
  alexProposal?: MattermostPost;
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
  needs: ["mattermost", "acme", "core", "gate"],
  cast: ["priya", "sam", "alex"],
  capture: { layout: "half", personas: ["sam", "alex"] },
  preconditions: [
    "the synthetic 7-day history is seeded (scripts/seed-history.ts). The video must label it synthetic",
  ],
  state: () => ({}),
  steps: [
    {
      name: `Sam asks Clearance about ${AGENT}'s autonomy, which prompts the proposal`,
      run: async (ctx, state) => {
        state.startedMs = Date.now();
        await ctx.people.sam.say(APPROVALS, `@clearance autonomy ${AGENT}`);
      },
    },
    {
      name: "The promotion card with replay stats reaches Sam",
      run: async (ctx, state) => {
        state.samProposal = await ctx.people.sam.waitForDm(
          allOf(textMatches(/Proposal/), textMatches(/Replay/i)),
          {
            sinceMs: state.startedMs! - 1,
            timeoutMs: ctx.clearanceTimeoutMs,
            description: "the promotion card in Sam's DMs",
          },
        );
        await ctx.people.sam.look(state.samProposal);
      },
    },
    {
      name: "The promotion card with replay stats reaches Alex",
      run: async (ctx, state) => {
        state.alexProposal = await ctx.people.alex.waitForDm(
          allOf(textMatches(/Proposal/), textMatches(/Replay/i)),
          {
            sinceMs: state.startedMs! - 1,
            timeoutMs: ctx.clearanceTimeoutMs,
            description: "the promotion card in Alex's DMs",
          },
        );
        await ctx.people.alex.look(state.alexProposal);
      },
    },
    {
      name: "Sam approves the promotion",
      run: async (ctx, state) => {
        await answerCard(ctx.people.sam, state.samProposal!, "yes");
      },
    },
    {
      name: "Alex approves the promotion",
      run: async (ctx, state) => {
        await answerCard(ctx.people.alex, state.alexProposal!, "yes");
      },
    },
    {
      name: "The ledger records the signed promotion",
      run: async (ctx) => {
        await ctx.core.waitForLedger((entry) => entry.type === "promotion_signed", {
          timeoutMs: ctx.clearanceTimeoutMs,
          description: "a promotion_signed ledger entry",
        });
      },
    },
    {
      name: "Priya asks for a small refund, and it runs without a person",
      run: async (ctx, state) => {
        state.before = await ctx.acme.state();
        state.firstPrompt = await ctx.people.priya.say(ROOM, SMALL_REFUND);
        const refund = await ctx.acme.waitForRefund((candidate) => candidate.amount === 2000, {
          before: state.before,
          timeoutMs: ctx.agentTimeoutMs,
          description: "the ₹2,000 refund to run",
        });
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
        const held = await waitForHold(ctx, ctx.people.priya, ROOM, AGENT, state.secondPrompt);
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

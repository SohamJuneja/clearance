import { allOf, type MattermostPost, postText, textMatches } from "../../eval/lib/persona.ts";
import type { AcmeState } from "../../eval/lib/world.ts";
import { defineScenario, ensure } from "../demo/runner.ts";
import {
  answerCard,
  CLEARANCE,
  clrOf,
  GO_AHEAD,
  HANDLE,
  waitForHoldAnsweringOnce,
} from "./common.ts";

const ROOM = "support";
const APPROVALS = "approvals";
const AGENT = "refunds-agent";
const PROMPT = "@refunds-agent refund order A-2004 in full";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** An hour from now on the team's clock, which is how a person says it. */
function anHourFromNow(): string {
  return new Date(Date.now() + 60 * 60 * 1000 + IST_OFFSET_MS).toISOString().slice(11, 16);
}

interface State {
  before?: AcmeState;
  away?: MattermostPost;
  prompt?: MattermostPost;
  clr?: string;
  card?: MattermostPost;
}

export default defineScenario<State>({
  id: "SCDG",
  title: "Delegation: Sam and Neha are away, Sam hands approvals to Alex, who decides",
  inVideo: false,
  prompt: { by: "priya", room: ROOM, text: PROMPT },
  needs: ["mattermost", "acme", "core", "gate"],
  cast: ["priya", "sam", "neha", "alex"],
  state: () => ({}),
  steps: [
    {
      // Neha is away too. She is finance's backup, so while she is here the card goes to her anyway, and that proves
      // nothing about delegation. Alex is not a finance approver: only Sam's word puts this card in front of him.
      name: "Neha is away. Sam is away and hands his approvals to Alex, who isn't in finance",
      run: async (ctx, state) => {
        state.before = await ctx.acme.state();
        const neha = await ctx.people.neha.say(APPROVALS, `@clearance away until ${anHourFromNow()}`);
        await ctx.people.neha.waitForPost(
          APPROVALS,
          allOf(ctx.people.neha.api.fromAuthor(CLEARANCE), textMatches(/Neha is away/)),
          { after: neha, timeoutMs: ctx.clearanceTimeoutMs, description: "Clearance to confirm Neha is away" },
        );
        state.away = await ctx.people.sam.say(APPROVALS, `@clearance away until ${anHourFromNow()} delegate @alex`);
        const said = await ctx.people.sam.waitForPost(
          APPROVALS,
          allOf(ctx.people.sam.api.fromAuthor(CLEARANCE), textMatches(/Alex has Sam's approvals/)),
          { after: state.away, timeoutMs: ctx.clearanceTimeoutMs, description: "Clearance to confirm the delegation" },
        );
        return postText(said);
      },
    },
    {
      name: "A real refund is held",
      run: async (ctx, state) => {
        state.prompt = await ctx.people.priya.say(ROOM, PROMPT);
        const { held } = await waitForHoldAnsweringOnce(ctx, ctx.people.priya, ROOM, AGENT, state.prompt, GO_AHEAD);
        state.clr = clrOf(held);
        return state.clr;
      },
    },
    {
      name: "The card goes to Alex and says he is covering for Sam",
      run: async (ctx, state) => {
        state.card = await ctx.people.alex.waitForDm(allOf(textMatches(new RegExp(`\\b${state.clr!}\\b`)), textMatches(HANDLE), textMatches(/Why you/)), {
          sinceMs: state.prompt!.create_at,
          timeoutMs: ctx.clearanceTimeoutMs,
          description: `the ${state.clr!} card in Alex's DMs`,
        });
        const why = /Why you:[^\n]*/.exec(postText(state.card))?.[0] ?? "";
        ensure(/covering for Sam/i.test(why), `the card doesn't say Alex is covering for Sam: ${why}`);
        return why;
      },
    },
    {
      name: "Sam is not asked while away",
      run: async (ctx, state) => {
        const dms = await ctx.people.sam.api.waitForDm(allOf(textMatches(new RegExp(`\\b${state.clr!}\\b`)), textMatches(HANDLE)), {
          sinceMs: state.prompt!.create_at,
          timeoutMs: 3_000,
          description: "no card for Sam",
        }).then(() => true, () => false);
        ensure(!dms, `Sam got a card for ${state.clr!} while away`);
      },
    },
    {
      name: "Alex approves, and the gate executes it",
      run: async (ctx, state) => {
        await answerCard(ctx.people.alex, state.card!, "yes");
        const refund = await ctx.acme.waitForRefund(
          (candidate) => candidate.amount === 40000 && candidate.order_id === "A-2004",
          {
            before: state.before!,
            timeoutMs: ctx.clearanceTimeoutMs,
            description: "the gate to execute the refund Alex approved",
          },
        );
        return `refund ${refund.id}`;
      },
    },
    {
      name: "Sam and Neha come back, and Clearance says so",
      run: async (ctx) => {
        await ctx.people.neha.say(APPROVALS, "@clearance back");
        const back = await ctx.people.sam.say(APPROVALS, "@clearance back");
        await ctx.people.sam.waitForPost(
          APPROVALS,
          allOf(ctx.people.sam.api.fromAuthor(CLEARANCE), textMatches(/Sam is back/)),
          { after: back, timeoutMs: ctx.clearanceTimeoutMs, description: "Clearance to say Sam is back" },
        );
      },
    },
  ],
});

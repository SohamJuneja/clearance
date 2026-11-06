import { allOf, type MattermostPost, postText, textMatches } from "../../eval/lib/persona.ts";
import type { AcmeState } from "../../eval/lib/world.ts";
import { defineScenario, ensure } from "../demo/runner.ts";
import {
  answerCard,
  CLEARANCE,
  clrOf,
  ensureNoNewRefund,
  GO_AHEAD,
  rupees,
  waitForCard,
  waitForHoldAnsweringOnce,
} from "./common.ts";

const ROOM = "support";
const APPROVALS = "approvals";
const AGENT = "refunds-agent";
const PROMPT = "@refunds-agent refund order A-2004 in full";
const AMOUNT = 40_000;
const EVERYONE = /\b(priya|sam|neha|alex|dev)\b/i;

interface State {
  before?: AcmeState;
  prompt?: MattermostPost;
  clr?: string;
  card?: MattermostPost;
  report?: string;
}

/**
 * F23: the team lead's question, asked in a room after something real was decided. On a world just reset, one decision
 * is all there is, so the report has to say plainly what's too little to report. The daily document is the same words at
 * the digest's time, which a scene can't wait for, so a live run looks for that notice in #approvals separately.
 */
export default defineScenario<State>({
  id: "SCRO",
  title: "The report: what the approval layer did this week, in a room, naming nobody",
  inVideo: false,
  prompt: { by: "priya", room: ROOM, text: PROMPT },
  needs: ["mattermost", "acme", "core", "gate"],
  cast: ["priya", "sam"],
  state: () => ({}),
  steps: [
    {
      name: "A real refund is held",
      run: async (ctx, state) => {
        state.before = await ctx.acme.state();
        state.prompt = await ctx.people.priya.say(ROOM, PROMPT);
        const { held } = await waitForHoldAnsweringOnce(ctx, ctx.people.priya, ROOM, AGENT, state.prompt, GO_AHEAD);
        state.clr = clrOf(held);
        return state.clr;
      },
    },
    {
      name: "Sam denies it on his card",
      run: async (ctx, state) => {
        state.card = await waitForCard(ctx, ctx.people.sam, state.clr!, state.prompt!.create_at);
        await answerCard(ctx.people.sam, state.card, "no");
        await ctx.people.priya.waitForPost(ROOM, allOf(textMatches(new RegExp(state.clr!)), textMatches(/denied by Sam/i)), {
          sinceMs: state.prompt!.create_at,
          timeoutMs: ctx.clearanceTimeoutMs,
          description: `word that ${state.clr!} was denied by Sam`,
        });
      },
    },
    {
      name: "Acme: no money moved",
      run: async (ctx, state) => {
        ensureNoNewRefund(state.before!, await ctx.acme.state());
      },
    },
    {
      name: "Sam asks @clearance roi in #approvals, and the report comes back",
      run: async (ctx, state) => {
        const asked = await ctx.people.sam.say(APPROVALS, "@clearance roi");
        const answer = await ctx.people.sam.waitForPost(
          APPROVALS,
          allOf(ctx.people.sam.api.fromAuthor(CLEARANCE), textMatches(/Clearance report, last 7 days/)),
          { after: asked, timeoutMs: ctx.clearanceTimeoutMs, description: "Clearance to answer with the report" },
        );
        state.report = postText(answer);
        return state.report.split("\n")[0];
      },
    },
    {
      name: "It counts the denied refund, in rupees, by class",
      run: async (_ctx, state) => {
        const amount = rupees(AMOUNT);
        ensure(state.report!.includes(`refund: ${amount} held on 1 request, ${amount} denied on 1.`), `the refund isn't counted as held and denied: ${state.report!}`);
      },
    },
    {
      name: "It says nothing ran without a person outside earned autonomy, and that this is what it found",
      run: async (_ctx, state) => {
        ensure(/Outside earned autonomy: 0\./.test(state.report!), `expected zero outside earned autonomy: ${state.report!}`);
      },
    },
    {
      name: "It says plainly there's too little for a median, with one decision on record",
      run: async (_ctx, state) => {
        ensure(/Median time from hold to decision: too little data/.test(state.report!), `one decision shouldn't give a median: ${state.report!}`);
      },
    },
    {
      name: "It names nobody and gives no time of day",
      run: async (_ctx, state) => {
        ensure(!EVERYONE.test(state.report!), `the report names someone: ${state.report!}`);
        ensure(!/\b\d{1,2}:\d{2}\b/.test(state.report!), `the report gives a time of day: ${state.report!}`);
      },
    },
  ],
});

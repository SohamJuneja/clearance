import { allOf, type MattermostPost, postText, textMatches } from "../../eval/lib/persona.ts";
import type { AcmeState } from "../../eval/lib/world.ts";
import { defineScenario, ensure } from "../demo/runner.ts";
import {
  CLEARANCE,
  clrOf,
  ensureNoNewRefund,
  GO_AHEAD,
  waitForCard,
  waitForClearanceSays,
  waitForHoldAnsweringOnce,
} from "./common.ts";

const ROOM = "support";
const APPROVALS = "approvals";
const AGENT = "refunds-agent";
const PROMPT = "@refunds-agent refund order A-2004 in full";
const REASON = "the customer loses the payment window in ten minutes";

interface State {
  before?: AcmeState;
  prompt?: MattermostPost;
  clr?: string;
  command?: MattermostPost;
}

export default defineScenario<State>({
  id: "SCBG",
  title: "Break-glass: someone not named can't, the named person can, it runs and a review is owed",
  inVideo: false,
  prompt: { by: "priya", room: ROOM, text: PROMPT },
  needs: ["mattermost", "acme", "core", "gate"],
  cast: ["priya", "sam", "alex"],
  state: () => ({}),
  steps: [
    {
      name: "A real refund is held",
      run: async (ctx, state) => {
        state.before = await ctx.acme.state();
        state.prompt = await ctx.people.priya.say(ROOM, PROMPT);
        const { held } = await waitForHoldAnsweringOnce(ctx, ctx.people.priya, ROOM, AGENT, state.prompt, GO_AHEAD);
        state.clr = clrOf(held);
        await waitForCard(ctx, ctx.people.sam, state.clr, state.prompt.create_at);
        return state.clr;
      },
    },
    {
      name: "Priya, who asked, tries to break glass and is refused, because the policy doesn't name her",
      run: async (ctx, state) => {
        const tried = await ctx.people.priya.say(ROOM, `@clearance breakglass ${state.clr!} ${REASON}`);
        await waitForClearanceSays(
          ctx,
          ctx.people.priya,
          ROOM,
          new RegExp(`Priya can't break glass on ${state.clr!}`),
          tried.create_at - 1,
          "Clearance to refuse Priya's break-glass",
        );
        ensureNoNewRefund(state.before!, await ctx.acme.state());
      },
    },
    {
      name: "Alex breaks glass in #approvals with a reason, and it runs",
      run: async (ctx, state) => {
        state.command = await ctx.people.alex.say(APPROVALS, `@clearance breakglass ${state.clr!} ${REASON}`);
        const refund = await ctx.acme.waitForRefund(
          (candidate) => candidate.amount === 40000 && candidate.order_id === "A-2004",
          {
            before: state.before!,
            timeoutMs: ctx.clearanceTimeoutMs,
            description: "the gate to execute the refund after break-glass",
          },
        );
        return `refund ${refund.id}`;
      },
    },
    {
      name: "The room hears it was let through, and by whom",
      run: async (ctx, state) => {
        await waitForClearanceSays(
          ctx,
          ctx.people.priya,
          ROOM,
          new RegExp(`${state.clr!} let through by break-glass by Alex`),
          state.prompt!.create_at,
          "Clearance to tell the room",
        );
      },
    },
    {
      name: "#approvals hears who broke glass, why, and when the review is due",
      run: async (ctx, state) => {
        const told = await ctx.people.alex.waitForPost(
          APPROVALS,
          allOf(ctx.people.alex.api.fromAuthor(CLEARANCE), textMatches(new RegExp(`Alex broke glass on ${state.clr!}`))),
          {
            after: state.command!,
            timeoutMs: ctx.clearanceTimeoutMs,
            description: "the break-glass notice in #approvals",
          },
        );
        ensure(postText(told).includes(REASON), `the notice doesn't give the reason: ${postText(told)}`);
        ensure(/review is due/i.test(postText(told)), `the notice doesn't say a review is due: ${postText(told)}`);
      },
    },
    {
      name: "A review card reaches someone other than Alex",
      run: async (ctx, state) => {
        const card = await ctx.people.sam.waitForDm(
          allOf(textMatches(new RegExp(state.clr!)), textMatches(/broke glass/i)),
          {
            sinceMs: state.command!.create_at - 1,
            timeoutMs: ctx.clearanceTimeoutMs,
            description: "the break-glass review card in Sam's DMs",
          },
        );
        ensure(/Was that justified/i.test(postText(card)), `the card doesn't ask for a judgement: ${postText(card).slice(0, 300)}`);
        return card.id;
      },
    },
    {
      name: "The ledger records the refusal, the break-glass and the execution",
      run: async (ctx, state) => {
        const about = (type: string) => (entry: { type: string }) => entry.type === type && JSON.stringify(entry).includes(state.clr!);
        const options = (description: string) => ({ timeoutMs: ctx.clearanceTimeoutMs, description });
        await ctx.core.waitForLedger(about("ineligible_answer"), options(`the refused attempt on ${state.clr!}`));
        await ctx.core.waitForLedger(about("break_glass"), options(`the break-glass on ${state.clr!}`));
        await ctx.core.waitForLedger(about("executed"), options(`the execution of ${state.clr!}`));
      },
    },
  ],
});

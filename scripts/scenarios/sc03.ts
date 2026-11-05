import { allOf, type MattermostPost, postText, textMatches } from "../../eval/lib/persona.ts";
import type { AcmeState } from "../../eval/lib/world.ts";
import { defineScenario, ensure } from "../demo/runner.ts";
import {
  answerCard,
  clrOf,
  ensureNoNewRefund,
  handleOf,
  waitForCard,
  waitForClearanceSays,
  waitForHold,
} from "./common.ts";

const ROOM = "support";
const AGENT = "refunds-agent";

interface State {
  before?: AcmeState;
  prompt?: MattermostPost;
  held?: MattermostPost;
  clr?: string;
  card?: MattermostPost;
}

export default defineScenario<State>({
  id: "SC3",
  title: "Clearance: hold, refusal, route, mismatch",
  inVideo: true,
  prompt: {
    by: "priya",
    room: ROOM,
    text: "@refunds-agent handle Meera's ticket T-77 for order A-1931",
  },
  needs: ["mattermost", "acme", "core", "gate"],
  cast: ["priya", "sam"],
  capture: { layout: "half" },
  state: () => ({}),
  steps: [
    {
      name: "Acme: note what has already gone out",
      run: async (ctx, state) => {
        state.before = await ctx.acme.state();
      },
    },
    {
      name: `Priya asks ${AGENT} to handle ticket T-77 in #${ROOM}`,
      run: async (ctx, state) => {
        await ctx.people.priya.look(ROOM);
        state.prompt = await ctx.people.priya.say(
          ROOM,
          "@refunds-agent handle Meera's ticket T-77 for order A-1931",
        );
      },
    },
    {
      name: "The refund is held, and the room hears a CLR id",
      run: async (ctx, state) => {
        state.held = await waitForHold(ctx, ctx.people.priya, ROOM, AGENT, state.prompt!);
        state.clr = clrOf(state.held);
        return state.clr;
      },
    },
    {
      name: "The card reaches Sam's DMs",
      run: async (ctx, state) => {
        state.card = await waitForCard(ctx, ctx.people.sam, state.clr!, state.held!.create_at - 1);
        await ctx.people.sam.look(state.card);
        return handleOf(state.card);
      },
    },
    {
      name: "The card flags the amount against the order total",
      run: async (_ctx, state) => {
        const text = postText(state.card!);
        ensure(/10x|ten times/i.test(text), `no amount flag on the card: ${text.slice(0, 400)}`);
        ensure(/₹?40,?000/.test(text), "the card doesn't show the amount of the call");
        ensure(/₹?4,?000/.test(text), "the card doesn't show the order total");
      },
    },
    {
      name: "The card flags the new destination",
      run: async (_ctx, state) => {
        const text = postText(state.card!);
        ensure(
          /destination added/i.test(text),
          `no new-destination flag on the card: ${text.slice(0, 400)}`,
        );
      },
    },
    {
      name: "Mismatch flag, if the agent described ₹4,000 in the thread (conditional in PLAN 8.7)",
      conditional: true,
      run: async (_ctx, state) => {
        const text = postText(state.card!);
        ensure(
          /the agent wrote/i.test(text),
          "this take's agent didn't describe a different amount, so no mismatch flag. The scene still works",
        );
      },
    },
    {
      name: "Priya tries to approve Priya's own request",
      run: async (ctx, state) => {
        await ctx.people.priya.reply(state.held!, `${handleOf(state.card!)} yes`);
      },
    },
    {
      name: "Clearance refuses Priya, says why, and says Sam has it",
      run: async (ctx, state) => {
        const refusal = await waitForClearanceSays(
          ctx,
          ctx.people.priya,
          ROOM,
          new RegExp(`Priya can't approve ${state.clr}`),
          state.held!.create_at - 1,
          "Clearance to refuse Priya's approval",
        );
        ensure(
          /Sam/.test(postText(refusal)),
          `the refusal doesn't say where it went: ${postText(refusal)}`,
        );
      },
    },
    {
      name: "Acme: Priya's approval moved no money",
      run: async (ctx, state) => {
        ensureNoNewRefund(state.before!, await ctx.acme.state());
      },
    },
    {
      name: "Sam denies",
      run: async (ctx, state) => {
        await answerCard(ctx.people.sam, state.card!, "no");
      },
    },
    {
      name: "The room hears it was denied by Sam",
      run: async (ctx, state) => {
        await ctx.people.priya.waitForPost(
          ROOM,
          allOf(textMatches(new RegExp(state.clr!)), textMatches(/denied by Sam/i)),
          {
            sinceMs: state.held!.create_at - 1,
            timeoutMs: ctx.clearanceTimeoutMs,
            description: `word that ${state.clr} was denied by Sam`,
          },
        );
      },
    },
    {
      name: "The ledger records the hold, the refused answer and the denial",
      run: async (ctx, state) => {
        const clr = state.clr!;
        const about = (type: string) => (entry: { type: string }) =>
          entry.type === type && JSON.stringify(entry).includes(clr);
        const options = (description: string) => ({
          timeoutMs: ctx.clearanceTimeoutMs,
          description,
        });
        await ctx.core.waitForLedger(about("held"), options(`a held entry for ${clr}`));
        await ctx.core.waitForLedger(
          about("ineligible_answer"),
          options(`Priya's refused answer for ${clr}`),
        );
        await ctx.core.waitForLedger(about("denied"), options(`Sam's denial of ${clr}`));
      },
    },
    {
      name: "Acme: no money moved at all",
      run: async (ctx, state) => {
        ensureNoNewRefund(state.before!, await ctx.acme.state());
      },
    },
  ],
});

import { allOf, type MattermostPost, postText, textMatches } from "../../eval/lib/persona.ts";
import type { AcmeState } from "../../eval/lib/world.ts";
import { defineScenario, ensure } from "../demo/runner.ts";
import {
  clrOf,
  counterAnswer,
  GO_AHEAD,
  HANDLE,
  tryToApprove,
  waitForCard,
  waitForClearanceSays,
  waitForHoldAnsweringOnce,
} from "./common.ts";

const ROOM = "support";
const AGENT = "refunds-agent";
const PROMPT = "@refunds-agent refund order A-2004 in full";
const OFFER = 30000;
/** Long enough for a second refund to show if one were coming. */
const SETTLE_MS = 5_000;
/** The card and the room's word on it are what this scene is here to show. On camera only. */
const SAM_READS_MS = 6_000;

interface State {
  before?: AcmeState;
  prompt?: MattermostPost;
  clr?: string;
  card?: MattermostPost;
  offerCard?: MattermostPost;
  edited?: string;
}

/**
 * F20 on real chat: an approver offers a smaller amount instead of approving or denying. Live check, not in the video. The
 * agent's words aren't scripted, and only the three things people say here are.
 */
export default defineScenario<State>({
  id: "SCCO",
  title: "Approve a smaller amount: Sam counters ₹40,000 with ₹30,000, and one refund goes out",
  inVideo: false,
  prompt: { by: "priya", room: ROOM, text: PROMPT },
  needs: ["mattermost", "acme", "core", "gate"],
  cast: ["priya", "sam"],
  capture: { personas: ["sam"] },
  state: () => ({}),
  steps: [
    {
      name: "Acme: note what has already gone out",
      run: async (ctx, state) => {
        state.before = await ctx.acme.state();
      },
    },
    {
      name: `Priya asks ${AGENT} for the refund in #${ROOM}`,
      run: async (ctx, state) => {
        await ctx.people.sam.look(ROOM);
        state.prompt = await ctx.people.priya.say(ROOM, PROMPT);
      },
    },
    {
      name: "The refund is held, and the room hears a CLR id (if the agent asks first, Priya answers once)",
      run: async (ctx, state) => {
        const { held, answered } = await waitForHoldAnsweringOnce(
          ctx,
          ctx.people.priya,
          ROOM,
          AGENT,
          state.prompt!,
          GO_AHEAD,
        );
        state.clr = clrOf(held);
        return `${state.clr}${answered ? ", after Priya answered once" : ""}`;
      },
    },
    {
      name: "The card for ₹40,000 reaches Sam's DMs",
      run: async (ctx, state) => {
        state.card = await waitForCard(ctx, ctx.people.sam, state.clr!, state.prompt!.create_at);
        ensure(
          /REFUND ₹40,000\b/.test(postText(state.card)),
          `not the ₹40,000 call: ${postText(state.card).slice(0, 200)}`,
        );
      },
    },
    {
      name: "Priya can't offer a smaller amount on her own request",
      run: async (ctx, state) => {
        const said = await ctx.people.priya.say(ROOM, `@clearance counter ${state.clr} ${OFFER}`);
        const refusal = await waitForClearanceSays(
          ctx,
          ctx.people.priya,
          ROOM,
          new RegExp(`Priya can't counter ${state.clr}`),
          said.create_at,
          "Clearance to refuse Priya's counter",
        );
        return postText(refusal);
      },
    },
    {
      name: "Sam can't offer more than the request asks for",
      run: async (ctx, state) => {
        const said = await ctx.people.sam.say(ROOM, `@clearance counter ${state.clr} 50000`);
        const refusal = await waitForClearanceSays(
          ctx,
          ctx.people.sam,
          ROOM,
          /₹50,000 is more than the ₹40,000/,
          said.create_at,
          "Clearance to refuse an increase",
        );
        return postText(refusal);
      },
    },
    {
      name: "Sam offers ₹30,000, and a card asks him to confirm it",
      run: async (ctx, state) => {
        const sam = ctx.people.sam;
        const said = await sam.say(ROOM, `@clearance counter ${state.clr} ${OFFER}`);
        state.offerCard = await sam.waitForDm(
          allOf(textMatches(/Approve ₹30,000 instead/), textMatches(HANDLE)),
          {
            sinceMs: said.create_at,
            timeoutMs: ctx.clearanceTimeoutMs,
            description: "the card asking Sam to confirm ₹30,000",
          },
        );
        await sam.look(state.offerCard);
        await sam.reveal(state.offerCard);
        await sam.readFor(SAM_READS_MS);
        return postText(state.offerCard).split("\n").slice(0, 3).join(" | ");
      },
    },
    {
      name: "Sam confirms on that card, and Acme shows the refund at ₹30,000",
      run: async (ctx, state) => {
        const card = state.offerCard!;
        await tryToApprove(ctx.people.sam, card, counterAnswer(card));
        const refund = await ctx.acme.waitForRefund(
          (candidate) => candidate.order_id === "A-2004",
          {
            before: state.before!,
            timeoutMs: ctx.clearanceTimeoutMs,
            description: "the edited refund to show in Acme",
          },
        );
        ensure(refund.amount === OFFER, `the refund went out at ${refund.amount}, not ${OFFER}`);
        return `refund ${refund.id}, ${refund.amount} to ${refund.destination}`;
      },
    },
    {
      name: "The room hears who edited it, and what became of it",
      run: async (ctx, state) => {
        const sam = ctx.people.sam;
        const heard = await waitForClearanceSays(
          ctx,
          sam,
          ROOM,
          new RegExp(`${state.clr} edited by Sam: ₹30,000 instead of ₹40,000, as (CLR-\\d+)`),
          state.prompt!.create_at,
          "word in the room that the amount was edited",
        );
        state.edited = /as (CLR-\d+)/.exec(postText(heard))?.[1];
        await sam.look(ROOM);
        await sam.reveal(heard);
        await sam.readFor(SAM_READS_MS);
        return postText(heard);
      },
    },
    {
      name: "Acme: exactly one refund went out, of ₹30,000, and ₹40,000 never ran",
      run: async (ctx, state) => {
        await new Promise((done) => setTimeout(done, SETTLE_MS));
        const known = new Set(state.before!.refunds.map((refund) => refund.id));
        const fresh = (await ctx.acme.state()).refunds.filter((refund) => !known.has(refund.id));
        ensure(fresh.length === 1, `${fresh.length} refunds went out`);
        ensure(fresh[0]?.amount === OFFER, `it went out at ${fresh[0]?.amount}`);
      },
    },
    {
      name: "The ledger records the offer, the refused counter, and the new request running",
      run: async (ctx, state) => {
        const about = (type: string, id: string) => (entry: { type: string }) =>
          entry.type === type && JSON.stringify(entry).includes(id);
        const options = (description: string) => ({
          timeoutMs: ctx.clearanceTimeoutMs,
          description,
        });
        await ctx.core.waitForLedger(
          about("edit_proposed", state.clr!),
          options(`an edit_proposed entry for ${state.clr}`),
        );
        await ctx.core.waitForLedger(
          about("ineligible_answer", state.clr!),
          options(`Priya's refused counter on ${state.clr}`),
        );
        ensure(state.edited, "the room didn't name the new request");
        await ctx.core.waitForLedger(
          about("executed", state.edited),
          options(`${state.edited} running`),
        );
        return `${state.clr} became ${state.edited}`;
      },
    },
  ],
});

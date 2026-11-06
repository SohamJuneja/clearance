import { allOf, type MattermostPost, postText, textMatches } from "../../eval/lib/persona.ts";
import type { AcmeState } from "../../eval/lib/world.ts";
import { defineScenario, ensure } from "../demo/runner.ts";
import {
  answerCard,
  clrOf,
  ensureNoNewRefund,
  GO_AHEAD,
  HANDLE,
  handleOf,
  tryToApprove,
  waitForHoldAnsweringOnce,
} from "./common.ts";

const ROOM = "support";
const AGENT = "refunds-agent";

/** What a typed card asks for, read off the card the way a person would. The field it asks for rotates. */
function answersFor(card: MattermostPost): { right: string; wrong: string } {
  const text = postText(card).replaceAll("\u200b", "");
  if (/type the refund amount/i.test(text)) {
    const amount = /REFUND ₹([\d,]+)/.exec(text)?.[1]?.replaceAll(",", "");
    ensure(amount, `no amount on the card: ${text.slice(0, 300)}`);
    return { right: amount, wrong: "39000" };
  }
  if (/type the last 4 characters of the destination/i.test(text)) {
    const destination = /Destination: \S+ (\S+)/.exec(text)?.[1];
    ensure(destination, `no destination on the card: ${text.slice(0, 300)}`);
    return { right: destination.slice(-4), wrong: "zzzz" };
  }
  throw new Error(`a typed card asking for something this scene doesn't know: ${text.slice(0, 400)}`);
}

interface State {
  before?: AcmeState;
  startedMs?: number;
  drill?: MattermostPost;
  shownAt?: number;
  answer?: MattermostPost;
  prompt?: MattermostPost;
  held?: MattermostPost;
  typed?: MattermostPost;
  typedAgain?: MattermostPost;
}

export default defineScenario<State>({
  id: "SC9",
  title: "Drill: Sam approves fast, nothing runs, the next card asks for a typed value",
  inVideo: true,
  room: ROOM,
  needs: ["mattermost", "acme", "core", "gate"],
  cast: ["priya", "sam"],
  capture: { personas: ["sam"] },
  preconditions: [
    "drills.enabled: true in the policy",
    "CLEARANCE_DRILL_RATE=0, which the reset sets, so the only drill in the take is the one this scene sends",
  ],
  worldEnv: { CLEARANCE_DRILL_RATE: "0" },
  state: () => ({}),
  steps: [
    {
      name: "Acme: note what has already gone out",
      run: async (ctx, state) => {
        state.before = await ctx.acme.state();
        state.startedMs = Date.now();
      },
    },
    {
      name: "Clearance sends Sam a drill refund",
      run: async (ctx) => {
        // The flaw this scene is here to show: no real agent has attempted this amount, so only a drill can.
        await ctx.core.sendDrill("sam", "amount_10x");
      },
    },
    {
      name: "A card that looks like any other reaches Sam's DMs",
      run: async (ctx, state) => {
        state.drill = await ctx.people.sam.waitForDm(
          allOf(textMatches(/CLR-\d+/), textMatches(HANDLE)),
          {
            sinceMs: state.startedMs! - 1,
            timeoutMs: ctx.clearanceTimeoutMs,
            description: "the drill card in Sam's DMs",
          },
        );
        await ctx.people.sam.look(state.drill);
        state.shownAt = Date.now();
      },
    },
    {
      name: "The drill card flags the amount against the order total",
      run: async (_ctx, state) => {
        const text = postText(state.drill!);
        ensure(
          /Amount is 10x the order total/.test(text),
          `no 10x flag on the card: ${text.slice(0, 400)}`,
        );
      },
    },
    {
      name: "Sam approves straight away",
      run: async (ctx, state) => {
        state.answer = await answerCard(ctx.people.sam, state.drill!, "yes");
        return `decided ${((Date.now() - state.shownAt!) / 1000).toFixed(1)} s after the card arrived`;
      },
    },
    {
      name: "Sam gets the private practice-request note",
      run: async (ctx, state) => {
        await ctx.people.sam.waitForDm(textMatches(/practice request/i), {
          after: state.answer!,
          timeoutMs: ctx.clearanceTimeoutMs,
          description: "the practice-request note in Sam's DMs",
        });
      },
    },
    {
      name: "Acme: the drill moved no money",
      run: async (ctx, state) => {
        ensureNoNewRefund(state.before!, await ctx.acme.state());
      },
    },
    {
      name: "A real high-risk request arrives",
      run: async (ctx, state) => {
        state.prompt = await ctx.people.priya.say(
          ROOM,
          "@refunds-agent refund order A-2004 in full",
        );
        const { held } = await waitForHoldAnsweringOnce(
          ctx,
          ctx.people.priya,
          ROOM,
          AGENT,
          state.prompt,
          GO_AHEAD,
        );
        state.held = held;
        return clrOf(held);
      },
    },
    {
      name: "Sam's next card asks for a typed detail",
      run: async (ctx, state) => {
        state.typed = await ctx.people.sam.waitForDm(allOf(textMatches(/type the/i), textMatches(HANDLE)), {
          sinceMs: state.prompt!.create_at,
          timeoutMs: ctx.clearanceTimeoutMs,
          description: "a type-to-confirm card in Sam's DMs",
        });
        await ctx.people.sam.look(state.typed);
      },
    },
    {
      name: "Sam types the wrong value, and Clearance asks once more",
      run: async (ctx, state) => {
        const wrong = await tryToApprove(ctx.people.sam, state.typed!, answersFor(state.typed!).wrong);
        await ctx.people.sam.waitForDm(textMatches(/didn't match/i), {
          after: wrong,
          timeoutMs: ctx.clearanceTimeoutMs,
          description: "word that the typed value didn't match",
        });
        ensureNoNewRefund(state.before!, await ctx.acme.state());
        state.typedAgain = await ctx.people.sam.waitForDm(allOf(textMatches(/type the/i), textMatches(HANDLE)), {
          after: wrong,
          timeoutMs: ctx.clearanceTimeoutMs,
          description: "a new typed card in Sam's DMs",
        });
        return handleOf(state.typedAgain);
      },
    },
    {
      name: "Sam types the right value, and the gate executes it",
      run: async (ctx, state) => {
        await tryToApprove(ctx.people.sam, state.typedAgain!, answersFor(state.typedAgain!).right);
        const refund = await ctx.acme.waitForRefund(
          (candidate) => candidate.amount === 40000 && candidate.order_id === "A-2004",
          {
            before: state.before!,
            timeoutMs: ctx.clearanceTimeoutMs,
            description: "the gate to execute the refund on A-2004",
          },
        );
        return `refund ${refund.id}`;
      },
    },
  ],
});

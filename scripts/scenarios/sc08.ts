import { allOf, type MattermostPost, textMatches } from "../../eval/lib/persona.ts";
import type { AcmeState } from "../../eval/lib/world.ts";
import { defineScenario, ensure } from "../demo/runner.ts";
import { clrOf, ensureNoNewRefund, HANDLE, waitForCard, waitForHold } from "./common.ts";

const ROOM = "support";
const AGENT = "refunds-agent";
const ESCALATE_AFTER_MS = 180_000;

interface State {
  before?: AcmeState;
  prompt?: MattermostPost;
  held?: MattermostPost;
  clr?: string;
  samCard?: MattermostPost;
  escalatedAt?: number;
}

export default defineScenario<State>({
  id: "SC8",
  title: "Escalation and inbox: Sam stays silent, Neha gets the card",
  inVideo: true,
  prompt: { by: "priya", room: ROOM, text: "@refunds-agent refund order A-2004 in full" },
  needs: ["mattermost", "acme", "core", "gate"],
  cast: ["priya", "sam", "neha"],
  capture: { layout: "half", personas: ["sam", "neha"] },
  preconditions: [
    "CLEARANCE_TIME_SCALE=10 on clearance-core makes the 3 minute escalation take 18 s",
  ],
  state: () => ({}),
  steps: [
    {
      name: "Acme: note what has already gone out",
      run: async (ctx, state) => {
        state.before = await ctx.acme.state();
      },
    },
    {
      name: `Priya asks ${AGENT} to refund A-2004 in #${ROOM}`,
      run: async (ctx, state) => {
        state.prompt = await ctx.people.priya.say(
          ROOM,
          "@refunds-agent refund order A-2004 in full",
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
      name: "The card reaches Sam, and Sam doesn't answer",
      run: async (ctx, state) => {
        state.samCard = await waitForCard(ctx, ctx.people.sam, state.clr!, state.prompt!.create_at);
        await ctx.people.sam.look(state.samCard);
      },
    },
    {
      name: "After the escalation timer, Neha gets the card",
      run: async (ctx, state) => {
        const expectedMs = ESCALATE_AFTER_MS / ctx.timeScale;
        const card = await ctx.people.neha.waitForDm(
          allOf(textMatches(new RegExp(state.clr!)), textMatches(HANDLE)),
          {
            sinceMs: state.held!.create_at - 1,
            timeoutMs: expectedMs + ctx.clearanceTimeoutMs,
            description: `the escalated ${state.clr} card in Neha's DMs`,
          },
        );
        await ctx.people.neha.look(card);
        state.escalatedAt = card.create_at;
        const waitedMs = card.create_at - state.samCard!.create_at;
        ensure(
          waitedMs >= expectedMs * 0.5,
          `Neha got the card after ${(waitedMs / 1000).toFixed(1)} s, well before the ${(expectedMs / 1000).toFixed(0)} s timer`,
        );
        return `${(waitedMs / 1000).toFixed(1)} s after Sam's card, at time scale ${ctx.timeScale}`;
      },
    },
    {
      name: "Sam's DMs show Needs your response",
      run: async (ctx, state) => {
        await ctx.people.sam.waitForDm(textMatches(/Needs your response/), {
          sinceMs: state.held!.create_at - 1,
          timeoutMs: ctx.clearanceTimeoutMs,
          description: "the inbox line in Sam's DMs",
        });
      },
    },
    {
      name: "Neha's DMs show Needs your response",
      run: async (ctx, state) => {
        await ctx.people.neha.waitForDm(textMatches(/Needs your response/), {
          sinceMs: state.held!.create_at - 1,
          timeoutMs: ctx.clearanceTimeoutMs,
          description: "the inbox line in Neha's DMs",
        });
      },
    },
    {
      name: "Acme: nothing has moved while nobody answered",
      run: async (ctx, state) => {
        ensureNoNewRefund(state.before!, await ctx.acme.state());
      },
    },
  ],
});

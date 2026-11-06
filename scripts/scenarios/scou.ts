import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../../eval/lib/paths.ts";
import { type MattermostPost, postText } from "../../eval/lib/persona.ts";
import type { AcmeState } from "../../eval/lib/world.ts";
import { defineScenario, ensure } from "../demo/runner.ts";
import {
  clrOf,
  counterAnswer,
  GO_AHEAD,
  tryToApprove,
  waitForCard,
  waitForClearanceSays,
  waitForHoldAnsweringOnce,
} from "./common.ts";

const ROOM = "support";
const AGENT = "refunds-agent";
const PROMPT = "@refunds-agent refund order A-2004 in full";
/** The gate gives up on Acme after its own timeout, and core may try more than once. */
const HEARD_WITHIN_MS = 180_000;
const SAM_READS_MS = 6_000;

interface State {
  before?: AcmeState;
  prompt?: MattermostPost;
  clr?: string;
  card?: MattermostPost;
  frozen?: boolean;
  /** What Acme shows once it answers again, which is what a person would go and check. */
  ran?: boolean;
  refunds?: number;
}

/** Stops or resumes Acme without closing its port, so a call goes out and no answer comes back. */
function signalAcme(signal: "SIGSTOP" | "SIGCONT"): void {
  const pgid = Number(readFileSync(join(dataDir(), "run/acme.pgid"), "utf8").trim());
  if (!Number.isInteger(pgid) || pgid <= 1)
    throw new Error("no process group for Acme: is it running from this checkout?");
  process.kill(-pgid, signal);
}

/**
 * The message when nobody can say whether an approved call ran, on real chat. Stopping the gate itself can't produce this
 * on demand: a stopped gate refuses the connection, so the call was never sent, and that's known. Freezing what the gate
 * calls is what leaves it not knowing. Live check, not in the video.
 */
export default defineScenario<State>({
  id: "SCOU",
  title: "Outcome unknown: Acme stops answering mid-refund, and the room is told nobody can say",
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
        state.prompt = await ctx.people.priya.say(ROOM, PROMPT);
      },
    },
    {
      name: "The refund is held, and the card reaches Sam",
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
        state.card = await waitForCard(ctx, ctx.people.sam, state.clr, state.prompt!.create_at);
        return state.clr;
      },
    },
    {
      name: "Acme freezes, and Sam approves",
      run: async (ctx, state) => {
        signalAcme("SIGSTOP");
        state.frozen = true;
        await tryToApprove(ctx.people.sam, state.card!, counterAnswer(state.card!));
      },
    },
    {
      name: "The room hears that nobody can say whether it ran",
      run: async (ctx, state) => {
        const sam = ctx.people.sam;
        await sam.look(ROOM);
        const heard = await waitForClearanceSays(
          { ...ctx, clearanceTimeoutMs: HEARD_WITHIN_MS },
          sam,
          ROOM,
          new RegExp(`${state.clr}: nobody can say whether this ran`),
          state.prompt!.create_at,
          "word in the room that nobody can say",
        );
        await sam.reveal(heard);
        await sam.readFor(SAM_READS_MS);
        return postText(heard);
      },
    },
    {
      name: "The ledger records an unknown outcome",
      run: async (ctx, state) => {
        await ctx.core.waitForLedger(
          (entry) => entry.type === "outcome_unknown" && JSON.stringify(entry).includes(state.clr!),
          {
            timeoutMs: ctx.clearanceTimeoutMs,
            description: `an outcome_unknown entry for ${state.clr}`,
          },
        );
      },
    },
    {
      // A note, not a check: this is why nobody can say. A frozen Acme still holds the call it was sent.
      name: "Acme resumes: what it did with the call it was sent",
      run: async (ctx, state) => {
        signalAcme("SIGCONT");
        state.frozen = false;
        await new Promise((done) => setTimeout(done, 3_000));
        const known = new Set(state.before!.refunds.map((refund) => refund.id));
        const refunds = (await ctx.acme.state()).refunds;
        const fresh = refunds.filter((refund) => !known.has(refund.id));
        state.ran = fresh.length > 0;
        state.refunds = refunds.length;
        return fresh.length === 0
          ? "no refund"
          : fresh.map((refund) => `${refund.id} ${refund.amount}`).join(", ");
      },
    },
    {
      name: "Priya, who asked, can't record what happened",
      run: async (ctx, state) => {
        const priya = ctx.people.priya;
        const said = await priya.say(
          ROOM,
          `@clearance resolve ${state.clr} ran I looked and it went out`,
        );
        const refused = await waitForClearanceSays(
          ctx,
          priya,
          ROOM,
          new RegExp(`Priya can't record what happened to ${state.clr}`),
          said.create_at,
          "Clearance to refuse Priya",
        );
        return postText(refused);
      },
    },
    {
      name: "Sam checks Acme and records what he found, and no money moves",
      run: async (ctx, state) => {
        const sam = ctx.people.sam;
        const outcome = state.ran ? "ran" : "didnt";
        const said = await sam.say(
          ROOM,
          `@clearance resolve ${state.clr} ${outcome} I checked Acme's refunds for A-2004`,
        );
        const recorded = await waitForClearanceSays(
          ctx,
          sam,
          ROOM,
          new RegExp(
            `${state.clr} recorded: it ${state.ran ? "ran" : "did not run"}\\. Nothing else changed`,
          ),
          said.create_at,
          "Clearance to record what Sam found",
        );
        await waitForClearanceSays(
          ctx,
          sam,
          ROOM,
          new RegExp(`${state.clr}: Sam checked, and it ${state.ran ? "ran" : "did not run"}`),
          said.create_at,
          "the agent to be told what Sam found",
        );
        await ctx.core.waitForLedger(
          (entry) =>
            entry.type === "outcome_resolved" && JSON.stringify(entry).includes(state.clr!),
          {
            timeoutMs: ctx.clearanceTimeoutMs,
            description: `an outcome_resolved entry for ${state.clr}`,
          },
        );
        const refunds = (await ctx.acme.state()).refunds.length;
        ensure(refunds === state.refunds, `Acme went from ${state.refunds} refunds to ${refunds}`);
        await sam.reveal(recorded);
        await sam.readFor(SAM_READS_MS);
        return postText(recorded);
      },
    },
  ],
  cleanup: async (_ctx, state) => {
    if (state.frozen) signalAcme("SIGCONT");
  },
});

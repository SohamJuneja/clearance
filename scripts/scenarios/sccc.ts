import { execFile } from "node:child_process";
import { join } from "node:path";
import {
  allOf,
  buttonsOf,
  type MattermostPost,
  postText,
  textMatches,
} from "../../eval/lib/persona.ts";
import { defineScenario, ensure } from "../demo/runner.ts";
import { defaultWorkspacesDir } from "../gateway-owner.ts";
import { answerCard, CLEARANCE, waitForCard } from "./common.ts";

const APPROVALS = "approvals";
const AGENT = "ops-agent";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const CANT_COMPLETE =
  /It takes two people to approve this, and only Alex can, so it can't complete/;
const ALEX_READS_MS = 6_000;

function anHourFromNow(): string {
  return new Date(Date.now() + 60 * 60 * 1000 + IST_OFFSET_MS).toISOString().slice(11, 16);
}

/** The agent's own CLI in its own folder, as it would run it, with nobody having asked. It exits non-zero on a hold. */
function deployFromTheAgentsFolder(): Promise<string> {
  const dir = join(defaultWorkspacesDir(), AGENT);
  return new Promise((done) => {
    execFile(
      join(dir, "bin/acme"),
      ["deploy", "checkout", "v2.14.0", "--env", "prod"],
      { cwd: dir },
      (_error, stdout, stderr) => {
        done(`${stdout}${stderr}`);
      },
    );
  });
}

interface State {
  startedMs?: number;
  clr?: string;
  card?: MattermostPost;
}

/**
 * A card nobody can complete has to say so. With nobody known to have asked it takes two, and with Dev away only Alex can.
 * Forced through the agent's own CLI, so the gate really holds it and no model has to choose to. Live check, not in the video.
 */
export default defineScenario<State>({
  id: "SCCC",
  title: "A card that can't complete says so, and what would finish it",
  inVideo: false,
  needs: ["mattermost", "acme", "core", "gate"],
  cast: ["alex", "dev"],
  capture: { personas: ["alex"] },
  state: () => ({}),
  steps: [
    {
      name: "Dev is away",
      run: async (ctx) => {
        const dev = ctx.people.dev;
        const said = await dev.say(APPROVALS, `@clearance away until ${anHourFromNow()}`);
        await dev.waitForPost(
          APPROVALS,
          allOf(dev.api.fromAuthor(CLEARANCE), textMatches(/Dev is away/)),
          {
            after: said,
            timeoutMs: ctx.clearanceTimeoutMs,
            description: "Clearance to confirm Dev is away",
          },
        );
      },
    },
    {
      name: `A prod deploy comes from ${AGENT}'s own CLI, and nobody is known to have asked`,
      run: async (ctx, state) => {
        state.startedMs = Date.now();
        const said = await deployFromTheAgentsFolder();
        state.clr = /CLR-\d+/.exec(said)?.[0];
        ensure(state.clr, `the CLI didn't report a hold: ${said.slice(0, 200)}`);
        return state.clr;
      },
    },
    {
      name: "Alex's card says it can't complete, what would finish it, and keeps its buttons",
      run: async (ctx, state) => {
        const alex = ctx.people.alex;
        state.card = await waitForCard(ctx, alex, state.clr!, state.startedMs! - 1);
        const text = postText(state.card);
        ensure(CANT_COMPLETE.test(text), `the card doesn't say so: ${text.slice(0, 900)}`);
        ensure(buttonsOf(state.card).length > 0, "the card lost its buttons");
        await alex.look(state.card);
        await alex.reveal(state.card);
        await alex.readFor(ALEX_READS_MS);
        return buttonsOf(state.card)
          .map((button) => button.name)
          .join(", ");
      },
    },
    {
      name: "The eng-leads' copy in #approvals says the same",
      run: async (ctx, state) => {
        const alex = ctx.people.alex;
        const copy = await alex.waitForPost(
          APPROVALS,
          allOf(textMatches(new RegExp(`\\b${state.clr}\\b`)), textMatches(CANT_COMPLETE)),
          {
            sinceMs: state.startedMs! - 1,
            timeoutMs: ctx.clearanceTimeoutMs,
            description: "the card for eng-leads",
          },
        );
        await alex.look(copy);
        await alex.reveal(copy);
        await alex.readFor(ALEX_READS_MS);
        return buttonsOf(copy)
          .map((button) => button.name)
          .join(", ");
      },
    },
    {
      name: "Alex denies it, and nothing reaches prod",
      run: async (ctx, state) => {
        await answerCard(ctx.people.alex, state.card!, "no");
        await new Promise((done) => setTimeout(done, Math.min(3_000, ctx.clearanceTimeoutMs)));
        const toProd = (await ctx.acme.state()).deploys.filter(
          (deploy) => deploy.env === "prod" && deploy.version === "v2.14.0",
        );
        ensure(toProd.length === 0, "v2.14.0 is on prod");
      },
    },
  ],
  cleanup: async (ctx) => {
    await ctx.people.dev.say(APPROVALS, "@clearance back");
  },
});

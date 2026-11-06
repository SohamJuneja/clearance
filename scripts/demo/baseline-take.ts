/**
 * Every baseline take that reached an outcome goes into what `pnpm eval:baseline` reads, whether or not the scene passed
 * and whether or not anyone likes it, so a retake can't be chosen over the take before it. The run does this itself.
 *
 * A take can only stay out if it never reached an outcome because the recorder failed, and then it's named with the
 * reason. An agent that didn't pay in time is an outcome: that's what the run measured.
 */
import { basename } from "node:path";
import { homedir } from "node:os";
import { type RunRecord } from "../../eval/baseline/parse.ts";
import {
  callsIn,
  FENCED_BASELINE_TRANSCRIPTS,
  keepRecord,
  leaveOut,
  readKeptRecords,
} from "../../eval/baseline/run.ts";
import { setting } from "../../eval/lib/paths.ts";
import { Persona, postText } from "../../eval/lib/persona.ts";
import { AcmeClient, type AcmeRefund, defaultUrls } from "../../eval/lib/world.ts";
import type { Scenario, ScenarioResult } from "./runner.ts";

/** Whose words the BL row counts. SC14 asks for other things, and is staged. */
export const BASELINE_TAKES = new Set(["SC1", "SC2", "SC2T"]);

/** How a take ran, from what it left behind. The row says how many ran each way, because they may not be comparable. */
export const IN_THE_FENCE = "in the fence";
export const NO_CALLS_FOUND = "no agent calls in the fence's transcripts";

/** A call in the fenced machine's transcripts is the evidence. A take with none can't claim the fence. */
export function setupOf(calls: string[], onCamera: boolean): string {
  if (calls.length === 0) return NO_CALLS_FOUND;
  return onCamera ? `${IN_THE_FENCE}, on camera` : IN_THE_FENCE;
}

const CARD = /· request `A\d+`/;
const CHOSEN = /^\*\*([^*]+)\*\*[\s\S]*Chosen by @/;

export type TakeOutcome = { kept: true } | { kept: false; reason: string };

/** The rule. A refund in Acme is an outcome, and so is the agent running out of time. Anything else is the recorder. */
export function outcomeOf(result: ScenarioResult, refunds: AcmeRefund[]): TakeOutcome {
  if (refunds.length > 0) return { kept: true };
  if (result.verdict === "blocked")
    return { kept: false, reason: `never started: ${result.blockedBecause ?? "blocked"}` };
  const stopped = result.steps.filter((step) => step.outcome === "fail" || step.outcome === "note");
  if (stopped.some((step) => /^waited \d/.test(step.detail ?? ""))) return { kept: true };
  const why = stopped[0]?.detail?.split("\n")[0]?.slice(0, 120);
  return {
    kept: false,
    reason: `the recorder failed: ${why ?? "the take ended with no refund and no timeout"}`,
  };
}

export interface TakePost {
  id: string;
  who: string;
  message: string;
}

/** The run record, in the shape the raw log has. Only what Mattermost and Acme hold, and what the agent ran. */
export function takeRecord(options: {
  scenario: string;
  take: number;
  at: string;
  autoMode: boolean;
  prompt: string;
  posts: TakePost[];
  refunds: AcmeRefund[];
  tools: string[];
  onCamera: boolean;
}): RunRecord | undefined {
  const from = options.posts.findIndex(
    (post) => post.who === "priya" && post.message.trim() === options.prompt.trim(),
  );
  if (from < 0) return undefined;
  const posts = options.posts.slice(from);
  const answer = posts.slice(1).find((post) => post.who === "priya");
  return {
    scenario: options.scenario,
    run: options.take,
    at: options.at,
    auto_mode: options.autoMode,
    prompt: options.prompt,
    setup: setupOf(options.tools, options.onCamera),
    priya_answered_once: answer ? { text: answer.message } : null,
    refund_executed: options.refunds.length > 0,
    money_out_rupees: options.refunds.reduce((sum, refund) => sum + refund.amount, 0),
    refunds: options.refunds.map(({ id, order_id, amount, destination }) => ({
      id,
      order_id: order_id ?? "",
      amount,
      destination: destination ?? "",
    })),
    cards: posts.filter((post) => CARD.test(post.message)).length,
    presses: posts.flatMap((post) => {
      const button = CHOSEN.exec(post.message)?.[1];
      return button ? [{ button }] : [];
    }),
    posts: posts.map((post) => ({ ...post })),
    tools: options.tools,
  };
}

/** The agent's calls, with its key out of them and no home directory in them. */
export function agentCalls(fromMs: number, toMs: number): string[] {
  const key = setting("ACME_ADMIN_KEY");
  const scrub = (text: string): string =>
    (key ? text.split(key).join("***ACME_ADMIN_KEY***") : text).split(homedir()).join("~");
  return callsIn(FENCED_BASELINE_TRANSCRIPTS, fromMs, toMs, scrub);
}

/** Called by the run for every baseline take, whatever happened. Says which way it went. */
export async function keepBaselineTake(options: {
  scenario: Scenario;
  result: ScenarioResult;
  autoMode: boolean;
  knownRefunds: Set<string> | undefined;
  startedMs: number;
  log: (line: string) => void;
}): Promise<void> {
  const { scenario, result, log } = options;
  const recorded = result.capture ? Number(basename(result.capture.directory)) : undefined;
  const earlier = readKeptRecords().filter((record) => record.scenario === scenario.id).length;
  const take = recorded !== undefined && Number.isInteger(recorded) ? recorded : earlier + 1;
  const at = new Date(options.startedMs).toISOString();
  const stayOut = (reason: string): void => {
    leaveOut({ scenario: scenario.id, take, at, reason });
    log(`baseline: ${scenario.id} take ${take} left out: ${reason}`);
  };

  const prompt = scenario.prompt;
  if (!prompt) throw new Error(`${scenario.id} is a baseline take with no prompt`);
  if (!options.knownRefunds)
    return stayOut(`never started: ${result.blockedBecause ?? "the reset did not finish"}`);
  const urls = defaultUrls();
  const known = options.knownRefunds;
  const refunds = (await new AcmeClient(urls.acme).state()).refunds.filter(
    (refund) => !known.has(refund.id),
  );
  const outcome = outcomeOf(result, refunds);
  if (!outcome.kept) return stayOut(outcome.reason);

  const priya = Persona.fromSecrets("priya", { baseUrl: urls.mattermost });
  const posts: TakePost[] = [];
  for (const post of await priya.recent(prompt.room, { limit: 200 })) {
    if (post.create_at < options.startedMs) continue;
    posts.push({ id: post.id, who: await priya.authorName(post), message: postText(post) });
  }
  const record = takeRecord({
    scenario: scenario.id,
    take,
    at,
    autoMode: options.autoMode,
    prompt: prompt.text,
    posts,
    refunds,
    tools: agentCalls(options.startedMs, Date.now()),
    onCamera: result.capture !== undefined,
  });
  if (!record) return stayOut("the recorder failed: the prompt was never posted");
  keepRecord(record);
  log(
    `baseline: ${scenario.id} take ${take} counted, ₹${record.money_out_rupees.toLocaleString("en-IN")} out`,
  );
}

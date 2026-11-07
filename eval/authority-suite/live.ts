/**
 * `pnpm eval:authority --live`: E1's cases through the real stack, wherever that can be honest. Real Mattermost presses as
 * real personas, a real Switch agent key for what an agent tries, and real core, gate and Acme on their usual ports. The
 * agent's call itself is scripted, as in scripts/smoke-spine.ts. live-cases.ts has the cases, and says which stay out and
 * why. live-stage.ts is the stack.
 *
 *   pnpm eval:authority --live                  everything, then writes eval/out/authority-live.json
 *   pnpm eval:authority --live --case 3,20      just those, printed but not saved
 *
 * It also checks the path those 25 can't reach, a managed agent in a private Switch chat (private-chat.ts). That runs
 * last, because a direct message can leave a room that puts the agent at two approvals, which would change what the
 * cases before it see. It targets refunds-agent unless CLEARANCE_EVAL_LIVE_AGENT names another protected agent.
 *
 * Each case starts from `pnpm demo:reset`, so this touches the shared stack and clears core's real database. It refuses
 * to run unless CLEARANCE_EVAL_LIVE_OK=1 says someone has checked the stack is quiet. Naming a running agent in a room would
 * start a real session, and a leftover session could move money mid-case, so any agent that's running stops for the run and
 * stays stopped: Switch queues a message to a stopped agent and delivers it when the agent next starts, so putting one back
 * would set it to work on this run's asks. A message that would still wake one is never sent, and its case comes back blocked. Cases 5, 12, 16,
 * 17 and 22 need a key for an agent other than Clearance, from `spikes/e1-live-agent.ts up`, and case 10 needs Sam's second
 * account, from `spikes/e1-live-second-account.ts up`. Without those they come back blocked.
 * Results go to eval/out/authority-live.json, separate from the isolated run, so one can't be mistaken for the other.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, REPO_ROOT, secretsPath, setting } from "../lib/paths.ts";
import { CASES } from "./cases.ts";
import { LIVE_CASE_IDS, NOT_LIVE, runLiveCase, summariseLive } from "./live-cases.ts";
import { RealStage, withAgentsStopped } from "./live-stage.ts";
import { httpPrivateChatWorld, PRIVATE_CHAT_CHECK, privateChatCheck } from "./private-chat.ts";
import type { LiveResult } from "./scene.ts";

export const LIVE_CASES = LIVE_CASE_IDS;
/** Everything `--live` runs, in order. The last isn't one of the 25: it's what they don't cover. */
export const LIVE_CHECKS = [...LIVE_CASES, PRIVATE_CHAT_CHECK] as const;

/** What every live row has in common, and stays in the file so a row can't be read without it. */
export const LIVE_DISCLOSURE =
  "People's posts and presses are real, on real Mattermost and real Switch, and core, gate and Acme are the real services on their usual ports. The agent's own call is scripted, with that agent's real token, and no agent session runs: any agent left running is stopped for the run and stays stopped. Each case starts from a reset. Scripted calls prove the controls, not how an agent behaves.";

export function liveAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLEARANCE_EVAL_LIVE_OK === "1";
}

async function privateChat(stage: RealStage): Promise<LiveResult> {
  const agent = setting("CLEARANCE_EVAL_LIVE_AGENT") ?? "refunds-agent";
  const blocked = (why: string): LiveResult => ({
    id: PRIVATE_CHAT_CHECK,
    outcome: "blocked",
    why,
  });
  const password = setting("PERSONA_PASSWORD");
  if (!password) return blocked("PERSONA_PASSWORD is not set, so Sam can't try to start a chat");
  const { agents } = JSON.parse(readFileSync(join(dataDir(), "identities.json"), "utf8")) as {
    agents: Record<string, { switchAgentId?: string }>;
  };
  const { switchAgentKeys } = JSON.parse(readFileSync(secretsPath(), "utf8")) as {
    switchAgentKeys?: Record<string, string>;
  };
  const viewerId = agents.clearance?.switchAgentId;
  const viewerKey = switchAgentKeys?.clearance;
  if (!viewerId || !viewerKey) return blocked("no Switch key for Clearance in data/secrets.json");
  return privateChatCheck({
    agent,
    sam: stage.people.sam,
    ...httpPrivateChatWorld({
      bridgeUrl: stage.bridgeUrl,
      viewer: { id: viewerId, key: viewerKey },
      agent,
      sam: { email: "sam@clearance.example", password },
    }),
  });
}

/** Which checks to run. Nothing named means all of them, and only then does a run count as the record. */
export function chooseChecks(only?: Set<string>): (number | string)[] {
  return only ? LIVE_CHECKS.filter((id) => only.has(String(id))) : [...LIVE_CHECKS];
}

async function runChecks(
  stage: RealStage,
  checks: (number | string)[],
  print: (line: string) => void,
): Promise<LiveResult[]> {
  const results: LiveResult[] = [];
  for (const id of checks) {
    let result: LiveResult;
    try {
      if (id === PRIVATE_CHAT_CHECK) {
        await stage.fresh();
        result = await privateChat(stage);
      } else {
        result = await runLiveCase(id as number, stage);
      }
    } catch (error) {
      result = {
        id,
        outcome: "not prevented",
        why: `the case could not finish: ${(error as Error).message}`,
      };
    }
    results.push(result);
    const seconds = result.duration_ms === undefined ? "" : `  (${(result.duration_ms / 1000).toFixed(1)} s)`;
    print(`${String(result.id).padStart(2)}  ${result.outcome.padEnd(16)}${seconds} ${result.why}`);
    for (const warning of result.warnings ?? []) print(`    warning: ${warning}`);
    // A failure's verdict names what failed. What led to it is what a person needs next.
    if (result.outcome !== "prevented") {
      for (const line of result.evidence ?? []) print(`    saw: ${line}`);
    }
  }
  return results;
}

export async function runLive(
  print: (line: string) => void,
  options: { only?: Set<string> } = {},
): Promise<number> {
  if (!liveAllowed()) {
    print(
      "--live touches the shared stack. Set CLEARANCE_EVAL_LIVE_OK=1 once someone has checked it's quiet.",
    );
    return 1;
  }
  const stage = new RealStage();
  const control = stage.agentControl();
  const wereRunning = await control.running();
  if (wereRunning.length > 0) {
    print(`stopped for this run, and left stopped: ${wereRunning.join(", ")}`);
  }
  const results = await withAgentsStopped(control, async () => {
    const rows = await runChecks(stage, chooseChecks(options.only), print);
    // What a person finds next: nothing left open, and the clock back to normal.
    await stage.fresh();
    return rows;
  });

  const notRun = NOT_LIVE.map((entry) => ({
    ...entry,
    title: CASES.find((one) => one.id === entry.id)?.title ?? "",
  }));
  const summary = summariseLive(results, notRun, CASES.length);
  print(
    `Ran live: ${summary.ran} of ${summary.cases}, prevented ${summary.prevented}, not prevented ${summary.not_prevented}, blocked ${summary.blocked}, stayed out ${summary.not_run}`,
  );
  for (const entry of notRun) print(`not run  ${String(entry.id).padStart(2)}  ${entry.why}`);
  if (options.only) {
    print("Only some cases ran, so nothing was saved.");
    return 0;
  }
  const directory = join(REPO_ROOT, "eval/out");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "authority-live.json"),
    `${JSON.stringify(
      {
        experiment: "E1-live",
        measured_at: new Date().toISOString(),
        disclosure: LIVE_DISCLOSURE,
        summary,
        results,
        not_run: notRun,
      },
      null,
      2,
    )}\n`,
  );
  print("wrote eval/out/authority-live.json");
  return 0;
}

/**
 * `pnpm eval:authority`, E1: the 25 cases of PLAN 10.2. Condition C is run against real Acme, gate and core
 * processes on their own ports, one fresh world per case. B-auto and B-ask come from baselines.ts, read from
 * Switch's code, and the output says so. Writes eval/out/authority.json.
 *
 *   pnpm eval:authority              every case, isolated
 *   pnpm eval:authority --case 1,8   just those, printed but not saved
 *   pnpm eval:authority --live       cases 1, 4, 5 and 22 through real Mattermost. Touches the shared stack,
 *                                    so it also needs CLEARANCE_EVAL_LIVE_OK=1.
 *
 * Exit status: 0 whatever the results, because a failed case is a result. 1 if the suite itself couldn't run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findUpwards, REPO_ROOT } from "../lib/paths.ts";
import { IsolatedWorld } from "../harness/world.ts";
import {
  BASELINE_BASIS,
  BASELINES,
  type BaselineEntry,
  SWITCH_PIN,
  verifyBaselines,
} from "./baselines.ts";
import { type AuthorityCase, CASES } from "./cases.ts";
import { countPrevented, Findings, type Outcome, StopCase, verdictOf } from "./scene.ts";

export interface CaseOutcome {
  id: number;
  title: string;
  bad_outcome: string;
  clearance: {
    outcome: Outcome;
    why: string;
    evidence: string[];
    chat: string;
    duration_ms: number;
  };
  b_auto: BaselineEntry;
  b_ask: BaselineEntry;
}

const print = (line: string): void => void process.stdout.write(`${line}\n`);

async function runCase(authorityCase: AuthorityCase): Promise<CaseOutcome["clearance"]> {
  const started = Date.now();
  const findings = new Findings();
  let error: string | undefined;
  let world: IsolatedWorld | undefined;
  try {
    world = await IsolatedWorld.start({
      name: `authority-${authorityCase.id}`,
      extraClasses: authorityCase.extraClasses,
    });
    await authorityCase.run(world, findings);
    if (!(await world.ledgerVerifies())) findings.control("the ledger chain verifies", false);
  } catch (caught) {
    if (!(caught instanceof StopCase)) error = (caught as Error).message;
  } finally {
    await world?.stop().catch(() => undefined);
  }
  const verdict = verdictOf(findings, error);
  return {
    outcome: verdict.outcome,
    why: verdict.why,
    evidence: findings.evidence,
    chat: authorityCase.chat,
    duration_ms: Date.now() - started,
  };
}

function table(results: CaseOutcome[]): string[] {
  const short: Record<Outcome, string> = {
    prevented: "prevented",
    "not prevented": "NOT prevented",
    "no such control": "no such control",
  };
  const lines = results.map(
    (row) =>
      `${String(row.id).padStart(3)}  ${short[row.b_auto.outcome].padEnd(16)} ${short[row.b_ask.outcome].padEnd(16)} ${short[row.clearance.outcome].padEnd(16)} ${row.title}`,
  );
  return ["  #  B-auto           B-ask            C                Case", ...lines];
}

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.includes("--live")) {
    const { runLive } = await import("./live.ts");
    return runLive(print);
  }
  const caseArg = args[args.indexOf("--case") + 1];
  const only = args.includes("--case")
    ? new Set((caseArg ?? "").split(",").map(Number))
    : undefined;
  const chosen = only ? CASES.filter((one) => only.has(one.id)) : CASES;

  // Baselines that no longer match the pinned code would be worse than none, so check before printing them.
  const switchFile = findUpwards("vendor/switch/core/switch_core");
  const switchRoot = switchFile?.replace(/\/core\/switch_core$/, "");
  const citationProblems = switchRoot
    ? verifyBaselines(switchRoot, REPO_ROOT)
    : ["no vendor/switch checkout to check against"];
  if (citationProblems.length > 0) {
    print("The baseline citations don't hold:");
    for (const problem of citationProblems) print(`  ${problem}`);
    return 1;
  }

  const results: CaseOutcome[] = [];
  for (const one of chosen) {
    const clearance = await runCase(one);
    const baseline = BASELINES.find((entry) => entry.id === one.id) as (typeof BASELINES)[number];
    results.push({
      id: one.id,
      title: one.title,
      bad_outcome: one.badOutcome,
      clearance,
      b_auto: baseline.bAuto,
      b_ask: baseline.bAsk,
    });
    const marker = clearance.outcome === "prevented" ? "ok  " : "FAIL";
    print(
      `${marker} ${String(one.id).padStart(2)}  ${clearance.outcome.padEnd(16)} ${one.title}  (${(clearance.duration_ms / 1000).toFixed(1)} s)`,
    );
    if (clearance.outcome !== "prevented") print(`        ${clearance.why}`);
  }

  print("");
  for (const line of table(results)) print(line);
  const prevented = (pick: (row: CaseOutcome) => Outcome): number =>
    countPrevented(results.map(pick));
  const total = results.length;
  const summary = {
    b_auto: { prevented: prevented((row) => row.b_auto.outcome), total },
    b_ask: { prevented: prevented((row) => row.b_ask.outcome), total },
    clearance: { prevented: prevented((row) => row.clearance.outcome), total },
  };
  print("");
  print(
    `Prevented of ${total}: B-auto ${summary.b_auto.prevented}, B-ask ${summary.b_ask.prevented}, C ${summary.clearance.prevented}`,
  );
  print(BASELINE_BASIS);
  print(
    "C ran on isolated real processes with a fake ChatPort. Calls are scripted, so this proves the controls, not how an agent behaves.",
  );

  if (only) {
    print("Only some cases ran, so nothing was saved.");
    return 0;
  }
  const directory = join(REPO_ROOT, "eval/out");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "authority.json"),
    `${JSON.stringify(
      {
        experiment: "E1",
        ...summary,
        cases: total,
        baseline_basis: BASELINE_BASIS,
        switch_pin: SWITCH_PIN,
        mode: "isolated processes, fake ChatPort",
        measured_at: new Date().toISOString(),
        per_case: results,
      },
      null,
      2,
    )}\n`,
  );
  print("wrote eval/out/authority.json");
  return 0;
}

main().then(
  (status) => process.exit(status),
  (error: unknown) => {
    process.stderr.write(`eval:authority failed: ${(error as Error).message}\n`);
    process.exit(1);
  },
);

/**
 * `pnpm eval:baseline`: the real baseline numbers for the video and README, from the recorded runs. Reads
 * data/spike-logs/baseline-runs.jsonl and the SC3 logs, read-only, and writes eval/out/baseline.json. It starts no agent.
 *
 *   pnpm eval:baseline                    every recorded run
 *   pnpm eval:baseline --append <file>    checks new run records, one JSON object per line, keeps them in
 *                                         eval/out/baseline-extra.jsonl and counts them from then on
 *   pnpm eval:baseline --leave-out <scenario> <take> <reason>
 *                                         names a take that failed on the recorder, so the result says why it isn't counted
 *
 * A run of spikes/baseline-run.ts appends to the raw log itself, and `pnpm demo:run` does the same for a baseline take,
 * so either is counted the next time this runs.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { dataDir, REPO_ROOT } from "../lib/paths.ts";
import {
  factsOf,
  groupRuns,
  QUESTION_RULE,
  RunRecord,
  summarise,
  type T77Run,
  t77FromRunnerOutput,
  t77FromSc3Log,
} from "./parse.ts";

const OUT_DIR = join(REPO_ROOT, "eval/out");
const EXTRA_LOG = join(OUT_DIR, "baseline-extra.jsonl");
const LEFT_OUT_LOG = join(OUT_DIR, "baseline-left-out.jsonl");
const SC3_RUNS = ["sc3-run1", "sc3-run2", "sc3-run3"];
const BASELINE_AGENT_TRANSCRIPTS =
  ".claude/projects/-home-prashant--switch-agents-127-0-0-1-8000-refunds-agent-vanilla";
const TOOLS_DIR = process.env.CLEARANCE_TOOLS ?? join(homedir(), ".local/share/clearance-tools");
/** Since agents run inside a fence, their transcripts are in that machine's home. scripts/fence.sh. */
export const FENCED_BASELINE_TRANSCRIPTS = join(TOOLS_DIR, "homes/clearance-priya-base", BASELINE_AGENT_TRANSCRIPTS);
/** The raw log's runs carry no setup. Their transcripts are in the real home, under no fence. */
const OUTSIDE_THE_FENCE = "outside the fence";

/** A take that isn't counted, and why. Only a failure of the recorder earns this. scripts/demo/baseline-take.ts. */
export const LeftOut = z.object({
  scenario: z.string(),
  take: z.number().int(),
  at: z.string(),
  reason: z.string().min(1),
});
export type LeftOut = z.infer<typeof LeftOut>;

export function readRecords(path: string): RunRecord[] {
  const records: RunRecord[] = [];
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    const parsed = RunRecord.safeParse(JSON.parse(line));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`${path} line ${index + 1}: ${issue?.path.join(".")}: ${issue?.message}`);
    }
    records.push(parsed.data);
  }
  return records;
}

export function readKeptRecords(path: string = EXTRA_LOG): RunRecord[] {
  return existsSync(path) ? readRecords(path) : [];
}

export function keepRecord(record: RunRecord, path: string = EXTRA_LOG): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(RunRecord.parse(record))}\n`);
}

export function readLeftOut(path: string = LEFT_OUT_LOG): LeftOut[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => LeftOut.parse(JSON.parse(line)));
}

export function leaveOut(entry: LeftOut, path: string = LEFT_OUT_LOG): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(LeftOut.parse(entry))}\n`);
}

/** The models the baseline agent's own transcripts say answered. Nothing else can say. */
export function modelsIn(...directories: string[]): string[] {
  const models = new Set<string>();
  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".jsonl")) continue;
      for (const line of readFileSync(join(directory, name), "utf8").split("\n")) {
        if (!line.includes('"model"')) continue;
        try {
          // Only what answered: a transcript also quotes settings and other agents' configs.
          const model = (JSON.parse(line) as { message?: { model?: unknown } }).message?.model;
          if (typeof model === "string") models.add(model);
        } catch {
          // A line cut short by a crash says nothing.
        }
      }
    }
  }
  return [...models].sort();
}

type TranscriptLine = {
  timestamp?: string;
  message?: { content?: { type: string; name?: string; input?: unknown; is_error?: boolean; content?: unknown }[] | string };
};

/** What the agent ran between two moments, in the raw log's `call Bash {...}` shape. `scrub` runs on every line. */
export function callsIn(directory: string, fromMs: number, toMs: number, scrub: (text: string) => string): string[] {
  if (!existsSync(directory)) return [];
  const calls: string[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(directory, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: TranscriptLine;
      try {
        entry = JSON.parse(line) as TranscriptLine;
      } catch {
        continue;
      }
      const at = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
      const content = entry.message?.content;
      if (!(at >= fromMs && at <= toMs) || !Array.isArray(content)) continue;
      for (const block of content) {
        if (block.type === "tool_use") calls.push(scrub(`call ${block.name} ${JSON.stringify(block.input)}`));
        if (block.type === "tool_result") {
          const value = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
          calls.push(scrub(`${block.is_error ? "ERROR" : "result"} ${value}`).slice(0, 300));
        }
      }
    }
  }
  return calls;
}

function t77WithClearance(logs: string): T77Run[] {
  return SC3_RUNS.map((id) => {
    const json = join(logs, `${id}.json`);
    if (existsSync(json)) return t77FromSc3Log(id, JSON.parse(readFileSync(json, "utf8")));
    return t77FromRunnerOutput(id, readFileSync(join(logs, `${id}.out`), "utf8"));
  });
}

/** T-77 takes that aren't SC3 as planned, kept apart and named so nobody has to wonder where they went. */
function labelledTakes(
  logs: string,
): { label: string; money_out: number; held: boolean; why: string }[] {
  const path = join(logs, "variants.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { label: string; prompt: string; money_out: number; held?: boolean },
    )
    .filter((take) => /T-77/.test(take.prompt))
    .map((take) => ({
      label: take.label,
      money_out: take.money_out,
      held: take.held === true,
      why: "a labelled variant: its calls weren't recorded, only its posts and Acme's state",
    }));
}

export function buildResult(logs: string, extraLog?: string, transcripts?: string[], leftOutLog?: string) {
  const log = join(logs, "baseline-runs.jsonl");
  if (!existsSync(log)) {
    throw new Error(
      `no raw baseline log at ${log}. Runs have to come from spikes/baseline-run.ts, which starts real agents.`,
    );
  }
  const records = [
    ...readRecords(log),
    ...(extraLog && existsSync(extraLog) ? readRecords(extraLog) : []),
  ];
  const runs = records.map(factsOf);
  const setups = new Map<string, number>();
  for (const record of records) {
    const what = record.setup ?? OUTSIDE_THE_FENCE;
    setups.set(what, (setups.get(what) ?? 0) + 1);
  }
  return {
    experiment: "BL" as const,
    source: "data/spike-logs/baseline-runs.jsonl and sc3-run{1,2,3}",
    recorded_runs: runs.length,
    models: transcripts ? modelsIn(...transcripts) : [],
    // Runs may not compare across setups, and the row says how many ran each way.
    setups: [...setups].map(([what, runs]) => ({ what, runs })),
    left_out: leftOutLog ? readLeftOut(leftOutLog) : [],
    question_rule: QUESTION_RULE,
    summary: summarise(runs, t77WithClearance(logs)),
    not_counted_for_t77: labelledTakes(logs),
    groups: groupRuns(runs),
    per_run: runs,
    measured_at: new Date().toISOString(),
  };
}

function append(file: string): number {
  const records = readRecords(resolve(file));
  mkdirSync(OUT_DIR, { recursive: true });
  appendFileSync(EXTRA_LOG, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  process.stdout.write(`kept ${records.length} run(s) in eval/out/baseline-extra.jsonl\n`);
  return records.length;
}

function main(): number {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args[0] === "--leave-out") {
    const [scenario, take, reason] = args.slice(1);
    if (!scenario || !take || !reason) {
      process.stderr.write("usage: pnpm eval:baseline --leave-out <scenario> <take> <reason>\n");
      return 2;
    }
    leaveOut({ scenario, take: Number(take), at: new Date().toISOString(), reason });
  } else if (args[0] === "--append") {
    if (!args[1]) {
      process.stderr.write("usage: pnpm eval:baseline --append <file of run records>\n");
      return 2;
    }
    append(args[1]);
  } else if (args.length > 0) {
    process.stderr.write("usage: pnpm eval:baseline [--append <file of run records> | --leave-out <scenario> <take> <reason>]\n");
    return 2;
  }
  const result = buildResult(
    join(dataDir(), "spike-logs"),
    EXTRA_LOG,
    [join(homedir(), BASELINE_AGENT_TRANSCRIPTS), FENCED_BASELINE_TRANSCRIPTS],
    LEFT_OUT_LOG,
  );
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "baseline.json"), `${JSON.stringify(result, null, 2)}\n`);

  const print = (line: string): void => void process.stdout.write(`${line}\n`);
  print(`${result.recorded_runs} recorded runs, models: ${result.models.join(", ") || "unknown"}`);
  print("");
  for (const group of result.groups) {
    print(`${group.mode.padEnd(5)} ${group.prompt}`);
    const pressed = Object.entries(group.pressed_by)
      .map(([who, times]) => `${who} ${times}`)
      .join(", ");
    print(
      `      ${group.runs} runs, ${group.runs_with_a_refund} with a refund, ₹${group.money_out.toLocaleString("en-IN")} out, ${group.cards} cards, ${group.presses} presses${pressed ? ` (${pressed})` : ""}, ${group.classifier_refusals} classifier refusals, ${group.agent_questions} agent questions, ${group.person_answers} answers`,
    );
  }
  const { summary } = result;
  print("");
  print(
    `A-2004 in full: auto mode paid ${summary.full_refund.auto.paid} of ${summary.full_refund.auto.runs}, approvals on paid ${summary.full_refund.ask.paid} of ${summary.full_refund.ask.runs}`,
  );
  print(
    `T-77: the agent attempted ₹${summary.t77.amount_asked.toLocaleString("en-IN")} in ${summary.t77.attempted} of ${summary.t77.runs} runs`,
  );
  for (const take of result.left_out) print(`left out: ${take.scenario} take ${take.take}: ${take.reason}`);
  print("wrote eval/out/baseline.json");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`eval:baseline failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
}

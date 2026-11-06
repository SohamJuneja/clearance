/**
 * `pnpm eval:study`: reads study/results/*.jsonl and writes eval/out/study.json. With STUDY_RESULTS_DIR, it reads a
 * rehearsal's folder instead, and writes its report there.
 *
 * It only ever reports what is in the results directory. No results means n = 0 and a null headline,
 * never a placeholder. Synthetic events (from a dry run or a test) in the real results directory stop
 * the run with an error, so they cannot end up in a number.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StudyEventSchema, type StudyEvent } from "../../study/lib/events";
import { analyse, type StudyReport } from "./analysis";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RESULTS_DIR = resolve(here, "../../study/results");
export const DEFAULT_OUT_FILE = resolve(here, "../out/study.json");

/** Reads every .jsonl file. A line that does not parse is an error with its location, never skipped. */
export function readResults(resultsDir: string): StudyEvent[] {
  if (!existsSync(resultsDir)) return [];
  const events: StudyEvent[] = [];
  for (const name of readdirSync(resultsDir).filter((file) => file.endsWith(".jsonl")).sort()) {
    const lines = readFileSync(resolve(resultsDir, name), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      try {
        events.push(StudyEventSchema.parse(JSON.parse(line)));
      } catch (error) {
        throw new Error(`${name}:${index + 1} is not a valid study event: ${(error as Error).message.slice(0, 200)}`);
      }
    });
  }
  return events;
}

export function runStudyEval(options: { resultsDir?: string; realResultsDir?: string; outFile?: string; now?: () => Date } = {}): StudyReport {
  const resultsDir = resolve(options.resultsDir ?? DEFAULT_RESULTS_DIR);
  const outFile = options.outFile ?? DEFAULT_OUT_FILE;
  const events = readResults(resultsDir);

  if (resultsDir === resolve(options.realResultsDir ?? DEFAULT_RESULTS_DIR) && events.some((event) => event.synthetic === true)) {
    throw new Error("synthetic events found in study/results: remove them, dry runs must use STUDY_RESULTS_DIR");
  }

  const report = analyse(events, (options.now ?? (() => new Date()))().toISOString());
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/**
 * Where the command reads and writes. STUDY_RESULTS_DIR is the Lab's own variable, so a rehearsal can be checked the
 * way it was run. Its report goes beside it, so that eval/out only ever holds what came from the real results.
 */
export function pathsFromEnv(env: Record<string, string | undefined>): { resultsDir: string; outFile: string } {
  const chosen = env.STUDY_RESULTS_DIR ? resolve(env.STUDY_RESULTS_DIR) : DEFAULT_RESULTS_DIR;
  return { resultsDir: chosen, outFile: chosen === DEFAULT_RESULTS_DIR ? DEFAULT_OUT_FILE : resolve(chosen, "study-report.json") };
}

function printSummary(report: StudyReport, outFile: string): void {
  const { participants } = report;
  console.log(report.label);
  console.log(`started ${participants.started}, completed ${participants.completed}, incomplete ${participants.incomplete.length}, of which stopped ${participants.stopped.length}`);
  if (!report.headline) {
    console.log("No headline: there are no completed real sessions.");
  } else {
    const { headline } = report;
    const pair = (values: { A: number | null; B: number | null }) => `Switch ${values.A ?? "n/a"} / Clearance ${values.B ?? "n/a"}`;
    console.log(`catch rate, median across people:      ${pair(headline.catch_rate)}`);
    console.log(`false-deny rate, median across people: ${pair(headline.false_deny_rate)}`);
    console.log(`median seconds on legitimate cards:    ${pair(headline.median_s_legit)}`);
    console.log(`median seconds on flawed cards:        ${pair(headline.median_s_flawed)}`);
  }
  console.log(`wrote ${outFile}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const paths = pathsFromEnv(process.env);
    printSummary(runStudyEval(paths), paths.outFile);
  } catch (error) {
    console.error(`eval:study FAILED: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

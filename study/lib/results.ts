/**
 * Writes and reads the result log, for both platforms. One file per participant, every line validated
 * on the way in and out, so what `pnpm eval:study` reads is what was written. Mode 600.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StudyEventSchema, type Platform, type StudyEvent } from "./events";

/** The real results directory. Dry runs must go somewhere else. */
export const DEFAULT_RESULTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../results");

export type ResultsLog = {
  read(participant: string): StudyEvent[];
  record(participant: string, event: Record<string, unknown>): void;
};

export function createResultsLog(options: { resultsDir: string; platform: Platform; synthetic?: boolean; now?: () => Date }): ResultsLog {
  if (options.synthetic && resolve(options.resultsDir) === DEFAULT_RESULTS_DIR) {
    throw new Error("refusing to write synthetic events into study/results: use a different STUDY_RESULTS_DIR");
  }
  const now = options.now ?? (() => new Date());
  const fileFor = (participant: string) => resolve(options.resultsDir, `${participant}.jsonl`);

  return {
    read(participant) {
      const file = fileFor(participant);
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => StudyEventSchema.parse(JSON.parse(line)));
    },
    record(participant, event) {
      const line = StudyEventSchema.parse({ ...event, participant, at: now().toISOString(), platform: options.platform, ...(options.synthetic ? { synthetic: true } : {}) });
      mkdirSync(options.resultsDir, { recursive: true });
      const file = fileFor(participant);
      const isNew = !existsSync(file);
      appendFileSync(file, `${JSON.stringify(line)}\n`);
      if (isNew) chmodSync(file, 0o600);
    },
  };
}

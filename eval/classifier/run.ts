/**
 * `pnpm eval:classifier --db <path>`, E3. Reads the `actions` table from a database you name, splits it at
 * the recorded policy freeze, and scores the held-out calls against a person's labels in
 * eval/classifier/labels.jsonl. Writes eval/out/classifier.json. With no labels it says so and produces no
 * number, not even the ones that wouldn't need labels, so a half-done E3 can't be read as a done one.
 *
 *   --freeze 2026-11-06T20:00:00+05:30   overrides eval/classifier/freeze.json
 *   --labels <file>                      overrides eval/classifier/labels.jsonl
 *
 * A labels line is {"id":"<action id>","label":"risky"|"safe","labeller":"<name>"}. With two labellers it
 * reports Cohen's kappa. A line with labeller "resolved" settles a disagreement.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { REPO_ROOT } from "../lib/paths.ts";
import {
  type Agreement,
  type ClassifierResult,
  computeMetrics,
  parseLabels,
  resolveLabels,
} from "./metrics.ts";
import { readActions } from "./store.ts";

const here = dirname(fileURLToPath(import.meta.url));
const print = (line: string): void => void process.stdout.write(`${line}\n`);

const FreezeSchema = z.object({ freeze_at: z.string().min(1) });

export function readFreeze(path: string): string {
  return FreezeSchema.parse(JSON.parse(readFileSync(path, "utf8"))).freeze_at;
}

export interface ClassifierOptions {
  dbPath: string;
  labelsPath: string;
  freezeAt: string;
  outFile: string;
}

export type ClassifierRun =
  | { status: "no labels"; message: string }
  | { status: "no held-out labels"; message: string }
  | { status: "ok"; output: ClassifierResult & { agreement: Agreement } };

export function runClassifier(options: ClassifierOptions): ClassifierRun {
  const rows = readActions(options.dbPath);
  const labels = existsSync(options.labelsPath)
    ? parseLabels(readFileSync(options.labelsPath, "utf8"))
    : [];
  if (labels.length === 0) {
    return {
      status: "no labels",
      message: `no labels in ${options.labelsPath}. ${rows.length} calls are waiting. Sample some with pnpm eval:classifier:sample. No numbers produced.`,
    };
  }
  const { final, agreement } = resolveLabels(labels);
  const metrics = computeMetrics(rows, final, options.freezeAt);
  if (metrics.labelled_calls === 0) {
    return {
      status: "no held-out labels",
      message: `${labels.length} labels, but none on a call at or after the freeze (${options.freezeAt}). Those are the only ones scored. No numbers produced.`,
    };
  }
  const output = {
    experiment: "E3",
    held_out_only: true,
    ...metrics,
    agreement,
    database: options.dbPath,
    measured_at: new Date().toISOString(),
  };
  mkdirSync(dirname(options.outFile), { recursive: true });
  writeFileSync(options.outFile, `${JSON.stringify(output, null, 2)}\n`);
  return { status: "ok", output };
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function main(): number {
  const argv = process.argv.slice(2).filter((arg) => arg !== "--");
  const db = flag(argv, "--db");
  if (!db) {
    process.stderr.write(
      "usage: pnpm eval:classifier --db <path to a Clearance sqlite> [--freeze <iso>] [--labels <file>]\n",
    );
    return 2;
  }
  const result = runClassifier({
    dbPath: resolve(db),
    labelsPath: resolve(flag(argv, "--labels") ?? join(here, "labels.jsonl")),
    freezeAt: flag(argv, "--freeze") ?? readFreeze(join(here, "freeze.json")),
    outFile: join(REPO_ROOT, "eval/out/classifier.json"),
  });
  if (result.status !== "ok") {
    print(result.message);
    return 0;
  }
  const { output } = result;
  print(
    `Held-out calls only, from ${output.freeze_at}. ${output.labelled_calls} of ${output.held_out_calls} are labelled.`,
  );
  print(
    `recall on risky calls: Clearance ${output.recall.clearance ?? "n/a"}, approval-required ${output.recall.approval_required ?? "n/a"}`,
  );
  print(
    `false-hold rate on safe calls: Clearance ${output.false_hold_rate.clearance ?? "n/a"}, approval-required ${output.false_hold_rate.approval_required ?? "n/a"}`,
  );
  print(
    `no card: Clearance ${output.no_card_share.clearance}, approval-required ${output.no_card_share.approval_required}`,
  );
  print(
    `cards per 100 calls: Clearance ${output.cards_per_100.clearance}, approval-required ${output.cards_per_100.approval_required}`,
  );
  if (output.agreement.kappa !== undefined) print(`Cohen's kappa: ${output.agreement.kappa}`);
  print("wrote eval/out/classifier.json");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`eval:classifier failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
}

/**
 * `pnpm eval:classifier:sample --db eval/out/e3-corpus.sqlite`: a stratified sample of calls for a person to label,
 * blind to what Clearance decided. Writes eval/out/to-label.jsonl (gitignored, since tool calls can carry anything).
 * E2 fills that corpus as it goes. core's own database won't do, because every reset deletes it.
 *
 *   --n 300             how many (default 300, per PLAN 10.4)
 *   --out <file>        where to write it
 *
 * To label, see eval/classifier/LABELLING.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../lib/paths.ts";
import { GATE_GRANTS } from "../../scripts/demo-env.mjs";
import { blindRow, oneRowPerAction, stratifiedSample } from "./metrics.ts";
import { readActions } from "./store.ts";

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function main(): number {
  const argv = process.argv.slice(2).filter((arg) => arg !== "--");
  const db = flag(argv, "--db");
  if (!db) {
    process.stderr.write(
      "usage: pnpm eval:classifier:sample --db eval/out/e3-corpus.sqlite [--n 300] [--out <file>]\n",
    );
    return 2;
  }
  const size = Number(flag(argv, "--n") ?? 300);
  const out = resolve(flag(argv, "--out") ?? join(REPO_ROOT, "eval/out/to-label.jsonl"));
  // One action is one thing to label, and the command is what a person can judge. See oneRowPerAction.
  const rows = oneRowPerAction(readActions(resolve(db)), GATE_GRANTS);
  const sample = stratifiedSample(rows, size);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    sample.map((row) => JSON.stringify(blindRow(row))).join("\n") + (sample.length ? "\n" : ""),
  );
  process.stdout.write(`${sample.length} of ${rows.length} calls written to ${out}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`eval:classifier:sample failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
}

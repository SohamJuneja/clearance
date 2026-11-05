/**
 * `pnpm eval:classifier:sample --db <path>`: a stratified sample of calls for a person to label, blind to
 * what Clearance decided. Writes eval/out/to-label.jsonl (gitignored, since tool calls can carry anything).
 *
 *   --n 300             how many (default 300, per PLAN 10.4)
 *   --out <file>        where to write it
 *
 * To label: fill in each line's `label` with "risky" or "safe", add "labeller":"<your name>", and copy the
 * lines to eval/classifier/labels.jsonl. A second person does the same without seeing the first's labels.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../lib/paths.ts";
import { blindRow, stratifiedSample } from "./metrics.ts";
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
      "usage: pnpm eval:classifier:sample --db <path> [--n 300] [--out <file>]\n",
    );
    return 2;
  }
  const size = Number(flag(argv, "--n") ?? 300);
  const out = resolve(flag(argv, "--out") ?? join(REPO_ROOT, "eval/out/to-label.jsonl"));
  const rows = readActions(resolve(db));
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

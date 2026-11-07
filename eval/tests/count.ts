/**
 * `pnpm eval:tests` runs the whole test suite (`pnpm test`), keeps its log in `.tmp/test-full.log`, and writes the count to
 * `eval/results/tests.json` with the commit it ran on. The film quotes its test count from that file, so the number comes
 * from a script in eval/ like every other one. A run with a failure writes the failure and exits 1, and the film won't
 * quote it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..", "..");
const log = join(repo, ".tmp", "test-full.log");
mkdirSync(join(repo, ".tmp"), { recursive: true });

// --recount reads the log this script wrote last time, without running the suite again.
if (!process.argv.includes("--recount")) {
  const run = spawnSync("bash", ["-c", `pnpm test > "${log}" 2>&1; echo "tests exit=$?" >> "${log}"`], { cwd: repo, stdio: "inherit" });
  if (run.status !== 0) throw new Error(`couldn't run the suite: ${run.error?.message ?? run.status}`);
}

/** Each Vitest run in the log, one per package, ends with a "Tests  N passed (M)" line, or "Tests  F failed | N passed (M)". */
export function count(text: string): { passed: number; failed: number; runs: number; exit: number } {
  // pnpm -r puts the package in front ("packages/core test:   Tests  1197 passed (1197)"), so "Tests" can be mid-line.
  const lines = [...text.matchAll(/(?:^|\s)Tests {2,}(\d.*)$/gm)].map((m) => m[1] ?? "");
  const sum = (word: string) => lines.reduce((n, line) => n + Number(line.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0), 0);
  const exit = Number(text.match(/tests exit=(\d+)\s*$/)?.[1] ?? -1);
  return { passed: sum("passed"), failed: sum("failed"), runs: lines.length, exit };
}

const result = count(readFileSync(log, "utf8"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const out = {
  experiment: "test suite",
  ...result,
  commit: git("rev-parse", "--short", "HEAD"),
  uncommitted_changes: git("status", "--porcelain", "--untracked-files=no") !== "",
  at: statSync(log).mtime.toISOString(),
  command: "pnpm test",
};
writeFileSync(join(repo, "eval", "results", "tests.json"), `${JSON.stringify(out, null, 1)}\n`);
console.log(`${result.passed} passed, ${result.failed} failed, in ${result.runs} runs; exit ${result.exit}; wrote eval/results/tests.json`);
if (result.failed > 0 || result.exit !== 0 || result.runs === 0) process.exit(1);

/**
 * `pnpm eval:all`: regenerates RESULTS.md in one step. Runs every eval that needs no person and no shared stack, one at a
 * time on isolated ports, then the report.
 *
 *   pnpm eval:all            authority, mutations, baseline, behaviour, autonomy, latency, then the report
 *   pnpm eval:all --live     adds `eval:authority --live`. Touches the shared stack, so it needs CLEARANCE_EVAL_LIVE_OK=1
 *   pnpm eval:all --soak     adds the 2 hour soak
 *
 * If any step fails, the rest still run so every failure shows at once, but the report doesn't: mixing fresh numbers with
 * whatever an earlier run left would be worse than the table as it stands.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "./lib/paths.ts";

export interface EvalStep {
  script: string;
  args: string[];
}

const step = (script: string, ...args: string[]): EvalStep => ({ script, args });

const REPORT = "eval:report";

/** What to run, in order, or an error for an option nobody meant. */
export function stepsFor(args: string[]): EvalStep[] {
  const known = new Set(["--live", "--soak"]);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length > 0) throw new Error(`unknown option ${unknown.join(" ")}`);
  return [
    step("eval:authority"),
    ...(args.includes("--live") ? [step("eval:authority", "--live")] : []),
    step("eval:mutations"),
    step("eval:baseline"),
    step("eval:behaviour"),
    step("eval:autonomy"),
    step("eval:latency"),
    ...(args.includes("--soak") ? [step("eval:soak")] : []),
    step(REPORT),
  ];
}

/** Runs one step, and says whether it worked. */
export type StepRunner = (step: EvalStep) => Promise<boolean>;

const nameOf = (one: EvalStep): string => [one.script, ...one.args].join(" ");

export async function runAll(
  steps: EvalStep[],
  run: StepRunner,
  print: (line: string) => void,
): Promise<number> {
  const failed: string[] = [];
  for (const one of steps) {
    const name = nameOf(one);
    if (one.script === REPORT && failed.length > 0) {
      print(`\nskipped ${REPORT}: RESULTS.md was left as it was`);
      continue;
    }
    print(`\n== ${name}`);
    const started = Date.now();
    const ok = await run(one).catch(() => false);
    print(`== ${name}: ${ok ? "ok" : "FAILED"} in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    if (!ok) failed.push(name);
  }
  if (failed.length === 0) return 0;
  print(`\neval:all failed: ${failed.join(", ")}`);
  return 1;
}

const runWithPnpm: StepRunner = (one) =>
  new Promise((done, reject) => {
    const child = spawn("pnpm", ["--silent", one.script, ...one.args], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => done(code === 0));
  });

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  return runAll(stepsFor(args), runWithPnpm, (line) => process.stdout.write(`${line}\n`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (status) => process.exit(status),
    (error: unknown) => {
      process.stderr.write(
        `eval:all failed: ${(error as Error).message}\nusage: pnpm eval:all [--live] [--soak]\n`,
      );
      process.exit(2);
    },
  );
}

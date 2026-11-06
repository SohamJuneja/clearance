/**
 * `pnpm eval:mutations`: takes each control in index.ts away, on isolated processes, and checks that its case really
 * notices. Writes eval/out/authority-mutations.json, which isn't a row in RESULTS.md: it's evidence that E1 means
 * something. Exit 1 if a mutation doesn't do what it says, because then a case is passing for the wrong reason.
 *
 *   pnpm eval:mutations                        all of them
 *   pnpm eval:mutations --only no-owner-exclusion,f1-unknown-requester-needs-one
 */
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../../lib/paths.ts";
import { AUDIT_CHECKS } from "../audit.ts";
import { CASES } from "../cases.ts";
import { runCheck } from "../execute.ts";
import { applyEdits, MUTATIONS, type Mutation, type SourceEdit } from "./index.ts";

const COPIED_PACKAGES = ["core", "adapters"];
const LINKED_PACKAGES = ["contracts", "gate", "switch-agent"];

/** A copy of core with these edits, under `.tmp/`, sharing node_modules. Returns the entry point to run. */
export function buildMutant(id: string, edits: SourceEdit[]): string {
  const tree = join(REPO_ROOT, ".tmp", "eval-mutants", id);
  rmSync(tree, { recursive: true, force: true });
  for (const name of COPIED_PACKAGES) {
    const from = join(REPO_ROOT, "packages", name);
    const to = join(tree, "packages", name);
    cpSync(join(from, "src"), join(to, "src"), { recursive: true });
    cpSync(join(from, "package.json"), join(to, "package.json"));
    symlinkSync(join(from, "node_modules"), join(to, "node_modules"));
  }
  for (const name of LINKED_PACKAGES) {
    symlinkSync(join(REPO_ROOT, "packages", name), join(tree, "packages", name));
  }
  symlinkSync(join(REPO_ROOT, "node_modules"), join(tree, "node_modules"));
  const entry = join(tree, "eval/harness/core-main.ts");
  mkdirSync(dirname(entry), { recursive: true });
  cpSync(join(REPO_ROOT, "eval/harness/core-main.ts"), entry);
  for (const file of new Set(edits.map((edit) => edit.file))) {
    const path = join(tree, file);
    const mine = edits.filter((edit) => edit.file === file);
    writeFileSync(path, applyEdits(readFileSync(path, "utf8"), mine, file));
  }
  return entry;
}

export interface MutationResult {
  id: string;
  target: number | string;
  removes: string;
  expected: Mutation["expect"];
  got: Mutation["expect"];
  ok: boolean;
  bad_outcomes: string[];
  because?: string;
}

async function runMutation(mutation: Mutation): Promise<MutationResult> {
  const check = [...CASES, ...AUDIT_CHECKS].find((one) => one.id === mutation.target);
  if (!check) throw new Error(`${mutation.id} targets ${mutation.target}, which doesn't exist`);
  const coreEntry = mutation.source ? buildMutant(mutation.id, mutation.source) : undefined;
  const result = await runCheck(check, {
    coreEntry,
    onlyVariant: mutation.variant,
    policy: mutation.policy
      ? (yaml) => applyEdits(yaml, mutation.policy ?? [], "the policy file")
      : undefined,
  });
  // "Flips" means the bad outcome itself happened. A control that merely failed isn't that.
  const got = result.badOutcomes.length > 0 ? "flips" : "still holds";
  return {
    id: mutation.id,
    target: mutation.target,
    removes: mutation.removes,
    expected: mutation.expect,
    got,
    ok: got === mutation.expect,
    bad_outcomes: result.badOutcomes,
    ...(mutation.because ? { because: mutation.because } : {}),
  };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const onlyArg = args[args.indexOf("--only") + 1];
  const only = args.includes("--only") ? new Set((onlyArg ?? "").split(",")) : undefined;
  const chosen = only ? MUTATIONS.filter((one) => only.has(one.id)) : MUTATIONS;
  const results: MutationResult[] = [];
  for (const mutation of chosen) {
    const result = await runMutation(mutation);
    results.push(result);
    process.stdout.write(
      `${result.ok ? "ok  " : "FAIL"} ${String(result.target).padStart(2)}  ${result.got.padEnd(12)} ${result.id}: without ${result.removes}\n`,
    );
    if (result.bad_outcomes.length > 0) {
      process.stdout.write(`        ${result.bad_outcomes.join("; ")}\n`);
    } else if (result.because) {
      process.stdout.write(`        ${result.because}\n`);
    }
  }
  rmSync(join(REPO_ROOT, ".tmp", "eval-mutants"), { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok);
  process.stdout.write(
    `\n${results.length - failed.length} of ${results.length} did what they say\n`,
  );
  if (!only) {
    const directory = join(REPO_ROOT, "eval/out");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "authority-mutations.json"),
      `${JSON.stringify({ experiment: "E1-mutations", measured_at: new Date().toISOString(), results }, null, 2)}\n`,
    );
    process.stdout.write("wrote eval/out/authority-mutations.json\n");
  }
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (status) => process.exit(status),
    (error: unknown) => {
      process.stderr.write(`eval:mutations failed: ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}

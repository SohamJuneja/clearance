/**
 * `pnpm eval:classifier:label --name <you> [--file eval/out/to-label.jsonl]`: label E3's sample one key at a time.
 * Answers go to a file of your own beside the pack, line by line, so you can stop and pick up again. The guide is
 * eval/classifier/LABELLING.md. It shows only what the call does, never what Clearance decided.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { REPO_ROOT } from "../lib/paths.ts";
import { parseLabels, RESOLVED } from "./metrics.ts";

const PackRowSchema = z.object({
  id: z.string().min(1),
  at: z.string(),
  agent: z.string(),
  vendor: z.string(),
  kind: z.string(),
  what: z.string(),
});
export type PackRow = z.infer<typeof PackRowSchema>;

export function readPack(text: string): PackRow[] {
  return text
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, number }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`pack line ${number} is not JSON`);
      }
      const row = PackRowSchema.safeParse(parsed);
      if (!row.success)
        throw new Error(`pack line ${number}: ${row.error.issues[0]?.path.join(".")} is missing`);
      return row.data;
    });
}

export type Step =
  | { kind: "label"; label: "risky" | "safe" }
  | { kind: "undo" }
  | { kind: "quit" }
  | { kind: "ignore" };

export function stepFor(key: string): Step {
  if (key === "r") return { kind: "label", label: "risky" };
  if (key === "s") return { kind: "label", label: "safe" };
  if (key === "u") return { kind: "undo" };
  if (key === "q" || key === "\u0003") return { kind: "quit" };
  return { kind: "ignore" };
}

export function cardFor(row: PackRow, position: number, total: number): string {
  return `\n${position} of ${total}   ${row.agent} on ${row.vendor}, ${row.kind}\n\n  ${row.what}\n\n[r] risky   [s] safe   [u] undo   [q] stop for now\n`;
}

export function labelsFileFor(packPath: string, name: string): string {
  if (name === RESOLVED)
    throw new Error(`"${RESOLVED}" is kept for settling disagreements. Use your own name`);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("give your name in letters, like --name soham");
  return `${packPath.replace(/\.jsonl$/, "")}.${name}.labels.jsonl`;
}

const readLines = (file: string): string[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
    : [];

export function readDone(file: string): Set<string> {
  return new Set(parseLabels(readLines(file).join("\n")).map((label) => label.id));
}

export function nextUp(pack: PackRow[], done: Set<string>): PackRow | undefined {
  return pack.find((row) => !done.has(row.id));
}

export function addLabel(
  file: string,
  id: string,
  label: "risky" | "safe",
  labeller: string,
): void {
  const other = parseLabels(readLines(file).join("\n")).find((one) => one.labeller !== labeller);
  if (other)
    throw new Error(`${file} holds ${other.labeller}'s answers. Labels are one person's each`);
  appendFileSync(file, `${JSON.stringify({ id, label, labeller })}\n`);
}

/** Takes back the last answer and says whose call it was, or undefined with nothing to take back. */
export function undoLast(file: string): string | undefined {
  const lines = readLines(file);
  const last = lines.pop();
  if (last === undefined) return undefined;
  writeFileSync(file, lines.map((line) => `${line}\n`).join(""));
  return parseLabels(last)[0]?.id;
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2).filter((arg) => arg !== "--");
  const name = flag(argv, "--name") ?? "";
  const pack = resolve(flag(argv, "--file") ?? join(REPO_ROOT, "eval/out/to-label.jsonl"));
  const file = labelsFileFor(pack, name);
  const rows = readPack(readFileSync(pack, "utf8"));
  if (!process.stdin.isTTY) throw new Error("this needs a terminal, because it reads single keys");
  const key = (): Promise<string> =>
    new Promise((done) => process.stdin.once("data", (data) => done(data.toString())));
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    for (;;) {
      const done = readDone(file);
      const row = nextUp(rows, done);
      if (!row) {
        process.stdout.write(`\nAll ${rows.length} labelled. Send ${file}.\n`);
        return 0;
      }
      process.stdout.write(cardFor(row, done.size + 1, rows.length));
      let answered = false;
      while (!answered) {
        const step = stepFor(await key());
        if (step.kind === "quit") {
          process.stdout.write(`\nStopped at ${done.size} of ${rows.length}. Run it again to go on.\n`);
          return 0;
        }
        if (step.kind === "label") addLabel(file, row.id, step.label, name);
        if (step.kind === "undo") undoLast(file);
        answered = step.kind !== "ignore";
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (status) => process.exit(status),
    (error: unknown) => {
      process.stderr.write(`eval:classifier:label failed: ${(error as Error).message}\n`);
      process.exit(1);
    },
  );
}

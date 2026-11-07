/**
 * `pnpm eval:publish`: copies the results in gitignored eval/out to eval/results, so anyone can read what each number
 * came from on a fresh clone, and `pnpm eval:report` works from them with nothing run.
 *
 * Tool calls and chat can carry anything, so it stops without writing if a file holds a known secret value or anything
 * shaped like a real key. It names the file and never the value.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "./cross-vendor/transcripts.ts";
import { knownSecrets } from "./lib/secrets.ts";
import { REPO_ROOT } from "./lib/paths.ts";

/** What stays private: blind labelling packs and people's answers, and a probe that isn't a result. */
const NOT_PUBLISHED = /^to-label|\.labels\.jsonl$|^vendors-probe\.json$/;
const PUBLISHED = /\.(?:json|jsonl)$/;

export function filesToPublish(names: string[]): string[] {
  return names.filter((name) => PUBLISHED.test(name) && !NOT_PUBLISHED.test(name)).sort();
}

export function secretIn(text: string, known: string[]): boolean {
  return redact(text, known).count > 0;
}

export interface PublishOutcome {
  copied: string[];
  refused: string[];
}

export function publishResults(from: string, to: string, known: string[]): PublishOutcome {
  if (!existsSync(from)) return { copied: [], refused: [] };
  const names = filesToPublish(
    readdirSync(from, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );
  const refused = names.filter((name) => secretIn(readFileSync(join(from, name), "utf8"), known));
  if (refused.length > 0) return { copied: [], refused };
  mkdirSync(to, { recursive: true });
  for (const name of names) copyFileSync(join(from, name), join(to, name));
  return { copied: names, refused: [] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outcome = publishResults(join(REPO_ROOT, "eval/out"), join(REPO_ROOT, "eval/results"), knownSecrets());
  if (outcome.refused.length > 0) {
    process.stderr.write(`Nothing published: a secret is in ${outcome.refused.join(", ")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`published ${outcome.copied.length} files to eval/results: ${outcome.copied.join(", ")}\n`);
  }
}

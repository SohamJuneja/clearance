/**
 * Fills `{{E1}}`-style tokens in drafts meant for people, from the files in eval/out, so nobody types a number by hand.
 * It refuses when a sentence around a token would stop being true, and writes nothing if anything is missing.
 *
 *   pnpm numbers:fill       docs/blog.md, docs/social-posts.md and SUBMISSION.md, from their drafts
 *
 * The repo link comes from `CLEARANCE_REPO_URL`, or else from the `origin` remote.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface NumberSources {
  authority: { clearance: { prevented: number; total: number }; audit: { passed: number; total: number } };
  autonomy: {
    synthetic: boolean;
    human_decisions_per_100: { before: number; after: number };
    original_rule: {
      human_decisions_per_100: { after: number };
      second_week: { actions: number; demoted_at_action: number | null };
    };
  };
  baseline: {
    summary: {
      t77: { attempted: number; runs: number };
      full_refund: {
        auto: { paid: number; runs: number };
        ask: { paid: number; runs: number; cards: number; pressed_by: Record<string, number> };
      };
    };
  };
  repoUrl: string;
}

export function valuesFrom(sources: NumberSources): Record<string, string> {
  const { authority, autonomy, baseline, repoUrl } = sources;
  const t77 = baseline.summary.t77;
  // The drafts say the agent never tried it, that all the review's breaks are fixed, and that the original rule demoted.
  if (t77.attempted !== 0) throw new Error(`the agent attempted T-77 in ${t77.attempted} runs, and the blog says it never did`);
  const { auto, ask } = baseline.summary.full_refund;
  if (Object.keys(ask.pressed_by).some((person) => person !== "priya")) {
    throw new Error("someone other than Priya pressed a baseline card, and the blog says Priya pressed them all");
  }
  if (authority.audit.passed !== authority.audit.total) {
    throw new Error(`audit: ${authority.audit.passed} of ${authority.audit.total} pass, and the drafts say all are fixed`);
  }
  if (!autonomy.synthetic) throw new Error("the autonomy week isn't labelled synthetic, and the drafts call it that");
  const original = autonomy.original_rule;
  const demotedAt = original.second_week.demoted_at_action;
  if (demotedAt === null) throw new Error("the original rule never demoted the agent, and the blog says it did");
  if (!repoUrl) throw new Error("no repo link: set CLEARANCE_REPO_URL or add the origin remote");
  return {
    E1: `${authority.clearance.prevented} of ${authority.clearance.total}`,
    AUDIT_BREAKS: String(authority.audit.total),
    E6_BEFORE: String(autonomy.human_decisions_per_100.before),
    E6_AFTER: String(autonomy.human_decisions_per_100.after),
    E6_ORIGINAL: String(original.human_decisions_per_100.after),
    E6_ORIGINAL_DEMOTION: `at action ${demotedAt} of ${original.second_week.actions}`,
    T77_RUNS: String(t77.runs),
    BL_AUTO: `${auto.paid} of ${auto.runs}`,
    BL_ASK: `${ask.paid} of ${ask.runs}`,
    BL_ASK_CARDS: String(ask.cards),
    REPO_URL: repoUrl,
  };
}

export function fill(draft: string, values: Record<string, string>): string {
  const withoutNotes = draft.replace(/^<!--[\s\S]*?-->\n*/gm, "");
  const missing = new Set<string>();
  const filled = withoutNotes.replace(/\{\{(\w+)\}\}/g, (_, token: string) => {
    const value = values[token];
    if (value === undefined) missing.add(token);
    return value ?? "";
  });
  if (missing.size > 0) throw new Error(`no value for ${[...missing].join(", ")}`);
  return filled;
}

const PAIRS = [
  ["docs/blog-draft.md", "docs/blog.md"],
  ["docs/social-draft.md", "docs/social-posts.md"],
  ["docs/submission-draft.md", "SUBMISSION.md"],
] as const;

function repoUrl(root: string): string {
  if (process.env.CLEARANCE_REPO_URL) return process.env.CLEARANCE_REPO_URL;
  try {
    return execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8", stdio: "pipe" })
      .trim()
      .replace(/^git@github\.com:/, "https://github.com/")
      .replace(/\.git$/, "");
  } catch {
    return "";
  }
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const read = <T>(name: string): T => JSON.parse(readFileSync(join(root, "eval/out", name), "utf8")) as T;
  const values = valuesFrom({
    authority: read("authority.json"),
    autonomy: read("autonomy.json"),
    baseline: read("baseline.json"),
    repoUrl: repoUrl(root),
  });
  const outputs = PAIRS.map(([from, to]) => [to, fill(readFileSync(join(root, from), "utf8"), values)] as const);
  for (const [to, text] of outputs) {
    writeFileSync(join(root, to), text);
    console.log(`wrote ${to}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

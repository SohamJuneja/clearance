/**
 * `pnpm eval:behaviour`: E2's behaviour metric, scored from sessions that already happened. Starts no agent. Reads
 * Claude Code's transcripts for refunds-agent and OpenCode's session database, read-only, and writes
 * eval/out/behaviour.json. Counts only: no command or message text reaches the output.
 *
 * With no holds on this machine it writes nothing, and the report keeps showing a blank.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../lib/paths.ts";
import {
  claudeEvents,
  type Hold,
  holdsIn,
  type OpenCodePart,
  openCodeEvents,
  summariseHolds,
} from "./after-hold.ts";

const CLAUDE_TRANSCRIPTS =
  ".claude/projects/-home-prashant--switch-agents-127-0-0-1-8000-refunds-agent";
const OPENCODE_DATABASE = ".local/share/opencode/opencode.db";

export function claudeHolds(directory: string): Hold[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(directory, name))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
    .flatMap((path) =>
      holdsIn(basename(path).slice(0, 8), claudeEvents(readFileSync(path, "utf8"))),
    );
}

export function openCodeHolds(database: string): Hold[] {
  if (!existsSync(database)) return [];
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const sessions = db
      .prepare("select id from session where directory like '%/ops-agent' order by time_created")
      .all() as { id: string }[];
    const parts = db.prepare("select data from part where session_id = ? order by time_created");
    return sessions.flatMap(({ id }) => {
      const rows = parts.all(id) as { data: string }[];
      return holdsIn(
        id.slice(0, 12),
        openCodeEvents(rows.map((row) => JSON.parse(row.data) as OpenCodePart)),
      );
    });
  } finally {
    db.close();
  }
}

function main(): number {
  const claude = claudeHolds(join(homedir(), CLAUDE_TRANSCRIPTS));
  const opencode = openCodeHolds(join(homedir(), OPENCODE_DATABASE));
  const holds = [...claude, ...opencode];
  const output = join(REPO_ROOT, "eval/out/behaviour.json");
  if (holds.length === 0) {
    rmSync(output, { force: true });
    process.stdout.write("no holds in any recorded session, so there's nothing to report yet\n");
    return 0;
  }
  const all = summariseHolds(holds);
  mkdirSync(join(REPO_ROOT, "eval/out"), { recursive: true });
  writeFileSync(
    output,
    `${JSON.stringify(
      {
        experiment: "E2-behaviour",
        ...all,
        by_vendor: { claude: summariseHolds(claude), opencode: summariseHolds(opencode) },
        rule: "what the agent ran after a hold and before the next message reached it",
        says_nothing_about: "a determined agent, which SC13 and the hook tests cover",
        per_hold: holds,
        measured_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  const line = (name: string, s: ReturnType<typeof summariseHolds>): string =>
    `${name}: ${s.holds} holds in ${s.sessions} sessions, tried another route ${s.tried_another_route}, waited ${s.waited}, ran nothing ${s.ran_nothing}, said the CLR id ${s.said_clr_while_waiting}`;
  process.stdout.write(`${line("Claude Code", summariseHolds(claude))}\n`);
  process.stdout.write(`${line("OpenCode", summariseHolds(opencode))}\n`);
  process.stdout.write(`${line("All", all)}\nwrote eval/out/behaviour.json\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`eval:behaviour failed: ${(error as Error).message}\n`);
    process.exit(1);
  }
}

/**
 * `pnpm eval:vendors:rescore`: E2's chat-based scores, worked out again from its saved transcripts.
 *
 *   pnpm eval:vendors:rescore                    from eval/results/e2-transcripts.jsonl. Needs no agent, stack or Mattermost.
 *   pnpm eval:vendors:rescore --export           first adds rooms the file doesn't have, read-only from Mattermost's database
 *     --rooms-since <ms>                         pairs runs that didn't record a room with the rooms made after this time
 *
 * It rewrites a run's card, safe-task and how-it-ended fields, and gives up a run the agent was still working in. It never
 * changes what a run measured in Acme, git or the ledger.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { REPO_ROOT } from "../lib/paths.ts";
import {
  type AvailabilityMap,
  loadIntents,
  type RunResult,
  summarise,
} from "./plan.ts";
import {
  matchRoomsToRuns,
  parseTranscripts,
  redact,
  rescoreAll,
  secretValuesIn,
  serialiseTranscripts,
  shadowPrediction,
  summariseEnds,
  type Transcript,
} from "./transcripts.ts";

const here = dirname(fileURLToPath(import.meta.url));
const print = (line: string): void => void process.stdout.write(`${line}\n`);

export const RESULTS_DIR = join(REPO_ROOT, "eval/results");
export const TRANSCRIPTS = join(RESULTS_DIR, "e2-transcripts.jsonl");
const OUT_FILE = join(REPO_ROOT, "eval/out/vendors.json");
const TRACKED_FILE = join(RESULTS_DIR, "vendors.json");
const CORPUS = join(REPO_ROOT, "eval/out/e3-corpus.sqlite");
const POSTGRES = "switch-postgres-1";

interface DbPost {
  channelid: string;
  createat: number;
  originalid: string;
  deleteat: number;
  type: string;
  username: string;
  message: string;
  props: { attachments?: { actions?: { name?: string }[] | null }[] | null } | null;
}

/** Read-only, and only ever Mattermost's own database in the Switch stack. */
function psql(query: string): string {
  return execFileSync(
    "docker",
    ["exec", POSTGRES, "psql", "-U", "postgres", "-d", "mattermost", "-At", "-c", query],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
}

function roomsSince(sinceMs: number): { id: string; firstAsk: string }[] {
  const rows = psql(`
    select row_to_json(t) from (
      select c.id, (select p.message from posts p where p.channelid = c.id and p.originalid = '' and p.type = ''
                    and p.message like '@%' order by p.createat limit 1) as "firstAsk"
      from channels c where c.createat >= ${Math.trunc(sinceMs)} order by c.createat) t`);
  return rows
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id: string; firstAsk: string });
}

function postsIn(rooms: string[]): Map<string, DbPost[]> {
  const list = rooms.map((id) => `'${id.replace(/[^a-z0-9]/gi, "")}'`).join(",");
  const rows = psql(`
    select row_to_json(t) from (
      select p.channelid, p.createat, p.originalid, p.deleteat, p.type, u.username, p.message, p.props::jsonb as props
      from posts p join users u on u.id = p.userid
      where p.channelid in (${list}) order by p.createat) t`);
  const out = new Map<string, DbPost[]>();
  for (const line of rows.split("\n").filter(Boolean)) {
    const post = JSON.parse(line) as DbPost;
    if (!out.has(post.channelid)) out.set(post.channelid, []);
    out.get(post.channelid)!.push(post);
  }
  return out;
}

/** Every value worth keeping out of a public file. The values are only ever compared here, never printed. */
function knownSecrets(): string[] {
  const values = new Set<string>();
  const fromEnvFile = (file: string): void => {
    if (!existsSync(file)) return;
    for (const value of secretValuesIn(readFileSync(file, "utf8"))) values.add(value);
  };
  fromEnvFile(join(REPO_ROOT, ".env"));
  const workspaces = join(homedir(), ".switch/agents");
  if (existsSync(workspaces)) {
    for (const host of readdirSync(workspaces)) {
      const hostDir = join(workspaces, host);
      for (const agent of readdirSync(hostDir, { withFileTypes: true })) {
        if (!agent.isDirectory()) continue;
        fromEnvFile(join(hostDir, agent.name, ".env"));
        const token = join(hostDir, agent.name, ".clearance/gate-token");
        if (existsSync(token)) values.add(readFileSync(token, "utf8").trim());
      }
    }
  }
  for (const file of ["data/hook-tokens.json", "data/gate-tokens.json"]) {
    const path = join(REPO_ROOT, file);
    if (!existsSync(path)) continue;
    // One file is token to agent and the other agent to token, so go by length: an agent's name is short.
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (key.length >= 24) values.add(key);
      if (typeof value === "string" && value.length >= 24) values.add(value);
    }
  }
  return [...values];
}

function toTranscript(run: RunResult, posts: DbPost[], secrets: string[]): { room: Transcript; redactions: number } {
  const live = posts.filter((post) => post.originalid === "" && post.deleteat === 0 && post.type === "");
  const prompt = live.find((post) => post.message.startsWith("@") && post.username === "priya");
  const start = prompt?.createat ?? live[0]?.createat ?? 0;
  let redactions = 0;
  const clean = (text: string): string => {
    const out = redact(text, secrets);
    redactions += out.count;
    return out.text;
  };
  const room: Transcript = {
      vendor: run.vendor,
      condition: run.condition,
      intent: run.intent,
      kind: run.kind,
      repeat: run.repeat,
      room: run.observation.room!,
      posts: live
        .filter((post) => post.createat >= start)
        .map((post) => ({
          at_s: Math.round((post.createat - start) / 100) / 10,
          who: post.username,
          text: clean(post.message),
          buttons: (post.props?.attachments ?? []).flatMap((attachment) =>
            (attachment.actions ?? []).flatMap((action) => (action.name ? [action.name] : [])),
          ),
        })),
  };
  return { room, redactions };
}

function readKept(): Transcript[] {
  return existsSync(TRANSCRIPTS) ? parseTranscripts(readFileSync(TRANSCRIPTS, "utf8")) : [];
}

function exportRooms(runs: RunResult[], sinceMs: number | undefined, intents: ReturnType<typeof loadIntents>): Transcript[] {
  const unpaired = runs.filter((run) => !run.observation.room);
  if (unpaired.length > 0) {
    if (sinceMs === undefined) {
      throw new Error(`${unpaired.length} runs recorded no room: pass --rooms-since to pair them`);
    }
    const ids = matchRoomsToRuns(unpaired, roomsSince(sinceMs), intents);
    unpaired.forEach((run, index) => {
      run.observation.room = ids[index]!;
    });
  }
  const kept = readKept();
  const have = new Set(kept.map((room) => room.room));
  const missing = runs.filter((run) => !have.has(run.observation.room!));
  if (missing.length === 0) return kept;
  const found = postsIn(missing.map((run) => run.observation.room!));
  const secrets = knownSecrets();
  let redactions = 0;
  const added = missing.map((run) => {
    const out = toTranscript(run, found.get(run.observation.room!) ?? [], secrets);
    redactions += out.redactions;
    return out.room;
  });
  const all = [...kept, ...added];
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(TRANSCRIPTS, serialiseTranscripts(all));
  print(`kept ${added.length} rooms in ${TRANSCRIPTS}, ${redactions} secret values taken out`);
  return all;
}

function readCalls(): { e2_run: string; would_decide: string | null }[] | null {
  if (!existsSync(CORPUS)) return null;
  const db = new DatabaseSync(CORPUS, { readOnly: true });
  try {
    return db.prepare("SELECT e2_run, would_decide FROM actions").all() as unknown as {
      e2_run: string;
      would_decide: string | null;
    }[];
  } finally {
    db.close();
  }
}

function main(): number {
  const argv = process.argv.slice(2).filter((arg) => arg !== "--");
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const source = existsSync(OUT_FILE) ? OUT_FILE : TRACKED_FILE;
  if (!existsSync(source)) {
    print("No E2 results to rescore.");
    return 1;
  }
  const file = JSON.parse(readFileSync(source, "utf8")) as Record<string, unknown> & {
    per_run: RunResult[];
    availability: AvailabilityMap;
  };
  const intents = loadIntents(join(here, "intents.yaml"));
  const since = value("--rooms-since");
  const rooms = argv.includes("--export")
    ? exportRooms(file.per_run, since ? Number(since) : undefined, intents)
    : readKept();
  const per_run = rescoreAll(file.per_run, rooms, intents);
  const calls = readCalls();
  const out = {
    ...file,
    ...summarise(per_run, file.availability, 20),
    ends: summariseEnds(per_run),
    ...(calls ? { shadow_prediction: shadowPrediction(per_run, calls) } : {}),
    rescored_from_transcripts: true,
    per_run,
  };
  const target = source === OUT_FILE ? OUT_FILE : TRACKED_FILE;
  writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
  print(`rescored ${per_run.length} runs into ${target}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

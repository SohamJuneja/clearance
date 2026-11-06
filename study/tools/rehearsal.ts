/**
 * One rehearsal of the in-Switch study on the live stack: a script plays p01 through Mattermost's REST
 * API, logging in with its one-time password and pressing and typing as a person would.
 *
 *   tsx study/tools/rehearsal.ts --results-dir /some/scratch/dir
 *
 * Everything it produces is SYNTHETIC: the bot runs with STUDY_DRY_RUN=1, and it refuses study/results.
 * The answers are scripted to reach every path, not to resemble anyone. No rate or time from a rehearsal
 * may be reported, and this prints none: it reports whether the study works, not how it came out.
 *
 * Beyond a clean run, it answers in every way a person might, has someone else try to answer, kills the
 * bot mid-session, and stays down past Switch's liveness window to see whether an open card survives.
 * Run `setup-study-accounts.ts --reset p01` afterwards to give the real p01 a clean room.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runStudyEval } from "../../eval/study/run";
import { clearanceTitle } from "../lib/cards";
import { loadStudyAccounts } from "../lib/accounts";
import { CONFIRM_REASK, DEBRIEF_THANKS, SWITCH_WELCOME, TYPE_TO_CONFIRM_HINT, switchBreakNotice } from "../lib/materials";
import { DEFAULT_RESULTS_DIR } from "../lib/results";
import { loadSet, type StudyRequest } from "../lib/sets";
import { mattermostEscape } from "../lib/switch-card";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MATTERMOST_URL = process.env.MATTERMOST_URL ?? "http://127.0.0.1:8065";
const DATA_DIR = resolve(process.env.CLEARANCE_DATA_DIR ?? resolve(REPO_ROOT, "data"));
/** Switch counts an agent gone once it has been silent this long (HEARTBEAT_TTL_SECONDS). */
const LIVENESS_WINDOW_MS = 30_000;
const PARTICIPANT = "p01";

const flag = process.argv.indexOf("--results-dir");
const resultsDir = flag >= 0 ? resolve(process.argv[flag + 1] ?? "") : "";
if (!resultsDir) throw new Error("--results-dir is required: a rehearsal never writes to study/results");
if (resultsDir === DEFAULT_RESULTS_DIR) throw new Error("refusing study/results: a rehearsal is synthetic");
mkdirSync(resultsDir, { recursive: true });
if (existsSync(resolve(resultsDir, `${PARTICIPANT}.jsonl`))) throw new Error(`${resultsDir} already holds a run: use an empty folder`);

const accounts = loadStudyAccounts(resolve(DATA_DIR, "study-accounts.json"));
const person = accounts.participants[PARTICIPANT];
if (!person) throw new Error(`${PARTICIPANT} is not provisioned`);
const secrets = JSON.parse(readFileSync(resolve(DATA_DIR, "secrets.json"), "utf8")) as { mattermostTokens: Record<string, string> };
const realResultsBefore = existsSync(DEFAULT_RESULTS_DIR) ? readdirSync(DEFAULT_RESULTS_DIR).sort().join(",") : "";

const say = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const problems: string[] = [];
const problem = (line: string) => {
  problems.push(line);
  say(`  PROBLEM: ${line}`);
};

// ── Mattermost, as a person ──────────────────────────────────────────────────

const login = await fetch(`${MATTERMOST_URL}/api/v4/users/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ login_id: person.mattermostUser, password: person.oneTimePassword }),
});
const token = login.headers.get("token");
if (!login.ok || !token) throw new Error(`${PARTICIPANT} could not log in with its one-time password: HTTP ${login.status}`);
say(`${PARTICIPANT} logged in with its one-time password`);

type Post = { id: string; message: string; create_at: number; user_id: string; type: string; props: { attachments?: { actions?: { id: string; name: string }[] }[] } };

async function api(method: string, path: string, json?: unknown, as = token!): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${MATTERMOST_URL}/api/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

async function posts(): Promise<Post[]> {
  const { body } = await api("GET", `/channels/${person!.channelId}/posts?per_page=200`);
  const { order, posts: all } = body as unknown as { order: string[]; posts: Record<string, Post> };
  return order.map((id) => all[id]!);
}

const postMessage = (message: string, as?: string) => api("POST", "/posts", { channel_id: person.channelId, message }, as);
const buttonsOf = (post: Post) => post.props.attachments?.flatMap((attachment) => attachment.actions ?? []) ?? [];
const isOpenCard = (post: Post) => /request `A\d+`/.test(post.message) && post.message.includes("Reply with `A");
const handleOf = (post: Post) => /request `(A\d+)`/.exec(post.message)![1]!;
const count = (all: Post[], body: string) => all.filter((post) => post.message === body).length;

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, ms = 45_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

// ── The bot, as a process that can be killed ─────────────────────────────────

let bot: ChildProcess | null = null;
const logFile = createWriteStream(resolve(resultsDir, "bot.log"), { flags: "a" });

function startBot(): void {
  bot = spawn(process.execPath, ["--import", "tsx", "study/bot/main.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, CLEARANCE_DATA_DIR: DATA_DIR, STUDY_RESULTS_DIR: resultsDir, STUDY_DRY_RUN: "1", STUDY_PARTICIPANTS: PARTICIPANT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bot.stdout?.pipe(logFile, { end: false });
  bot.stderr?.pipe(logFile, { end: false });
}

async function killBot(): Promise<void> {
  const running = bot;
  if (!running) return;
  bot = null;
  const gone = new Promise((done) => running.once("exit", done));
  running.kill("SIGKILL");
  await gone;
}

// ── What each card is ────────────────────────────────────────────────────────

const requests: StudyRequest[] = [...loadSet("practice").requests, ...loadSet("X").requests, ...loadSet("Y").requests];

function requestOn(post: Post): StudyRequest | undefined {
  return requests.find((request) => post.message.includes(mattermostEscape(clearanceTitle(request))) || post.message.includes(mattermostEscape(request.a.description)));
}

const audit = new Map<string, { title: string; buttons: number; wanted: number; kind: "approval" | "questions" }>();

/** Every card is checked the moment it is seen: a card with no buttons is what this rehearsal looks for. */
function inspect(post: Post, wanted: number): void {
  if (audit.has(post.id)) return;
  const buttons = buttonsOf(post).length;
  const title = post.message.split("\n").find((line) => line && !line.startsWith("@") && !line.startsWith("**")) ?? "?";
  audit.set(post.id, { title: title.slice(0, 80), buttons, wanted, kind: post.message.includes("**Questions**") ? "questions" : "approval" });
  if (buttons !== wanted) problem(`card ${handleOf(post)} "${title.slice(0, 60)}" has ${buttons} buttons, not ${wanted}`);
  if (post.message.includes("cannot be answered") || post.message.includes("Too long to show")) problem(`card ${handleOf(post)} says it can't be answered from chat`);
  if (post.message.includes("notified no one")) problem(`card ${handleOf(post)} says it notified no one`);
  if (!post.message.startsWith(`@${PARTICIPANT}\n`)) problem(`card ${handleOf(post)} does not name ${PARTICIPANT}`);
}

async function nextOpenCard(after: Set<string>): Promise<Post> {
  return waitFor("the next card", async () => {
    const all = await posts();
    return all.find((post) => isOpenCard(post) && !after.has(post.id));
  });
}

async function press(post: Post, label: string): Promise<void> {
  const button = buttonsOf(post).find((entry) => entry.name.endsWith(label));
  if (!button) {
    problem(`card ${handleOf(post)} has no "${label}" button: ${JSON.stringify(buttonsOf(post).map((entry) => entry.name))}`);
    throw new Error("cannot go on without the button");
  }
  const res = await api("POST", `/posts/${post.id}/actions/${button.id}`, {});
  if (res.status !== 200) problem(`pressing "${label}" answered HTTP ${res.status}`);
}

// ── The session ──────────────────────────────────────────────────────────────

startBot();
say("bot started");
const welcome = await waitFor("the welcome", async () => (await posts()).find((post) => post.message === SWITCH_WELCOME));
void welcome;
await sleep(1500);
if ((await posts()).filter((post) => isOpenCard(post)).length > 0) problem("a card was posted before the person said anything");
await postMessage("hello");
say("said hello");

const seen = new Set<string>();
const take = async (wanted: number): Promise<Post> => {
  const post = await nextOpenCard(seen);
  seen.add(post.id);
  inspect(post, wanted);
  return post;
};

// Before the first question: said to the person only once, however many times the bot starts.
// Consent, by button, on questions cards.
await press(await take(2), "I agree.");
await press(await take(3), "other");
await press(await take(5), "3");
await press(await take(1), "Start");
say("consent and briefing done");

let scored = 0;
let criticals = 0;
let foreignTried = false;
let killedWhileOpen = false;
let killedAndAnswered = false;
let longOutage = false;
let outageRequest: string | null = null;

for (let guard = 0; guard < 60; guard += 1) {
  const all = await waitFor("something to do", async () => {
    const current = await posts();
    const open = current.find((post) => isOpenCard(post) && !seen.has(post.id));
    const ended = current.some((post) => post.message.startsWith(DEBRIEF_THANKS));
    return open || ended ? current : undefined;
  });
  const card = all.find((post) => isOpenCard(post) && !seen.has(post.id));
  if (!card) break;
  const isQuestions = card.message.includes("**Questions**");
  const request = requestOn(card);
  const handle = handleOf(card);

  // A rating, or the last question.
  if (isQuestions && !request) {
    seen.add(card.id);
    if (card.message.includes("Which card helped")) {
      inspect(card, 1);
      // A person takes a moment. The bot treats anything sooner as being about the last card.
      await sleep(2500);
      await postMessage("Rehearsal comment. Synthetic, written by a script.");
      say("left a comment as a plain message");
    } else {
      inspect(card, 5);
      await press(card, "3");
      say("rated confidence");
    }
    continue;
  }
  if (!request) {
    problem(`a card matches no request: ${card.message.slice(0, 80)}`);
    seen.add(card.id);
    continue;
  }

  // Type-to-confirm: the trap first, then a wrong value, then the right one. The next one says no.
  if (isQuestions) {
    seen.add(card.id);
    inspect(card, 1);
    const confirm = request.b.confirm!;
    const attempts = (await posts()).filter((post) => post.message.includes(mattermostEscape(clearanceTitle(request)))).length;
    if (attempts === 1 && criticals === 0) {
      await sleep(2500);
      await postMessage(`${handle} ${confirm.expected.replace(/\D/g, "") || confirm.expected}`);
      await waitFor("the hint about quotes", async () => (count(await posts(), TYPE_TO_CONFIRM_HINT) > 0 ? true : undefined), 15_000);
      say(`typed ${handle} with no quotes: Switch ignored it and the bot explained`);
      await postMessage(`${handle} "not the value"`);
      await waitFor("the re-ask", async () => (count(await posts(), CONFIRM_REASK) > 0 ? true : undefined), 15_000);
      say("typed a wrong value: re-asked once");
    } else if (criticals === 0) {
      await postMessage(`${handle} "${confirm.expected}"`);
      criticals += 1;
      say("typed the right value");
    } else {
      await press(card, "No, deny");
      criticals += 1;
      say("pressed No on a type-to-confirm card");
    }
    continue;
  }

  seen.add(card.id);
  const options = buttonsOf(card).map((button) => button.name.replace(/^\d+\.\s*/, ""));
  inspect(card, options.length === 3 ? 3 : 2);
  const approveLabel = options[0]!;
  const denyLabel = options.at(-1)!;
  const isPractice = request.id.startsWith("P");
  if (!isPractice) scored += 1;

  // Someone else tries, by button and by typing, before the person answers.
  if (scored === 3 && !foreignTried) {
    foreignTried = true;
    const other = secrets.mattermostTokens.user!;
    const byButton = await api("POST", `/posts/${card.id}/actions/${buttonsOf(card)[0]!.id}`, {}, other);
    await postMessage(`${handle} yes`, other);
    await sleep(1500);
    const after = (await posts()).find((post) => post.id === card.id)!;
    if (!isOpenCard(after)) problem("someone else's answer closed the card");
    say(`someone else pressed (HTTP ${byButton.status}) and typed: card still open = ${isOpenCard(after)}`);
  }

  // Killed with this card open, and answered while down.
  if (scored === 5 && !killedAndAnswered) {
    killedAndAnswered = true;
    await killBot();
    say("killed the bot with a card open; answering while it is down");
    await press(card, denyLabel);
    await sleep(2000);
    startBot();
    say("bot restarted");
    continue;
  }

  // Killed with this card open, restarted, and the same card must be the one still up.
  if (scored === 8 && !killedWhileOpen) {
    killedWhileOpen = true;
    await killBot();
    await sleep(1000);
    startBot();
    await sleep(4000);
    const now = await posts();
    const copies = now.filter((post) => post.message.includes(mattermostEscape(request.a.description)) || post.message.includes(mattermostEscape(clearanceTitle(request))));
    if (copies.length !== 1) problem(`after a restart there are ${copies.length} copies of a card`);
    say(`killed and restarted with a card open: ${copies.length} copy of it, ${buttonsOf(copies[0]!).length} buttons`);
  }

  // Down long enough for Switch to count the agent as gone. Does the open card keep its buttons?
  if (scored === 15 && !longOutage) {
    longOutage = true;
    await killBot();
    say(`bot down for ${LIVENESS_WINDOW_MS / 1000 + 10} s, past Switch's liveness window`);
    await sleep(LIVENESS_WINDOW_MS + 10_000);
    const during = (await posts()).find((post) => post.id === card.id)!;
    const stillOpen = isOpenCard(during);
    say(`during the outage: ${buttonsOf(during).length} buttons, open = ${stillOpen}, says: ${JSON.stringify(during.message.split("\n").slice(-2).join(" / ").slice(0, 140))}`);
    if (buttonsOf(during).length !== options.length) say("  NOTE: this card lost its buttons while the bot was down");
    outageRequest = request.id;
    startBot();
    say("bot restarted");
    await waitFor("the card to come back", async () => {
      const back = (await posts()).find((post) => post.id === card.id)!;
      return buttonsOf(back).length === options.length ? true : undefined;
    }, 30_000).then(
      () => say("after the restart: the card has its buttons"),
      () => problem("a card did not get its buttons back after the bot returned"),
    );
  }

  // Answers in every way a person might. Scripted to reach each path; the choices mean nothing.
  if (scored % 5 === 2) await postMessage(`${handle} no`);
  else if (scored % 5 === 4) await postMessage(`${handle} 1`);
  else await press(card, scored % 2 === 0 ? denyLabel : approveLabel);
  await sleep(300);
}

await waitFor("the debrief", async () => ((await posts()).some((post) => post.message.startsWith(DEBRIEF_THANKS)) ? true : undefined), 60_000);
say("debrief posted");
await sleep(2500);
await killBot();

// ── What it shows ────────────────────────────────────────────────────────────

const finalPosts = await posts();
for (const body of [SWITCH_WELCOME, switchBreakNotice(30)]) {
  if (count(finalPosts, body) !== 1) problem(`"${body.slice(0, 40)}..." was posted ${count(finalPosts, body)} times`);
}
// Consent 3, briefing 1, practice 2, decisions 24, the one re-ask, ratings 2, comment 1. Any more is a double post.
const EXPECTED_CARDS = 34;
if (audit.size !== EXPECTED_CARDS) problem(`${audit.size} cards were posted, not ${EXPECTED_CARDS}`);
const lostButtons = [...audit.values()].filter((entry) => entry.buttons !== entry.wanted);

const lines = readFileSync(resolve(resultsDir, `${PARTICIPANT}.jsonl`), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
const types = (type: string) => lines.filter((line) => line.type === type).length;
if (lines.some((line) => line.synthetic !== true)) problem("a record is not marked synthetic");
if (lines.some((line) => line.platform !== "switch")) problem("a record does not say it came from Switch");
if (types("decision") !== 24) problem(`${types("decision")} decisions, not 24`);
if (new Set(lines.filter((line) => line.type === "decision").map((line) => line.request_id)).size !== 24) problem("a request was decided twice");
if (types("practice") !== 2) problem(`${types("practice")} practice answers, not 2`);
if (types("confidence") !== 2) problem(`${types("confidence")} ratings, not 2`);
if (lines.some((line) => (line.type === "decision" || line.type === "practice") && !(Number(line.ms) > 0))) problem("a decision has no positive time");
const outageDecision = lines.find((line) => line.type === "decision" && line.request_id === outageRequest);
if (outageDecision?.interrupted !== true) problem("the card that was up during the outage is not marked interrupted");
const interrupted = lines.filter((line) => line.type === "decision" && line.interrupted === true).map((line) => String(line.request_id));
if (interrupted.length !== 1) problem(`${interrupted.length} decisions are marked interrupted, not just the one that was up during the outage`);

const report = runStudyEval({ resultsDir, outFile: resolve(resultsDir, "study.json") });
if (!report.synthetic) problem("the analysis did not see this as synthetic");
if (report.headline !== null) problem("the analysis produced a headline from a rehearsal");
if (report.participants.completed !== 1) problem(`the analysis counted ${report.participants.completed} completed sessions`);

const realResultsAfter = existsSync(DEFAULT_RESULTS_DIR) ? readdirSync(DEFAULT_RESULTS_DIR).sort().join(",") : "";
if (realResultsAfter !== realResultsBefore) problem("something landed in study/results");

const auditFile = resolve(resultsDir, "bot-state", `${PARTICIPANT}.audit.ndjson`);
const audited = existsSync(auditFile)
  ? readFileSync(auditFile, "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { what: string }).what)
  : [];
const tally = (values: string[]) => Object.fromEntries([...new Set(values)].map((value) => [value, values.filter((entry) => entry === value).length]));

say("");
say("SYNTHETIC REHEARSAL. Scripted answers, so no rate or time here means anything, and none is printed.");
say(`cards seen: ${audit.size} (${[...audit.values()].filter((entry) => entry.kind === "approval").length} approval, ${[...audit.values()].filter((entry) => entry.kind === "questions").length} questions)`);
say(`cards that lost their buttons: ${lostButtons.length}`);
say(`cards posted, against the ${EXPECTED_CARDS} expected if nothing was doubled: ${audit.size}`);
say(`records: ${lines.length}: ${JSON.stringify(tally(lines.map((line) => String(line.type))))}`);
say(`bot's audit log: ${JSON.stringify(tally(audited))}`);
const hints = count(finalPosts, TYPE_TO_CONFIRM_HINT);
if (hints !== 1) problem(`the hint about quotes was posted ${hints} times, not once`);
const botLog = existsSync(resolve(resultsDir, "bot.log")) ? readFileSync(resolve(resultsDir, "bot.log"), "utf8") : "";
const complaints = botLog.split("\n").filter((line) => line && !line.includes("running 1 participants") && !line.includes("it was down for"));
say(`lines in the bot's log that are not routine: ${complaints.length}`);
for (const line of [...new Set(complaints)].slice(0, 6)) say(`  ${line.slice(0, 200)}`);
say(`analysis: "${report.label}" by_platform=${JSON.stringify(report.participants.by_platform)} completed=${report.participants.completed} headline=${JSON.stringify(report.headline)}`);
say(`study/results untouched: ${realResultsAfter === realResultsBefore}`);
say(problems.length === 0 ? "No problems." : `${problems.length} PROBLEMS:\n${problems.map((line) => `  - ${line}`).join("\n")}`);

await api("POST", "/users/logout", {});
logFile.end();
process.exit(problems.length === 0 ? 0 : 1);

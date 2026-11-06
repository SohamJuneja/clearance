/**
 * The Desk in a real browser: `pnpm desk:e2e`. Not part of `pnpm test`, because it needs Chromium.
 *
 * Part 1 runs the production build against a fake core and reads every number back off the screen, in
 * Chromium, against the fake core's own data. It also checks there is nothing to approve or deny with,
 * that the chain badge turns when the chain breaks, and that a dead core shows no numbers.
 * Part 1b opens a drill behind a page that is already up, and checks nothing a browser can see or fetch moves.
 * Part 2 measures how long the page takes to load, cold, at a realistic data size, on the fake core and
 * on the real clearance-core.
 * Part 3 runs fixture mode, checks the SYNTHETIC banner on every tab, and takes the 1920x1080 screenshots.
 *
 * Writes screenshots to docs/media/raw/desk (gitignored), or DESK_SHOTS.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { buildServer } from "../../core/src/api/server";
import { HISTORY_SEED, seedSyntheticHistory } from "../../core/src/autonomy/history";
import { chatMessage, gateRefund, makeHarness, PARTICIPANTS, REFUND_SC3 } from "../../core/test/harness";
import { httpCore } from "../src/server/core-source";
import { fixtureCore } from "../src/server/fixture";
import { createDeskServer } from "../src/server/server";
import { formatCount, formatLatency, formatPercent, formatRate } from "../src/web/format";
import { appendEntry, closeFakeDrill, FAKE_TOKEN, openFakeDrill, POLICY_FILE_HASH, startFakeCore, type FakeCore } from "../test/fake-core";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../..");
const DIST = resolve(here, "../dist");
const POLICY = resolve(REPO, "policy/clearance.policy.yaml");
const TEAM = resolve(REPO, "policy/team.yaml");
const SHOTS = process.env.DESK_SHOTS ?? resolve(REPO, "docs/media/raw/desk");
const TABS = ["queue", "ledger", "people", "autonomy", "coverage", "policy"] as const;
const LOAD_BUDGET_MS = 1000;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${!ok && detail ? `: ${detail}` : ""}`);
}
function same(name: string, got: unknown, expected: unknown): void {
  check(name, got === expected, `got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function realDesk(core: FakeCore): Server {
  return createDeskServer({ core: httpCore({ url: core.url, token: FAKE_TOKEN }), synthetic: false, distDir: DIST, policyPath: POLICY, teamPath: TEAM });
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}

const text = async (page: Page, id: string) => (await page.getByTestId(id).first().innerText()).trim();

async function visit(page: Page, base: string, tab: string, waitFor: string): Promise<void> {
  await page.goto(`${base}/#/${tab}`);
  await page.getByTestId(waitFor).first().waitFor({ timeout: 8000 });
}

/** Watches a page for anything that should never happen on it. */
function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

async function checkNumbers(browser: Browser): Promise<void> {
  console.log("\nPart 1: every number on screen against the fake core");
  const core = await startFakeCore();
  const desk = realDesk(core);
  const base = await listen(desk);
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const problems = watch(page);
  const { data } = core;

  // Queue
  await visit(page, base, "queue", "queue-table");
  same("queue: open count is what core lists", await text(page, "queue-open"), "2");
  check("queue: says a card still needs an answer, whatever this list shows", (await page.locator(".page-head").innerText()).includes("still needs your answer"));
  same("queue: critical count", await text(page, "queue-critical"), "1");
  same("queue: escalated count", await text(page, "queue-escalated"), "1");
  same("queue: escalation step", await text(page, "queue-escalation-CLR-0011"), "Step 1 of 3");
  same("queue: score", await text(page, "queue-score-CLR-0011"), "Score 71");
  same("queue: headline", await text(page, "queue-headline-CLR-0011"), "REFUND ₹43,219");
  check("queue: handles to answer with", (await text(page, "queue-waiting-CLR-0011")).includes("A17"));
  check("queue: an age that ticks", /^\d+m \d\ds$/.test(await text(page, "queue-age-CLR-0011")));
  same("queue: no banner in real mode", await page.getByTestId("synthetic-banner").count(), 0);
  same("queue: core shown as connected", (await text(page, "core-status")).includes("Core connected"), true);

  // Ledger
  await page.getByTestId("tab-ledger").click();
  await page.getByTestId("ledger-table").waitFor();
  check("ledger: chain badge is core's", (await text(page, "chain-badge")).includes(`Chain intact through entry ${data.verify.count}`));
  same("ledger: row count", await text(page, "ledger-count"), `${data.ledger.length} of ${data.ledger.length}`);
  await page.getByTestId("filter-type").selectOption("held");
  same("ledger: filter by type", await text(page, "ledger-count"), `3 of ${data.ledger.length}`);
  await page.getByRole("button", { name: "Clear" }).click();
  same("ledger: Clear works", await text(page, "ledger-count"), `${data.ledger.length} of ${data.ledger.length}`);
  same("ledger: Clear goes away once cleared", await page.getByRole("button", { name: "Clear" }).count(), 0);
  await page.getByTestId("filter-request").fill("CLR-0011");
  same("ledger: filter by request", await text(page, "ledger-count"), `3 of ${data.ledger.length}`);
  await page.getByTestId("filter-request").fill("");
  await page.getByTestId("filter-text").fill("neha");
  same("ledger: filter by content", await text(page, "ledger-count"), `1 of ${data.ledger.length}`);
  await page.getByTestId("filter-text").fill("");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export CSV" }).click();
  same("ledger: the export downloads", (await download).suggestedFilename(), "clearance-ledger.csv");

  data.verify = { ok: false, count: 6, head: "x", firstBad: { seq: 7, reason: "entry_hash does not match the entry's contents" } };
  await page.getByText("Chain broken at entry 7").waitFor({ timeout: 8000 });
  check("ledger: the badge turns by itself when the chain breaks", (await text(page, "chain-badge")).includes("entry_hash does not match"));
  data.verify = { ok: true, count: 12, head: "hash12aabbccdd" };

  // Coverage
  await page.getByTestId("tab-coverage").click();
  await page.getByTestId("coverage-table").waitFor();
  for (const row of data.coverage) {
    const id = `coverage-${row.vendor}-${row.source}`;
    same(`coverage: ${id} calls`, await text(page, `${id}-calls`), formatCount(row.calls));
    same(`coverage: ${id} allowed`, await text(page, `${id}-allowed`), formatCount(row.allowed));
    same(`coverage: ${id} held`, await text(page, `${id}-held`), formatCount(row.held));
    same(`coverage: ${id} denied`, await text(page, `${id}-denied`), formatCount(row.denied));
  }
  same("coverage: total calls", await text(page, "coverage-total-calls"), formatCount(407));
  same("coverage: a silent vendor says so", await text(page, "coverage-opencode-hook"), "No traffic seen");

  // Autonomy
  await page.getByTestId("tab-autonomy").click();
  await page.getByTestId("autonomy-table").waitFor();
  for (const row of data.levels) same(`autonomy: ${row.agent}`, await text(page, `autonomy-level-${row.agent}-${row.class}-${row.bucket}`), row.level);
  same("autonomy: decisions per 100", await text(page, "load-per-100"), formatRate(data.humanLoad.per_100));
  same("autonomy: per 100 governed", await text(page, "load-per-100-governed"), formatRate(data.humanLoad.per_100_governed));
  same("autonomy: agent actions", await text(page, "load-actions"), formatCount(data.humanLoad.agent_actions));
  same("autonomy: human decisions", await text(page, "load-decisions"), formatCount(data.humanLoad.human_decisions));
  for (const row of data.humanLoad.by_class) same(`autonomy: ${row.class} per 100`, await text(page, `load-${row.class}-per-100`), formatRate(row.per_100));
  same("autonomy: a proposal's signatures", await text(page, "proposal-PRO-0003-signed"), "1 of 2");
  for (const row of data.buckets) {
    const id = `replay-${row.agent}-${row.class}-${row.bucket}`;
    same(`autonomy: ${id} counted`, await text(page, `${id}-counted`), `${row.counted} of ${row.needs.approvals}`);
    same(`autonomy: ${id} would run alone`, await text(page, `${id}-auto`), String(row.would_auto));
    same(`autonomy: ${id} denied`, await text(page, `${id}-denied`), String(row.denied));
  }
  await page.getByTestId("replay-scope").selectOption("ops-agent/deploy/staging");
  await page.getByTestId("replay-refunds-agent-refund-small").waitFor({ state: "detached" });
  same("autonomy: picking a scope replays just that one", await page.locator('[data-testid="replay-table"] tbody tr').count(), 1);
  same("autonomy: the replay reached core once, with the scope", core.seen.filter((call) => call.path === "/v1/autonomy/simulate").map((call) => call.body).join(), '{"agent":"ops-agent","class":"deploy","bucket":"staging"}');
  await page.getByTestId("replay-scope").selectOption("");
  await page.getByTestId("replay-refunds-agent-refund-small").waitFor();
  same("autonomy: back to every scope", await page.locator('[data-testid="replay-table"] tbody tr').count(), data.buckets.length);

  // People: the team view first, which must not even fetch one person's numbers
  const fetched: string[] = [];
  page.on("request", (request) => fetched.push(new URL(request.url()).pathname));
  await page.getByTestId("tab-people").click();
  await page.getByTestId("people-table").waitFor();
  const stats = Object.values(data.stats);
  const total = (key: "answers" | "approvals" | "denials" | "fast_approvals" | "flags_ignored" | "batch_approvals" | "streaks") => formatCount(stats.reduce((sum, row) => sum + row[key], 0));
  same("people: team answers", await text(page, "team-answers"), total("answers"));
  same("people: team approvals", await text(page, "team-approvals"), total("approvals"));
  same("people: team denials", await text(page, "team-denials"), total("denials"));
  same("people: team fast approvals", await text(page, "team-fast"), total("fast_approvals"));
  same("people: team flags ignored", await text(page, "team-flags"), total("flags_ignored"));
  same("people: team batch approvals", await text(page, "team-batch"), total("batch_approvals"));
  same("people: team streaks", await text(page, "team-streaks"), total("streaks"));
  same("people: everyone is listed", await page.locator('[data-testid^="people-row-"]').count(), data.people.length);
  same("people: the team view has nobody's own numbers", await page.locator('[data-testid^="person-"]').count(), 0);
  same("people: the team view has no admin banner", await page.getByTestId("people-admin-banner").count(), 0);
  same("people: the team view never fetched one person", fetched.filter((path) => /^\/api\/people\/./.test(path)).join(), "");

  await page.getByTestId("people-view").selectOption("sam");
  await page.getByTestId("people-admin-banner").waitFor();
  const banner = await text(page, "people-admin-banner");
  check("people: the admin's view says so, and who it is about", banner.includes("Admin's view of Sam") && banner.includes("Private to Sam and the team admin") && banner.includes("don't show this screen to the team"));
  const sam = data.stats.sam!;
  same("people: sam answers", await text(page, "person-answers"), String(sam.answers));
  same("people: sam latency", await text(page, "person-latency"), formatLatency(sam.median_latency_ms));
  same("people: sam fast approvals", await text(page, "person-fast"), String(sam.fast_approvals));
  same("people: sam flags ignored", await text(page, "person-flags"), String(sam.flags_ignored));
  same("people: sam batch approvals", await text(page, "person-batch"), String(sam.batch_approvals));
  same("people: sam streaks", await text(page, "person-streaks"), String(sam.streaks));
  same("people: sam caught", await text(page, "person-drills-caught"), String(sam.drills.caught));
  same("people: sam missed", await text(page, "person-drills-missed"), String(sam.drills.missed));
  same("people: sam catch rate", await text(page, "person-drills-rate"), formatPercent(sam.drills.catch_rate));
  check("people: sam's friction, in words", (await text(page, "person-friction")).includes("after fast approvals"));
  for (const [tier, row] of Object.entries(sam.by_tier)) {
    same(`people: sam ${tier} median`, await text(page, `person-tier-${tier}-latency`), formatLatency(row.median_latency_ms));
    same(`people: sam ${tier} answers`, await text(page, `person-tier-${tier}-answers`), String(row.answers));
  }
  const widths = await page.locator(".bar").evaluateAll((bars) => bars.map((bar) => bar.getBoundingClientRect().width));
  check("people: bars grow with the value, from one scale", widths.length === 4 && widths.every((width, index) => index === 0 || width >= widths[index - 1]!) && widths[3]! > widths[0]! * 3, JSON.stringify(widths));
  const barHeight = await page.locator(".bar").first().evaluate((bar) => bar.getBoundingClientRect().height);
  check("people: a bar is no thicker than 24 px", barHeight <= 24, String(barHeight));
  await page.getByTestId("tab-queue").click();
  await page.getByTestId("queue-table").waitFor();
  await page.getByTestId("tab-people").click();
  await page.getByTestId("people-table").waitFor();
  same("people: coming back starts on the team view", await page.getByTestId("people-admin-banner").count(), 0);

  // Policy
  await page.getByTestId("tab-policy").click();
  await page.getByTestId("policy-table").waitFor();
  check("policy: says core's version", (await text(page, "policy-hash")).includes("Core is enforcing version abc123de"));
  check("policy: explains the file differs, without an alarm", (await text(page, "policy-relation")).includes("Core's version is the one in force"));
  same("policy: a difference is not marked as bad", await page.locator(".status-bad").count(), 0);
  data.policy.hash = POLICY_FILE_HASH;
  await page.getByText("Core is enforcing this file").waitFor({ timeout: 8000 });
  same("policy: a match needs no explanation", await page.getByTestId("policy-relation").count(), 0);
  data.policy.hash = "c0ffee1234567890";
  const signedEntry = { seq: 13, at: new Date().toISOString(), type: "policy_loaded", request_id: null, payload: { hash: "c0ffee1234567890", source: "proposal", approved_by: ["sam", "alex"] }, prev_hash: "prev13", entry_hash: "hash13" };
  data.ledger.push(signedEntry);
  await page.getByText("Core is enforcing a signed version").waitFor({ timeout: 8000 });
  check("policy: names who signed, and says the file isn't rewritten", /Signed by Sam and Alex\..*doesn't write it back to the file/.test(await text(page, "policy-relation")));
  same("policy: a signed version is not marked as bad", await page.locator(".status-bad").count(), 0);
  await page.screenshot({ path: resolve(SHOTS, "state-policy-signed.png") });
  data.policy.pending = { proposal: "PRO-0005", hash: "ddeeff0011223344", signed_by: ["neha"], quorum: 2, detail: "Raises the refund limit" };
  await page.getByTestId("policy-pending").waitFor({ timeout: 8000 });
  same("policy: a pending change's signatures", await text(page, "policy-pending-signed"), "1 of 2 signed: Neha");
  await page.getByText("What it changes").click();
  same("policy: a pending change's detail", await text(page, "policy-pending-detail"), "Raises the refund limit");
  await page.screenshot({ path: resolve(SHOTS, "state-policy-pending.png"), fullPage: false });
  data.policy.pending = null;
  data.ledger = data.ledger.filter((entry) => entry !== signedEntry);
  data.policy.hash = "abc123def456";
  await page.getByTestId("simulator-run").click();
  await page.getByTestId("simulator-decision").waitFor();
  same("policy: simulator shows core's decision", await text(page, "simulator-decision"), "Hold");
  check("policy: simulator shows core's reason", (await page.getByTestId("simulator-result").innerText()).includes(String(data.simulation.reason)));
  same("policy: the simulator reached core once", core.seen.filter((call) => call.path === "/v1/policy/simulate").length, 1);
  await page.getByTestId("simulator-body").fill("{not json");
  await page.getByTestId("simulator-run").click();
  await page.getByText("not valid JSON").waitFor();
  check("policy: bad input is explained", true);

  // Nothing to act with, on any tab
  const actions: string[] = [];
  for (const tab of TABS) {
    await page.goto(`${base}/#/${tab}`);
    await page.waitForLoadState("networkidle");
    for (const element of await page.locator("button, a, [role=button]").all()) actions.push(`${tab}: ${(await element.innerText()).trim()}`);
  }
  const acting = actions.filter((action) => /\b(approve|deny|allow|decline|cancel|reject)\b/i.test(action));
  same("no approve, deny or cancel control on any tab", acting.join(" | "), "");
  same("every core call was a GET but the two simulations", core.seen.filter((call) => call.method !== "GET" && call.path !== "/v1/policy/simulate" && call.path !== "/v1/autonomy/simulate").length, 0);

  // A dead core shows no numbers
  await page.goto(`${base}/#/queue`);
  await page.getByTestId("queue-table").waitFor();
  core.forceStatus = 500;
  await page.getByTestId("error-panel").waitFor({ timeout: 10000 });
  same("core failing: the numbers are gone, not stale", await page.getByTestId("queue-open").count(), 0);
  // The header has its own poll, so it can follow the panel by a few seconds.
  await page.getByText("Core not reachable").waitFor({ timeout: 10000 });
  check("core failing: the header says so", true);
  await page.screenshot({ path: resolve(SHOTS, "state-core-failing.png") });
  core.forceStatus = null;
  await page.getByTestId("queue-table").waitFor({ timeout: 10000 });
  same("core back: it recovers by itself", await text(page, "queue-open"), "2");

  // The browser logs a line for each 4xx and 5xx this run causes on purpose: bad JSON, and core failing.
  const unexpected = problems.filter((problem) => !/status of (400|502)/.test(problem));
  same("no console errors, warnings or CSP violations", unexpected.join(" | "), "");

  // What a fresh real run shows first: nothing yet.
  core.data.ledger = [];
  core.data.requests = {};
  core.data.levels = [];
  core.data.proposals = [];
  core.data.buckets = [];
  core.data.coverage = [];
  core.data.evidence = { synthetic: 0, real: 0 };
  core.data.humanLoad = { agent_actions: 0, governed_actions: 0, human_decisions: 0, per_100: null, per_100_governed: null, by_class: [] };
  await page.goto(`${base}/#/queue`);
  await page.getByText("No open requests listed.").waitFor({ timeout: 8000 });
  await page.screenshot({ path: resolve(SHOTS, "state-empty-queue.png") });
  await page.getByTestId("tab-coverage").click();
  await page.getByTestId("coverage-table").waitFor();
  same("empty coverage: nobody is shown as covered", await text(page, "coverage-vendors-seen"), "0 of 4");
  await page.screenshot({ path: resolve(SHOTS, "state-empty-coverage.png") });
  await page.getByTestId("tab-autonomy").click();
  await page.getByText("Every agent is at L0, Always ask.").waitFor();
  same("empty autonomy: no traffic is a dash, not a rate of zero", await text(page, "load-per-100"), "–");
  await page.screenshot({ path: resolve(SHOTS, "state-empty-autonomy.png"), fullPage: true });
  await context.close();
  await stop(desk);
  await core.close();
}

/** An approver with a card in Switch opens the Desk beside it. Nothing here may tell them what that card is. */
async function checkDrillsInBrowser(browser: Browser): Promise<void> {
  console.log("\nPart 1b: a drill opens behind a page that is already up");
  const core = await startFakeCore();
  const desk = realDesk(core);
  const base = await listen(desk);
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const problems = watch(page);
  const { data } = core;
  const bodies: string[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/api/")) void response.text().then((body) => bodies.push(body), () => {});
  });
  const POLL_WAIT_MS = 3500;
  /** Everything on screen, without the ages that tick by themselves. */
  const screen = async () => (await page.locator("main").innerText()).replace(/\b\d+[hm] \d\d[ms]\b|\b\d+s\b/g, "#");
  const before: Record<string, string> = {};
  for (const [tab, ready] of [["queue", "queue-table"], ["ledger", "ledger-table"], ["people", "people-table"], ["autonomy", "autonomy-table"]] as const) {
    await visit(page, base, tab, ready);
    await page.waitForLoadState("networkidle");
    before[tab] = await screen();
  }
  await visit(page, base, "people", "people-table");
  await page.getByTestId("people-view").selectOption("sam");
  await page.getByTestId("people-admin-banner").waitFor();
  before.admin = await screen();

  openFakeDrill(data);
  appendEntry(data, "held", "CLR-0014", { agent: "refunds-agent", class: "refund", tier: "high" });
  data.requests["CLR-0014"] = { ...data.requests["CLR-0011"], id: "CLR-0014" };
  bodies.length = 0;

  await page.waitForTimeout(POLL_WAIT_MS);
  same("admin's view: nothing moved, though core's count of Sam's cards did", await screen(), before.admin);
  await visit(page, base, "queue", "queue-table");
  await page.waitForTimeout(POLL_WAIT_MS);
  same("queue: nothing moved", await screen(), before.queue);
  same("queue: the drill has no row", await page.getByTestId("queue-row-CLR-0013").count(), 0);
  await visit(page, base, "ledger", "ledger-table");
  await page.waitForTimeout(POLL_WAIT_MS);
  same("ledger: nothing moved", await screen(), before.ledger);
  same("ledger: no row after the last one before the drill", await page.getByTestId("ledger-row-13").count(), 0);
  same("ledger: core's type filter offers no drills", (await page.getByTestId("filter-type").innerText()).toLowerCase().includes("drill"), false);
  check("ledger: the badge stands still too", (await text(page, "chain-badge")).includes("Chain intact through entry 12"));
  await page.screenshot({ path: resolve(SHOTS, "state-ledger-during-drill.png") });
  await visit(page, base, "people", "people-table");
  same("people: nothing moved", await screen(), before.people);
  await visit(page, base, "autonomy", "autonomy-table");
  await page.waitForLoadState("networkidle");
  same("autonomy: nothing moved", await screen(), before.autonomy);
  await page.waitForTimeout(200);
  const fetched = bodies.join("\n");
  check("nothing fetched names the drill or its card", !/CLR-0013|A99|91,357/.test(fetched) && bodies.length > 5, `${bodies.length} bodies`);
  check("nothing fetched mentions a drill entry", !/drill_sent|drill_result/.test(fetched));

  await visit(page, base, "ledger", "ledger-table");
  // Part 1 clicks the link. This reads what the same link serves, because snap's Chromium keeps its downloads to itself.
  const csv = await page.evaluate(async () => (await fetch("/api/export.csv")).text());
  check("the export holds nothing of the drill", !/CLR-0013|drill_/.test(csv) && csv.includes("CLR-0011"), csv.slice(0, 400));

  closeFakeDrill(data);
  await page.getByTestId("ledger-row-15").waitFor({ timeout: 8000 });
  same("once it closes: the real entry is back, with the drill's numbers skipped", await page.getByTestId("ledger-row-13").count(), 0);
  same("once it closes: the drill's rows never appear", (await page.getByTestId("ledger-table").innerText()).includes("CLR-0013"), false);
  check("once it closes: the page says numbers can skip", (await page.locator(".page-head").innerText()).includes("so the numbers can skip"));
  same("no console errors", problems.join(" | "), "");
  await context.close();
  await stop(desk);
  await core.close();
}

async function measureLoad(browser: Browser): Promise<void> {
  console.log("\nPart 2: load time, cold, production build");
  const core = await startFakeCore();
  // A long-running demo's worth of ledger, and a core that takes a moment over each read.
  const filler = Array.from({ length: 1500 }, (_, index) => ({
    seq: index + 100,
    at: new Date().toISOString(),
    type: "answered",
    request_id: `CLR-${5000 + index}`,
    payload: { user_id: "sam", decision: "approve", latency_ms: 48_000, card_room: "!room", answered_by: "@sam:localhost" },
    prev_hash: "x".repeat(64),
    entry_hash: "y".repeat(64),
  }));
  core.data.ledger = [...core.data.ledger, ...filler];
  core.delayMs = 20;
  const desk = realDesk(core);
  const base = await listen(desk);

  const runs: { total: number; lcp: number }[] = [];
  for (let run = 0; run < 7; run += 1) {
    // A new context each time means an empty cache, so every load fetches everything.
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    const started = performance.now();
    await page.goto(`${base}/#/queue`);
    await page.getByTestId("queue-table").waitFor();
    const total = performance.now() - started;
    const lcp = await page.evaluate(
      () =>
        new Promise<number>((done) => {
          new PerformanceObserver((list) => done(list.getEntries().at(-1)?.startTime ?? 0)).observe({ type: "largest-contentful-paint", buffered: true });
        }),
    );
    runs.push({ total, lcp });
    await context.close();
  }
  const sorted = runs.map((run) => run.total).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const worst = sorted.at(-1)!;
  const lcp = runs.map((run) => run.lcp).sort((a, b) => a - b)[3]!;
  console.log(`  ${runs.length} cold loads to the Queue table with data, ${core.data.ledger.length} ledger entries, core delayed ${core.delayMs} ms per call`);
  console.log(`  median ${median.toFixed(0)} ms, worst ${worst.toFixed(0)} ms, median largest contentful paint ${lcp.toFixed(0)} ms`);
  check(`worst load is under ${LOAD_BUDGET_MS} ms`, worst < LOAD_BUDGET_MS, `${worst.toFixed(0)} ms`);
  await stop(desk);
  await core.close();
}

/** The same measure on the real core: its real SQLite, its real ledger, requests really held and denied. */
async function measureLoadOnRealCore(browser: Browser): Promise<void> {
  console.log("\nPart 2b: load time on the real clearance-core");
  const h = makeHarness();
  const app = buildServer(h.core, { internalToken: FAKE_TOKEN });
  const coreUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent handle the refunds"));
  for (let n = 0; n < 150; n += 1) {
    const held = await h.core.check(gateRefund({ ...REFUND_SC3, amount: 11_000 + n }));
    if (held.decision !== "hold") throw new Error(`expected a hold, got ${held.decision}`);
    const card = h.chat.cards.at(-2) ?? h.chat.cards.at(-1)!;
    await h.core.onApprovalOutcome({ sessionId: card.sessionId, switchRequestId: card.switchRequestId, kind: "approval", state: "answered", answer: "deny", answeredBy: PARTICIPANTS.sam, answeredAtMs: h.clock.nowMs() });
  }
  for (let n = 0; n < 5; n += 1) await h.core.check(gateRefund({ ...REFUND_SC3, amount: 20_000 + n }));
  const entries = h.core.stores.ledger.list().length;
  const open = h.core.health().open_requests;

  const desk = createDeskServer({ core: httpCore({ url: coreUrl, token: FAKE_TOKEN }), synthetic: false, distDir: DIST, policyPath: POLICY, teamPath: TEAM });
  const base = await listen(desk);
  const times: number[] = [];
  for (let run = 0; run < 7; run += 1) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    const started = performance.now();
    await page.goto(`${base}/#/queue`);
    await page.getByTestId("queue-table").waitFor();
    times.push(performance.now() - started);
    if (run === 0) same("real core: open count on screen is core's", await text(page, "queue-open"), String(open));
    await context.close();
  }
  times.sort((a, b) => a - b);
  console.log(`  ${times.length} cold loads, real core, ${entries} ledger entries, ${open} open requests`);
  console.log(`  median ${times[3]!.toFixed(0)} ms, worst ${times.at(-1)!.toFixed(0)} ms`);
  check(`real core: worst load is under ${LOAD_BUDGET_MS} ms`, times.at(-1)! < LOAD_BUDGET_MS, `${times.at(-1)!.toFixed(0)} ms`);

  // Autonomy reruns the replay on every poll, so it has to be cheap with the labelled history seeded.
  seedSyntheticHistory(h.core.stores.db, HISTORY_SEED, h.clock.nowMs());
  const polls: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now();
    const res = await fetch(`${base}/api/autonomy`);
    if (res.status !== 200) throw new Error(`/api/autonomy answered ${res.status}`);
    await res.text();
    polls.push(performance.now() - started);
  }
  polls.sort((a, b) => a - b);
  console.log(`  /api/autonomy with seeded history: median ${polls[2]!.toFixed(0)} ms, worst ${polls.at(-1)!.toFixed(0)} ms`);
  check("real core: an Autonomy poll stays well inside the poll interval", polls.at(-1)! < 1000, `${polls.at(-1)!.toFixed(0)} ms`);
  await stop(desk);
  await app.close();
  h.core.close();
  rmSync(h.dir, { recursive: true, force: true });
}

async function fixtureAndScreenshots(browser: Browser): Promise<void> {
  console.log("\nPart 3: fixture mode, banner and screenshots");
  const desk = createDeskServer({ core: fixtureCore({ policyPath: POLICY }), synthetic: true, distDir: DIST, policyPath: POLICY, teamPath: TEAM });
  const base = await listen(desk);
  mkdirSync(SHOTS, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const problems = watch(page);
  const first: Record<(typeof TABS)[number], string> = {
    queue: "queue-table",
    ledger: "ledger-table",
    people: "people-table",
    autonomy: "autonomy-table",
    coverage: "coverage-table",
    policy: "policy-table",
  };
  for (const tab of TABS) {
    await visit(page, base, tab, first[tab]);
    const banner = page.getByTestId("synthetic-banner");
    await banner.waitFor();
    const box = await banner.boundingBox();
    check(`${tab}: SYNTHETIC banner is on screen`, Boolean(box && box.y >= 0 && box.height > 20 && box.width > 1000));
    check(`${tab}: banner says synthetic`, (await banner.innerText()).startsWith("SYNTHETIC"));
    same(`${tab}: no sideways scroll at 1920 wide`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: resolve(SHOTS, `desk-${tab}.png`) });
  }
  await visit(page, base, "autonomy", first.autonomy);
  await page.screenshot({ path: resolve(SHOTS, "desk-autonomy-full.png"), fullPage: true });
  await visit(page, base, "policy", first.policy);
  await page.screenshot({ path: resolve(SHOTS, "desk-policy-full.png"), fullPage: true });
  for (const [person, shot] of [["sam", "desk-people-admin-sam.png"], ["neha", "desk-people-admin-neha.png"]] as const) {
    // Through another tab, because going to the same address changes nothing and would stay on the last person.
    await visit(page, base, "queue", first.queue);
    await visit(page, base, "people", first.people);
    await page.getByTestId("people-view").selectOption(person);
    await page.getByTestId("people-admin-banner").waitFor();
    same(`admin's view of ${person}: no sideways scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: resolve(SHOTS, shot), fullPage: true });
  }
  same("the tab title says synthetic too", (await page.title()).startsWith("SYNTHETIC"), true);
  same("the header does not claim a connected core", (await text(page, "core-status")).includes("No core"), true);
  same("fixture mode: no console errors", problems.join(" | "), "");
  console.log(`  screenshots in ${SHOTS}`);
  await context.close();

  // The video pipeline records a 1536x864 viewport at 1.25x (scripts/video/capture.ts).
  const video = await browser.newContext({ viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 });
  const videoPage = await video.newPage();
  for (const tab of TABS) {
    await visit(videoPage, base, tab, first[tab]);
    same(`${tab}: no sideways scroll at the video's 1536 wide`, await videoPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  }
  await visit(videoPage, base, "queue", first.queue);
  await videoPage.screenshot({ path: resolve(SHOTS, "video-queue.png") });
  await visit(videoPage, base, "autonomy", first.autonomy);
  await videoPage.screenshot({ path: resolve(SHOTS, "video-autonomy.png"), fullPage: true });
  await visit(videoPage, base, "people", first.people);
  await videoPage.getByTestId("people-view").selectOption("sam");
  await videoPage.getByTestId("people-admin-banner").waitFor();
  same("admin's view: no sideways scroll at the video's 1536 wide", await videoPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await videoPage.screenshot({ path: resolve(SHOTS, "video-people-admin.png") });
  await video.close();
  await stop(desk);
}

async function main(): Promise<void> {
  if (!existsSync(resolve(DIST, "index.html"))) throw new Error("no build: run pnpm desk:build first");
  const executablePath = process.env.CLEARANCE_CHROMIUM ?? (existsSync("/snap/bin/chromium") ? "/snap/bin/chromium" : undefined);
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  try {
    mkdirSync(SHOTS, { recursive: true });
    await checkNumbers(browser);
    await checkDrillsInBrowser(browser);
    await measureLoad(browser);
    await measureLoadOnRealCore(browser);
    await fixtureAndScreenshots(browser);
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? "\nAll browser checks passed." : `\n${failures} browser check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  // A check that throws leaves its servers listening, and they would keep the process alive.
  process.exit(1);
});

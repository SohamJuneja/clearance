/**
 * The Desk in a real browser: `pnpm desk:e2e`. Not part of `pnpm test`, because it needs Chromium.
 *
 * Part 1 runs the production build against a fake core and reads every number back off the screen, in
 * Chromium, against the fake core's own data. It also checks there is nothing to approve or deny with,
 * that the chain badge turns when the chain breaks, and that a dead core shows no numbers.
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
import { chatMessage, gateRefund, makeHarness, PARTICIPANTS, REFUND_SC3 } from "../../core/test/harness";
import { httpCore } from "../src/server/core-source";
import { fixtureCore } from "../src/server/fixture";
import { createDeskServer } from "../src/server/server";
import { formatCount, formatLatency } from "../src/web/format";
import { FAKE_TOKEN, startFakeCore, type FakeCore } from "../test/fake-core";

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
  same("queue: open count is core's", await text(page, "queue-open"), String(data.health.open_requests));
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
  check("ledger: chain badge is core's", (await text(page, "chain-badge")).includes(`Chain intact · ${data.verify.count} entries`));
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
  check("autonomy: replay says not available yet", (await text(page, "na-replay")).includes("Not available yet"));

  // People
  await page.getByTestId("tab-people").click();
  await page.getByTestId("people-table").waitFor();
  for (const [id, stats] of Object.entries(data.stats)) {
    same(`people: ${id} answers`, await text(page, `people-${id}-answers`), String(stats.answers));
    same(`people: ${id} approvals`, await text(page, `people-${id}-approvals`), String(stats.approvals));
    same(`people: ${id} denials`, await text(page, `people-${id}-denials`), String(stats.denials));
    same(`people: ${id} open cards`, await text(page, `people-${id}-open`), String(stats.open_cards));
    same(`people: ${id} latency`, await text(page, `people-${id}-latency`), formatLatency(stats.median_latency_ms));
  }
  await page.getByTestId("people-view").selectOption("sam");
  await page.getByTestId("people-inbox").waitFor();
  same("people: private view shows one person", await page.locator('[data-testid^="people-row-"]').count(), 1);
  check("people: private view lists their card", (await page.getByTestId("people-inbox").innerText()).includes("A17"));
  check("people: drills say not available yet", (await text(page, "na-drills")).includes("Not available yet"));

  // Policy
  await page.getByTestId("tab-policy").click();
  await page.getByTestId("policy-table").waitFor();
  check("policy: says the file is not what core loaded", (await text(page, "policy-hash")).includes("Core is enforcing abc123de"));
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
  same("every core call was a GET but the simulator", core.seen.filter((call) => call.method !== "GET" && call.path !== "/v1/policy/simulate").length, 0);

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
  same("core back: it recovers by itself", await text(page, "queue-open"), String(data.health.open_requests));

  // The browser logs a line for each 4xx and 5xx this run causes on purpose: bad JSON, and core failing.
  const unexpected = problems.filter((problem) => !/status of (400|502)/.test(problem));
  same("no console errors, warnings or CSP violations", unexpected.join(" | "), "");

  // What a fresh real run shows first: nothing yet.
  core.data.ledger = [];
  core.data.health.open_requests = 0;
  core.data.levels = [];
  core.data.coverage = [];
  await page.goto(`${base}/#/queue`);
  await page.getByText("Nothing is waiting on a person.").waitFor({ timeout: 8000 });
  await page.screenshot({ path: resolve(SHOTS, "state-empty-queue.png") });
  await page.getByTestId("tab-coverage").click();
  await page.getByTestId("coverage-table").waitFor();
  same("empty coverage: nobody is shown as covered", await text(page, "coverage-vendors-seen"), "0 of 4");
  await page.screenshot({ path: resolve(SHOTS, "state-empty-coverage.png") });
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
    await checkNumbers(browser);
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
  process.exitCode = 1;
});

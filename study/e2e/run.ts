/**
 * The Approval Lab in real browsers at phone size: `pnpm study:e2e`. Not part of `pnpm test`, because it needs them.
 *
 * It walks a whole participant through every screen, then does what real people do: reload, press back, open the
 * link twice, stop halfway, put the phone down for an hour, lose the network, double tap. Chromium, and WebKit when
 * Playwright has one here (CLEARANCE_WEBKIT, or the newest in its cache). STUDY_E2E_ENGINE=webkit runs just the one.
 *
 * Everything it writes is SYNTHETIC: the server is in rehearsal mode and writes to a temp folder. The answers are
 * scripted to reach every path, not to resemble anyone, so no rate or time from it may be reported, and it prints none.
 * Stills go to docs/media/raw/study (gitignored), or STUDY_SHOTS.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, devices, webkit, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "playwright-core";
import { runStudyEval } from "../../eval/study/run";
import { createLabServer, linkToken } from "../app/server";
import { loadSet } from "../lib/sets";

const REPO = resolve(import.meta.dirname, "../..");
const SHOTS = process.env.STUDY_SHOTS ?? resolve(REPO, "docs/media/raw/study");
const SECRET = randomBytes(24).toString("hex");
const BREAK_SECONDS = 3;
/** A tap sooner than this after a card appears is ignored on purpose, so a script waits like a person. */
const CARD_SETTLES_MS = 650;

type StudyEvent = Record<string, unknown>;

let failures = 0;
function check(name: string, good: boolean, detail = ""): void {
  if (!good) failures += 1;
  console.log(`${good ? "  ok  " : " FAIL "} ${name}${!good && detail ? `: ${detail}` : ""}`);
}

/** A newer WebKit than this Playwright expects still drives fine, so the newest in the cache will do. */
function findWebKit(): string | null {
  if (process.env.CLEARANCE_WEBKIT) return process.env.CLEARANCE_WEBKIT;
  const cache = resolve(homedir(), ".cache/ms-playwright");
  if (!existsSync(cache)) return null;
  const builds = readdirSync(cache).filter((name) => name.startsWith("webkit-")).sort();
  const newest = builds.at(-1);
  return newest && existsSync(resolve(cache, newest, "pw_run.sh")) ? resolve(cache, newest, "pw_run.sh") : null;
}

/** An editor installed as a snap leaks its library paths into this shell, and WebKit's network process dies on them. */
function withoutSnapEnvironment(): Record<string, string> {
  const leaks = ["SNAP", "GTK_", "GIO_", "GSETTINGS_", "GDK_", "LOCPATH", "XDG_DATA", "XDG_CONFIG", "LD_LIBRARY_PATH", "PANGO", "FONTCONFIG", "GI_", "__EGL"];
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !leaks.some((prefix) => key.startsWith(prefix)))) as Record<string, string>;
}

/** Everything a phone shows up: sideways scroll, targets too small to tap, text cut off. */
function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > width) found.push(`the page scrolls sideways: ${document.documentElement.scrollWidth} in ${width}`);
    for (const node of document.querySelectorAll<HTMLElement>("body *")) {
      const box = node.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right > width + 1) found.push(`${node.tagName}.${node.className} sticks out to ${Math.round(box.right)}`);
      const style = getComputedStyle(node);
      if (style.overflowX !== "visible" && node.scrollWidth > node.clientWidth + 1) found.push(`${node.tagName}.${node.className} cuts off text`);
    }
    for (const node of document.querySelectorAll<HTMLElement>("button, select, textarea, input")) {
      if (node.tagName === "INPUT" && (node as HTMLInputElement).type === "checkbox") continue;
      const box = node.getBoundingClientRect();
      if (box.height > 0 && box.height < 44) found.push(`${node.tagName} "${(node.innerText ?? "").slice(0, 20)}" is only ${Math.round(box.height)} px tall`);
      if (box.width > 0 && box.width < 44) found.push(`${node.tagName} "${(node.innerText ?? "").slice(0, 20)}" is only ${Math.round(box.width)} px wide`);
    }
    const agree = document.querySelector<HTMLElement>(".agree");
    if (agree && agree.getBoundingClientRect().height < 44) found.push("the consent checkbox's row is under 44 px tall");
    return [...new Set(found)];
  });
}

class Lab {
  readonly dir: string;
  private next = 1;
  private constructor(
    private readonly server: Server,
    readonly base: string,
    dir: string,
  ) {
    this.dir = dir;
  }

  static async start(): Promise<Lab> {
    const dir = mkdtempSync(join(tmpdir(), "study-e2e-"));
    const server = createLabServer({ resultsDir: dir, secret: SECRET, synthetic: true, breakSeconds: BREAK_SECONDS });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return new Lab(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir);
  }

  newParticipant = () => `p${String(this.next++).padStart(2, "0")}`;
  link = (who: string) => `${this.base}/p/${linkToken(who, SECRET)}`;
  api = (who: string) => `${this.base}/api/${linkToken(who, SECRET)}`;
  fileFor = (who: string) => resolve(this.dir, `${who}.jsonl`);

  events(who: string): StudyEvent[] {
    return existsSync(this.fileFor(who)) ? readFileSync(this.fileFor(who), "utf8").trim().split("\n").map((line) => JSON.parse(line) as StudyEvent) : [];
  }
  count = (who: string, type: string) => this.events(who).filter((event) => event.type === type).length;

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((done) => this.server.close(done));
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** A WebKit newer than this Playwright can hang on closing a tab, and that says nothing about the Lab. */
const closeSoon = (closing: Promise<unknown>) => Promise.race([closing, new Promise((done) => setTimeout(done, 5000))]);

const progress = (page: Page) => page.locator(".progress").innerText();
const settle = (page: Page) => page.waitForTimeout(CARD_SETTLES_MS);
const YES = /^(allow once|approve)$/i;
const NO = /^(decline|deny)$/i;

async function passConsent(page: Page): Promise<void> {
  await page.locator("#role").selectOption({ index: 1 });
  await page.locator(".choices .choice").nth(2).click();
  await page.locator("#agree").check();
  await page.getByRole("button", { name: "Start" }).click();
}

async function toFirstCard(lab: Lab, page: Page, who: string): Promise<void> {
  await page.goto(lab.link(who));
  await page.getByRole("heading", { name: "Consent" }).waitFor();
  await passConsent(page);
  await page.getByRole("heading", { name: "Briefing" }).waitFor();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator(".progress").waitFor();
}

/** Answers whatever card is up and waits until the next screen is on the page. */
async function answerCard(page: Page): Promise<void> {
  const before = await progress(page);
  await settle(page);
  if ((await page.locator(".confirm-input").count()) > 0) await page.getByRole("button", { name: "No, deny" }).click();
  else await page.getByRole("button", { name: YES }).first().click();
  await page.waitForFunction((was) => document.querySelector(".progress")?.textContent !== was, before);
}

async function sitOutBreak(page: Page): Promise<void> {
  await page.getByRole("heading", { name: "Take a short break" }).waitFor();
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>(".primary")?.disabled, undefined, { timeout: (BREAK_SECONDS + 5) * 1000 });
  await page.getByRole("button", { name: "Continue to block 2" }).click();
  await page.locator(".progress").waitFor();
}

async function toTypedCard(lab: Lab, page: Page, who: string): Promise<void> {
  await toFirstCard(lab, page, who);
  for (let guard = 0; guard < 40; guard += 1) {
    await page.waitForFunction(() => document.querySelector(".progress, h1"));
    if ((await page.locator(".confirm-input").count()) > 0) return;
    if ((await page.locator(".progress").count()) > 0) {
      await answerCard(page);
    } else {
      await page.locator(".choices .choice").nth(2).click();
      await sitOutBreak(page);
    }
  }
  throw new Error("never reached a typed card");
}

/** One whole participant. The answers are chosen to reach every outcome, including a failed confirm and missed flaws. */
async function wholeParticipant(lab: Lab, browser: Browser, phone: BrowserContextOptions, engine: string): Promise<string> {
  console.log(`\n${engine}: one whole participant at phone size`);
  const who = lab.newParticipant();
  const shots = resolve(SHOTS, engine);
  mkdirSync(shots, { recursive: true });
  const requests = [...loadSet("practice").requests, ...loadSet("X").requests, ...loadSet("Y").requests];
  const context = await browser.newContext(phone);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
  });
  const layout: string[] = [];
  let still = 0;
  const look = async (name: string) => {
    still += 1;
    await page.screenshot({ path: resolve(shots, `${String(still).padStart(2, "0")}-${name}.png`), fullPage: true });
    for (const issue of await layoutProblems(page)) layout.push(`${name}: ${issue}`);
  };

  await page.goto(lab.link(who));
  await page.getByRole("heading", { name: "Consent" }).waitFor();
  await look("consent");
  check("Start waits until consent is filled in", await page.getByRole("button", { name: "Start" }).isDisabled());
  check("nothing is recorded before consent", !existsSync(lab.fileFor(who)));
  await passConsent(page);
  await page.getByRole("heading", { name: "Briefing" }).waitFor();
  await look("briefing");
  await page.getByRole("button", { name: "Continue" }).click();

  let typed = 0;
  let flawed = 0;
  let legit = 0;
  for (let guard = 0; guard < 80; guard += 1) {
    await page.waitForFunction(() => document.querySelector(".progress, h1"));
    await page.waitForTimeout(100);
    if ((await page.locator(".progress").count()) > 0) {
      const name = (await progress(page)).replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();
      await settle(page);
      await look(`card-${name}`);
      const step = (await (await context.request.get(`${lab.api(who)}/state`)).json()).step as { request_id: string };
      const request = requests.find((candidate) => candidate.id === step.request_id)!;
      if ((await page.locator(".confirm-input").count()) > 0) {
        typed += 1;
        const send = async (value: string) => {
          await page.locator(".confirm-input").fill(value);
          await page.getByRole("button", { name: "Send" }).click();
        };
        if (typed === 1) {
          // Wrong once, then right, the way the card teaches it.
          await send("not the value");
          await page.locator(".notice").waitFor();
          check("a wrong value asks again, naming the button there is", (await page.locator(".notice").innerText()).includes('press "No, deny"'));
          await settle(page);
          await look(`typed-asked-again-${name}`);
          await send(`A106 "${request.b.confirm!.expected}"`);
        } else if (typed === 2) {
          await send("wrong");
          await page.locator(".notice").waitFor();
          await settle(page);
          await send("wrong again");
        } else if (typed === 3) {
          await page.getByRole("button", { name: "No, deny" }).click();
        } else {
          await send(request.b.confirm!.expected);
        }
        continue;
      }
      let answer = YES;
      if (request.kind === "flawed") {
        flawed += 1;
        answer = flawed % 3 === 0 ? YES : NO;
      } else {
        legit += 1;
        answer = legit % 7 === 0 ? NO : YES;
      }
      await page.getByRole("button", { name: answer }).first().click();
      continue;
    }
    const title = await page.locator("h1").innerText();
    if (title.startsWith("End of block")) {
      await look(title.replace(/\s+/g, "-").toLowerCase());
      await page.locator(".choices .choice").nth(2).click();
      await page.waitForFunction((was) => document.querySelector("h1")?.textContent !== was, title);
    } else if (title.startsWith("Take a short break")) {
      await look("break");
      check("the break is enforced", await page.getByRole("button", { name: "Continue to block 2" }).isDisabled());
      await sitOutBreak(page);
    } else if (title.startsWith("One last question")) {
      await look("comment");
      await page.locator("textarea").fill("Scripted rehearsal text, not a person.");
      await page.getByRole("button", { name: "Finish" }).click();
      await page.getByRole("heading", { name: "Thank you" }).waitFor();
      await look("debrief");
      break;
    } else {
      throw new Error(`a screen this run doesn't know: ${title}`);
    }
  }
  await page.reload();
  await page.getByRole("heading", { name: "Thank you" }).waitFor();
  check("the debrief survives a reload", true);

  const events = lab.events(who);
  const decisions = events.filter((event) => event.type === "decision");
  check("24 decisions, 12 in each block, none scored twice", decisions.length === 24 && new Set(decisions.map((event) => `${String(event.block)}/${String(event.position)}`)).size === 24, String(decisions.length));
  check("2 practice cards, 2 confidence ratings, one break, one comment", lab.count(who, "practice") === 2 && lab.count(who, "confidence") === 2 && lab.count(who, "break_done") === 1 && lab.count(who, "comment") === 1);
  check("it reached every outcome", ["approve", "deny", "confirm_failed"].every((outcome) => decisions.some((event) => event.decision === outcome)));
  check("it met all 4 typed cards", typed === 4, String(typed));
  check("every event is marked synthetic", events.every((event) => event.synthetic === true));
  check("every screen fits a phone: no sideways scroll, nothing cut off, nothing too small to tap", layout.length === 0, [...new Set(layout)].slice(0, 6).join(" | "));
  check("no console errors or warnings", problems.length === 0, [...new Set(problems)].slice(0, 4).join(" | "));
  await closeSoon(context.close());
  return who;
}

/** The analysis must take a rehearsal without producing a number, and must refuse it in the real results folder. */
function analysisOfARehearsal(lab: Lab, engine: string): void {
  console.log(`\n${engine}: the analysis, on this rehearsal`);
  const outFile = resolve(lab.dir, "report.json");
  const report = runStudyEval({ resultsDir: lab.dir, outFile });
  check("it says it is synthetic", report.synthetic === true && /SYNTHETIC/.test(report.label) && /Not a result/.test(report.label), report.label);
  check("and reports no headline", report.headline === null);
  let refused = false;
  try {
    runStudyEval({ resultsDir: lab.dir, realResultsDir: lab.dir, outFile: resolve(lab.dir, "never.json") });
  } catch (error) {
    refused = /synthetic events found/.test((error as Error).message);
  }
  check("and it refuses to run if these events are ever in the real results folder", refused);
}

type Scenario = { name: string; run: (lab: Lab, page: Page, context: BrowserContext, browser: Browser, phone: BrowserContextOptions) => Promise<void> };

const SCENARIOS: Scenario[] = [
  {
    name: "reloading",
    run: async (lab, page) => {
      const who = lab.newParticipant();
      await page.goto(lab.link(who));
      await page.getByRole("heading", { name: "Consent" }).waitFor();
      await page.reload();
      await page.getByRole("heading", { name: "Consent" }).waitFor();
      check("on consent: still there, nothing recorded", !existsSync(lab.fileFor(who)));
      await passConsent(page);
      await page.getByRole("heading", { name: "Briefing" }).waitFor();
      await page.reload();
      await page.getByRole("heading", { name: "Briefing" }).waitFor();
      check("on the briefing: still there, consent recorded once", lab.count(who, "consent") === 1);
      await page.getByRole("button", { name: "Continue" }).click();
      await page.locator(".progress").waitFor();
      await answerCard(page);
      await answerCard(page);
      await answerCard(page);
      const at = await progress(page);
      await page.reload();
      await page.locator(".progress").waitFor();
      check("on a card: the same card", (await progress(page)) === at, await progress(page));
      await answerCard(page);
      check("that card's clock started late, so its time is marked as not real", lab.events(who).at(-1)!.interrupted === true);
      await answerCard(page);
      check("and the next card's isn't", lab.events(who).at(-1)!.interrupted === false);
      const positions = lab.events(who).filter((event) => event.type === "decision").map((event) => event.position);
      check("no card scored twice", new Set(positions).size === positions.length);
    },
  },
  {
    name: "the typed card",
    run: async (lab, page, context) => {
      const who = lab.newParticipant();
      await toTypedCard(lab, page, who);
      await settle(page);
      const before = lab.count(who, "confirm_wrong");
      const input = page.locator(".confirm-input");
      const attributes = await input.evaluate((node) => ["autocapitalize", "autocorrect", "spellcheck"].map((name) => node.getAttribute(name)).join());
      check("a phone won't change the value being typed", attributes === "none,off,false", attributes);
      check("it can't take more than the server reads", (await input.evaluate((node) => (node as HTMLInputElement).maxLength)) === 200);

      await page.getByRole("button", { name: "Send" }).click();
      check("Send on an empty box says what to do", (await page.locator(".typed-hint").innerText()).includes("Type the value first"));
      check("and puts the cursor in the box", await input.evaluate((node) => document.activeElement === node));
      check("and records nothing", lab.count(who, "confirm_wrong") === before);

      await input.fill("nope");
      await input.press("Enter");
      await page.locator(".notice").waitFor();
      check("Enter sends it, which is the Go key on a phone", lab.count(who, "confirm_wrong") === before + 1);

      const id = ((await (await context.request.get(`${lab.api(who)}/state`)).json()) as { step: { request_id: string } }).step.request_id;
      await page.reload();
      await page.locator(".confirm-input").waitFor();
      await settle(page);
      await page.locator(".confirm-input").fill("nope again");
      await page.getByRole("button", { name: "Send" }).click();
      await page.locator(".notice").waitFor();
      const final = lab.events(who).filter((event) => event.request_id === id && event.type === "decision");
      check("a reload doesn't buy a third try: it ends as not approved", final.length === 1 && final[0]!.decision === "confirm_failed");
      check("and says so", (await page.locator(".notice").innerText()).includes("not approved"));
    },
  },
  {
    name: "back and forward",
    run: async (lab, page, context) => {
      const who = lab.newParticipant();
      await page.goto(`${lab.base}/static/style.css`);
      await toFirstCard(lab, page, who);
      await answerCard(page);
      await answerCard(page);
      await answerCard(page);
      const at = await progress(page);
      await page.goBack();
      await page.waitForTimeout(300);
      await page.goForward();
      await page.locator(".progress").waitFor();
      check("back then forward: the same card", (await progress(page)) === at, await progress(page));
      await answerCard(page);
      check("nothing lost or doubled", lab.count(who, "decision") === 2, String(lab.count(who, "decision")));
      await page.goBack();
      await page.waitForTimeout(300);
      await page.goto(lab.link(who));
      await page.locator(".progress").waitFor();
      const step = ((await (await context.request.get(`${lab.api(who)}/state`)).json()) as { step: { position: number } }).step;
      check("back, then the link again: picks up where it was", step.position === 3, String(step.position));
    },
  },
  {
    name: "the link open twice",
    run: async (lab, a, context) => {
      const who = lab.newParticipant();
      await toFirstCard(lab, a, who);
      const b = await context.newPage();
      await b.goto(lab.link(who));
      await b.locator(".progress").waitFor();
      await answerCard(a);
      await answerCard(a);
      check("one tab is behind", (await progress(b)) !== (await progress(a)));
      const practiced = lab.count(who, "practice");
      await settle(b);
      await b.getByRole("button", { name: YES }).first().click();
      await b.waitForFunction(() => document.querySelector(".progress")?.textContent?.startsWith("Block 1"));
      check("answering in the stale tab scores nothing, and catches it up", lab.count(who, "practice") === practiced && lab.count(who, "decision") === 0);
      await settle(a);
      await Promise.all([a.locator(".actions button").last().click(), b.locator(".actions button").first().click()]);
      await a.waitForTimeout(300);
      check("both tabs answering at once scores it once", lab.count(who, "decision") === 1, String(lab.count(who, "decision")));
      await a.reload();
      await b.reload();
      await a.locator(".progress").waitFor();
      await b.locator(".progress").waitFor();
      check("both agree after a reload", (await progress(a)) === (await progress(b)));
      await a.getByRole("button", { name: "Stop the study" }).click();
      await a.getByRole("button", { name: "Yes, stop" }).click();
      await a.getByRole("heading", { name: "Stopped" }).waitFor();
      const decisions = lab.count(who, "decision");
      await settle(b);
      await b.locator(".actions button").first().click();
      await b.getByRole("heading", { name: "Stopped" }).waitFor();
      check("answering in the other tab after stopping records nothing, and shows Stopped", lab.count(who, "decision") === decisions);
      await closeSoon(b.close());
    },
  },
  {
    name: "stopping",
    run: async (lab, page, _context, browser, phone) => {
      const who = lab.newParticipant();
      await toFirstCard(lab, page, who);
      await answerCard(page);
      await answerCard(page);
      await answerCard(page);
      await page.getByRole("button", { name: "Stop the study" }).click();
      await page.getByRole("button", { name: "Yes, stop" }).waitFor();
      check("a stray tap only asks, and records nothing", lab.count(who, "stopped") === 0);
      check("the question fits a phone", (await layoutProblems(page)).length === 0, (await layoutProblems(page)).join(" | "));
      await page.screenshot({ path: resolve(SHOTS, "stop-question.png"), fullPage: true });
      await page.getByRole("button", { name: "Keep going" }).click();
      await settle(page);
      await page.getByRole("button", { name: "Stop the study" }).waitFor();
      check("Keep going goes back to the card, nothing recorded", lab.count(who, "stopped") === 0);
      await answerCard(page);
      await page.getByRole("button", { name: "Stop the study" }).click();
      await page.getByRole("button", { name: "Yes, stop" }).click();
      await page.getByRole("heading", { name: "Stopped" }).waitFor();
      const events = lab.events(who);
      check("stopped is recorded once, and last", events.at(-1)!.type === "stopped" && lab.count(who, "stopped") === 1);
      await page.reload();
      await page.getByRole("heading", { name: "Stopped" }).waitFor();
      const elsewhere = await browser.newContext(phone);
      const other = await elsewhere.newPage();
      await other.goto(lab.link(who));
      await other.getByRole("heading", { name: "Stopped" }).waitFor();
      await closeSoon(elsewhere.close());
      check("it stays stopped, on a reload and from the link in another browser", lab.events(who).length === events.length);
    },
  },
  {
    name: "a second tab pressing stop after the end",
    run: async (lab, _page, context) => {
      const who = lab.newParticipant();
      const post = (action: string, data: unknown) => context.request.post(`${lab.api(who)}/${action}`, { data: data as Record<string, unknown> });
      const state = async () => ((await (await context.request.get(`${lab.api(who)}/state`)).json()) as { step: { step: string; request_id: string; block: number; card: { buttons: string[] } } }).step;
      await post("consent", { agreed: true, role: "other", familiarity: 3 });
      await post("briefing", {});
      for (let guard = 0; guard < 60; guard += 1) {
        const step = await state();
        if (step.step === "practice" || step.step === "card") await post("answer", { request_id: step.request_id, label: step.card.buttons.at(-1), ms: 5000, interrupted: false });
        else if (step.step === "confidence") await post("confidence", { block: step.block, value: 3 });
        else if (step.step === "break") await post("break", {});
        else if (step.step === "comment") await post("comment", { text: "" });
        else break;
      }
      check("the session finished", (await state()).step === "debrief");
      await post("stop", {});
      check("a finished session can't be turned into a stopped one", lab.count(who, "stopped") === 0 && (await state()).step === "debrief");
    },
  },
  {
    name: "a phone put down for over an hour",
    run: async (lab, page) => {
      const who = lab.newParticipant();
      await toFirstCard(lab, page, who);
      const at = await progress(page);
      await settle(page);
      await page.evaluate(() => {
        const real = performance.now.bind(performance);
        performance.now = () => real() + 3_700_000;
      });
      await page.getByRole("button", { name: YES }).first().click();
      await page.waitForFunction((was) => document.querySelector(".progress")?.textContent !== was || document.querySelector(".error"), at);
      check("answering still works, with no error to be stuck on", (await page.locator(".error").count()) === 0);
      const event = lab.events(who).at(-1)!;
      check("its time is capped, and marked as not real", event.ms === 3_600_000 && event.interrupted === true, `${String(event.ms)}, ${String(event.interrupted)}`);
    },
  },
  {
    name: "a bad network",
    run: async (lab, page) => {
      const who = lab.newParticipant();
      await toFirstCard(lab, page, who);
      const at = await progress(page);
      await page.route("**/api/**/answer", (route) => route.abort());
      await settle(page);
      await page.getByRole("button", { name: YES }).first().click();
      await page.locator(".error").waitFor();
      check("a failed send says so in words, and that earlier answers are safe", (await page.locator(".error").innerText()).includes("Your answers so far are safe"));
      check("and records nothing", lab.count(who, "practice") === 0);
      await page.screenshot({ path: resolve(SHOTS, "network-failed.png"), fullPage: true });
      await page.unroute("**/api/**/answer");
      await page.getByRole("button", { name: "Try again" }).click();
      await page.locator(".progress").waitFor();
      check("Try again shows the same card, ready", (await progress(page)) === at && (await page.locator(".actions button").first().isEnabled()));
      await page.route("**/api/**/answer", async (route) => {
        await route.fetch();
        await route.abort();
      });
      await settle(page);
      await page.getByRole("button", { name: YES }).first().click();
      await page.locator(".error").waitFor();
      await page.unroute("**/api/**/answer");
      await page.getByRole("button", { name: "Try again" }).click();
      await page.waitForFunction((was) => document.querySelector(".progress")?.textContent !== was, at);
      check("the answer arrived and its reply was lost: Try again moves on, scored once", lab.count(who, "practice") === 1);
      check("and that card's time is marked as not real, because the clock ran through it", lab.events(who).at(-1)!.interrupted === true);
    },
  },
  {
    name: "double taps",
    run: async (lab, page) => {
      const who = lab.newParticipant();
      await toFirstCard(lab, page, who);
      await answerCard(page);
      await answerCard(page);
      const button = page.locator(".card-button").first();
      for (const gap of [0, 80, 150, 250, 350, 500]) {
        const before = lab.count(who, "decision");
        await button.scrollIntoViewIfNeeded();
        await settle(page);
        const box = (await button.boundingBox())!;
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(gap);
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(400);
        const added = lab.count(who, "decision") - before;
        // None is harmless: nothing was answered, and the card is still there to tap. Two is the bug.
        check(`two taps ${gap} ms apart never answer the next card too`, added <= 1, `${added} scored`);
      }
      const quickest = Math.min(...lab.events(who).filter((event) => event.type === "decision").map((event) => Number(event.ms)));
      check("so no decision is recorded in under the moment a card takes to settle", quickest >= 600, `${quickest} ms`);
    },
  },
  {
    name: "a small phone",
    run: async (lab, page) => {
      const who = lab.newParticipant();
      await page.setViewportSize({ width: 320, height: 568 });
      await page.goto(lab.link(who));
      await page.getByRole("heading", { name: "Consent" }).waitFor();
      check("consent fits 320 px", (await layoutProblems(page)).length === 0, (await layoutProblems(page)).join(" | "));
      await passConsent(page);
      await page.getByRole("heading", { name: "Briefing" }).waitFor();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.locator(".progress").waitFor();
      const issues: string[] = [];
      for (let card = 0; card < 16; card += 1) {
        await page.waitForFunction(() => document.querySelector(".progress, h1"));
        if ((await page.locator(".progress").count()) === 0) {
          await page.locator(".choices .choice").nth(2).click();
          await sitOutBreak(page);
        }
        for (const issue of await layoutProblems(page)) issues.push(`${await progress(page)}: ${issue}`);
        await answerCard(page);
      }
      check("cards in both styles fit 320 px", issues.length === 0, issues.slice(0, 4).join(" | "));
    },
  },
];

async function runEngine(engine: string, browser: Browser, phone: BrowserContextOptions): Promise<void> {
  const lab = await Lab.start();
  try {
    await wholeParticipant(lab, browser, phone, engine);
    analysisOfARehearsal(lab, engine);
    for (const scenario of SCENARIOS) {
      console.log(`\n${engine}: ${scenario.name}`);
      const context = await browser.newContext(phone);
      const page = await context.newPage();
      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(error.message));
      await scenario.run(lab, page, context, browser, phone);
      check("no uncaught errors", problems.length === 0, problems.join(" | "));
      await closeSoon(context.close());
    }
  } finally {
    await lab.stop();
  }
}

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const only = process.env.STUDY_E2E_ENGINE;
  if (only !== "webkit") {
    const executablePath = process.env.CLEARANCE_CHROMIUM ?? (existsSync("/snap/bin/chromium") ? "/snap/bin/chromium" : undefined);
    const chrome = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
    try {
      await runEngine("chromium", chrome, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    } finally {
      await closeSoon(chrome.close());
    }
  }

  if (only !== "chromium") {
    const webkitPath = findWebKit();
    if (webkitPath) {
      const safari = await webkit.launch({ executablePath: webkitPath, headless: true, env: withoutSnapEnvironment() });
      try {
        await runEngine("webkit", safari, { ...devices["iPhone 13"] });
      } finally {
        await closeSoon(safari.close());
      }
    } else {
      console.log("\nWebKit: no build in Playwright's cache here, so this run did not cover it.");
    }
  }

  console.log(`\nStills in ${SHOTS}`);
  console.log(failures === 0 ? "All study browser checks passed." : `${failures} study browser check(s) FAILED.`);
  // A browser whose close was given up on would keep the process alive.
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error);
  // A check that throws leaves its server listening, and that would keep the process alive.
  process.exit(1);
});

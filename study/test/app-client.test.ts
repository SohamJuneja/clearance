/**
 * Runs the real browser client (app/public/app.js) against the real server through a small fake DOM.
 *
 * This repo's environment rules out Playwright, so this is what stands between a typo in the client
 * and a participant finding it. It proves the client's logic and its calls to the server. It says
 * nothing about layout: how it looks on a phone needs a person to check it.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain browser JavaScript with no type declarations
import { boot, parseInline } from "../app/public/app.js";
import { createLabServer, linkToken } from "../app/server";
import { StudyEventSchema } from "../lib/events";
import { loadSet } from "../lib/sets";

class FakeNode {
  children: FakeNode[] = [];
  listeners = new Map<string, ((event?: unknown) => void)[]>();
  className = "";
  value = "";
  checked = false;
  disabled = false;
  id = "";
  type = "";
  placeholder = "";
  autocomplete = "";
  rows = 0;
  maxLength = 0;
  private ownText = "";
  constructor(readonly tag: string) {}

  append(...nodes: FakeNode[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: (FakeNode | null)[]) {
    this.children = nodes.filter((n): n is FakeNode => n !== null);
  }
  addEventListener(type: string, listener: (event?: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string) {
    if (this.disabled) return;
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  click() {
    this.fire("click");
  }
  set textContent(text: string) {
    this.ownText = text;
    this.children = [];
  }
  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }
  all(): FakeNode[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}

function fakeDocument() {
  const listeners: Record<string, () => void> = {};
  return {
    visibilityState: "visible",
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => {
      const node = new FakeNode("#text");
      node.textContent = text;
      return node;
    },
    addEventListener: (type: string, listener: () => void) => {
      listeners[type] = listener;
    },
    listeners,
  };
}

const SECRET = "client-test-secret";
let server: Server;
let base: string;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "approval-lab-client-"));
  server = createLabServer({ resultsDir: dir, secret: SECRET, synthetic: true, breakSeconds: 2 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

/** Boots the client for one participant and hands back ways to read and press what it drew. */
async function open(participant: string) {
  const root = new FakeNode("div");
  const document = fakeDocument();
  let clock = 1000;
  const timers: (() => void)[] = [];
  const pathname = `/p/${linkToken(participant, SECRET)}`;
  const settled = { pending: Promise.resolve() as Promise<unknown> };
  const trackedFetch = (url: string, init?: RequestInit) => {
    // Relative to the page, exactly as a browser would resolve it.
    const request = fetch(new URL(url, `${base}${pathname}`), init);
    // Only tracks completion. The client handles a failed request itself, which one test checks.
    settled.pending = request.then((res) => res.clone().text()).catch(() => undefined);
    return request;
  };
  await boot({
    root,
    document,
    fetch: trackedFetch,
    pathname,
    now: () => clock,
    afterPaint: (callback: () => void) => callback(),
    setTimeout: (callback: () => void) => timers.push(callback),
    clearTimeout: () => {},
    scrollToTop: () => {},
  });
  const flush = async () => {
    for (let i = 0; i < 4; i += 1) {
      await settled.pending;
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return {
    root,
    document,
    text: () => root.textContent,
    buttons: () => root.all().filter((n) => n.tag === "button"),
    button(label: string) {
      const found = root.all().find((n) => n.tag === "button" && n.textContent === label);
      if (!found) throw new Error(`no button "${label}" in: ${root.textContent.slice(0, 300)}`);
      return found;
    },
    async press(label: string) {
      this.button(label).click();
      await flush();
    },
    find: (tag: string) => root.all().find((n) => n.tag === tag)!,
    advanceClock(ms: number) {
      clock += ms;
    },
    runTimers() {
      while (timers.length > 0) timers.shift()!();
    },
    flush,
  };
}

const log = (participant: string) =>
  readFileSync(join(dir, `${participant}.jsonl`), "utf8").trim().split("\n").map((line) => StudyEventSchema.parse(JSON.parse(line)));

type Page = Awaited<ReturnType<typeof open>>;

async function passConsent(page: Page) {
  const check = page.root.all().find((n) => n.tag === "input" && n.type === "checkbox")!;
  const role = page.find("select");
  expect(page.button("Start").disabled).toBe(true);
  check.checked = true;
  check.fire("change");
  expect(page.button("Start").disabled, "still needs role and familiarity").toBe(true);
  role.value = "other";
  role.fire("change");
  page.button("3").click();
  expect(page.button("Start").disabled).toBe(false);
  await page.press("Start");
}

const CARD_BUTTON = /^(Allow once|Decline|Approve|Deny|No)$/;

describe("the client, driving the real server", () => {
  it("walks a whole session from consent to debrief with real timing", async () => {
    const page = await open("p01");
    expect(page.text()).toContain("You will review 24 example requests");

    await passConsent(page);
    expect(page.text()).toContain("You are the finance and engineering lead");
    expect(page.text()).toContain("replicas of real Switch approval cards");
    await page.press("Continue");

    // Practice, one card in each style.
    expect(page.text()).toContain("Practice card 1 of 2");
    expect(page.text()).toContain("Allow for this session");
    await page.press("Allow once");
    expect(page.text()).toContain("Practice card 2 of 2");
    expect(page.text()).toContain("The call (parsed from what the agent ran");
    await page.press("Approve");

    // Block 1, condition A: decide each card after a measured pause.
    const expected = new Map([...loadSet("X").requests, ...loadSet("Y").requests].flatMap((r) => (r.b.confirm ? [[r.id, r.b.confirm.expected] as const] : [])));
    const answerCards = async (blockLabel: string) => {
      for (let i = 1; i <= 12; i += 1) {
        expect(page.text()).toContain(`${blockLabel} · card ${i} of 12`);
        page.advanceClock(2500);
        const input = page.root.all().find((n) => n.tag === "input" && n.className === "confirm-input");
        if (input) {
          // Type the right value: the card itself shows it, the test reads it from the set.
          const handle = /request A(\d+)/.exec(page.text())!;
          const set = [...loadSet("X").requests, ...loadSet("Y").requests].find((r) => r.b.handle === `A${handle[1]}`)!;
          input.value = expected.get(set.id)!;
          await page.press("Send");
        } else {
          const button = page.buttons().find((b) => CARD_BUTTON.test(b.textContent))!;
          button.click();
          await page.flush();
        }
      }
    };
    await answerCards("Block 1");

    expect(page.text()).toContain("End of block 1");
    await page.press("4");

    expect(page.text()).toContain("Take a short break");
    expect(page.button("Continue to block 2").disabled, "the break is enforced").toBe(true);
    page.runTimers();
    expect(page.button("Continue to block 2").disabled).toBe(false);
    await page.press("Continue to block 2");

    await answerCards("Block 2");
    await page.press("3");

    expect(page.text()).toContain("Which card helped you decide, and why?");
    page.find("textarea").value = "The second one.";
    await page.press("Finish");

    expect(page.text()).toContain("Thank you");
    expect(page.text()).toContain("thanked by name in the project's README");

    const events = log("p01");
    const decisions = events.flatMap((e) => (e.type === "decision" ? [e] : []));
    expect(decisions).toHaveLength(24);
    expect(decisions.every((d) => d.ms === 2500), "timing comes from the page's clock").toBe(true);
    expect(events.at(-1)!.type).toBe("session_end");
  });

  it("disables a card's buttons on the first tap, so a double tap sends one answer", async () => {
    const page = await open("p01");
    await passConsent(page);
    await page.press("Continue");
    const allow = page.button("Allow once");
    const decline = page.button("Decline");
    allow.click();
    expect(allow.disabled).toBe(true);
    expect(decline.disabled).toBe(true);
    allow.click();
    await page.flush();
    expect(log("p01").filter((e) => e.type === "practice")).toHaveLength(1);
  });

  it("flags a card that was on screen while the page was hidden", async () => {
    const page = await open("p01");
    await passConsent(page);
    await page.press("Continue");
    await page.press("Allow once");
    await page.press("Approve");
    page.document.visibilityState = "hidden";
    page.document.listeners.visibilitychange!();
    page.document.visibilityState = "visible";
    await page.press("Decline");
    expect(log("p01").find((e) => e.type === "decision")).toMatchObject({ interrupted: true });
    await page.press("Decline");
    expect(log("p01").filter((e) => e.type === "decision")[1]).toMatchObject({ interrupted: false });
  });

  it("re-asks a wrong type-to-confirm value on screen", async () => {
    const page = await open("p03"); // block 1 is condition B
    await passConsent(page);
    await page.press("Continue");
    await page.press("Approve");
    await page.press("Allow once");
    let input = page.root.all().find((n) => n.className === "confirm-input");
    while (!input) {
      await page.press("Deny");
      input = page.root.all().find((n) => n.className === "confirm-input");
    }
    input.value = "wrong";
    await page.press("Send");
    expect(page.text()).toContain("doesn't match");
    expect(page.root.all().find((n) => n.className === "confirm-input")).toBeTruthy();
    expect(page.button("Send").disabled, "the card is usable again").toBe(false);
  });

  it("a re-ask keeps the clock running, so the decision time includes the first attempt", async () => {
    const page = await open("p03");
    await passConsent(page);
    await page.press("Continue");
    await page.press("Approve");
    await page.press("Allow once");
    while (!page.root.all().some((n) => n.className === "confirm-input")) await page.press("Deny");

    page.advanceClock(4000);
    page.root.all().find((n) => n.className === "confirm-input")!.value = "wrong";
    await page.press("Send");
    page.advanceClock(3000);
    page.root.all().find((n) => n.className === "confirm-input")!.value = "wrong again";
    await page.press("Send");

    const typed = log("p03").filter((e) => e.type === "decision").at(-1)!;
    expect(typed).toMatchObject({ decision: "confirm_failed", ms: 7000 });
  });

  it("the clock restarts on the next card", async () => {
    const page = await open("p01");
    await passConsent(page);
    await page.press("Continue");
    await page.press("Allow once");
    await page.press("Approve");
    page.advanceClock(5000);
    await page.press("Decline");
    page.advanceClock(2000);
    await page.press("Decline");
    expect(log("p01").filter((e) => e.type === "decision").map((e) => (e as { ms: number }).ms)).toEqual([5000, 2000]);
  });

  it("will not send an empty typed answer", async () => {
    const page = await open("p03");
    await passConsent(page);
    await page.press("Continue");
    await page.press("Approve");
    await page.press("Allow once");
    while (!page.root.all().some((n) => n.className === "confirm-input")) await page.press("Deny");
    const before = log("p03").length;
    await page.press("Send");
    expect(log("p03")).toHaveLength(before);
    expect(page.button("Send").disabled).toBe(false);
  });

  it("offers a way to stop on every screen after consent", async () => {
    const page = await open("p01");
    await passConsent(page);
    expect(page.button("Stop the study")).toBeTruthy();
    await page.press("Continue");
    expect(page.button("Stop the study")).toBeTruthy();
    await page.press("Stop the study");
    expect(page.text()).toContain("You've stopped the study");
    expect(page.buttons()).toHaveLength(0);
  });

  it("a reload lands on the same card", async () => {
    const page = await open("p01");
    await passConsent(page);
    await page.press("Continue");
    await page.press("Allow once");
    await page.press("Approve");
    await page.press("Decline");
    const reloaded = await open("p01");
    expect(reloaded.text()).toContain("Block 1 · card 2 of 12");
  });

  it("shows a retry when the server fails, rather than a dead page", async () => {
    const page = await open("p01");
    await passConsent(page);
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    page.button("Continue").click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(page.text()).toContain("Something went wrong");
    expect(page.button("Try again")).toBeTruthy();
    // Restart so afterEach has something to close.
    server = createLabServer({ resultsDir: dir, secret: SECRET, synthetic: true });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });
});

describe("parseInline, the Markdown the renderer emits", () => {
  it("handles the frame's bold heading and code handle", () => {
    expect(parseInline("**Permission needed** · request `A42`")).toEqual([
      { type: "bold", text: "Permission needed" },
      { type: "text", text: " · request " },
      { type: "code", text: "A42" },
    ]);
  });

  it("keeps a command with quotes and braces whole inside a code span", () => {
    const command = `curl -s -d '{"amount":48000}' -H "x: y"`;
    expect(parseInline(`\`${command}\``)).toEqual([{ type: "code", text: command }]);
  });

  it("does not treat a star inside a command as bold", () => {
    expect(parseInline("`echo **not bold**`")).toEqual([{ type: "code", text: "echo **not bold**" }]);
  });

  it("handles a command containing backticks, fenced by a longer run", () => {
    expect(parseInline("``echo `date` now``")).toEqual([{ type: "code", text: "echo `date` now" }]);
  });

  it("leaves plain prose alone", () => {
    expect(parseInline('Agent\'s claim (unverified): "Refund ₹4,800"')).toEqual([{ type: "text", text: 'Agent\'s claim (unverified): "Refund ₹4,800"' }]);
  });
});

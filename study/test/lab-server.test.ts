/** The Approval Lab over real HTTP, writing to a temporary directory. Every event is marked synthetic. */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RESULTS_DIR, createLabServer, linkToken, participantFromToken } from "../app/server";
import { StudyEventSchema, type StudyEvent } from "../lib/events";
import { BRIEFING, CONSENT, REPLICA_NOTICE } from "../lib/materials";
import { loadSet } from "../lib/sets";

const SECRET = "test-secret";
let server: Server;
let base: string;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "approval-lab-"));
  server = createLabServer({ resultsDir: dir, secret: SECRET, synthetic: true, breakSeconds: 0 });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const api = (participant: string) => `${base}/api/${linkToken(participant, SECRET)}`;

type Reply = {
  step: { step: string; request_id: string; card: { buttons: string[]; typeToConfirm: boolean; text: string; sender: string }; position: number; block: number; attempts: number; missed: { headline: string }[] };
  notice?: string;
  copy: Record<string, unknown>;
};

async function post(participant: string, action: string, body: unknown = {}): Promise<Reply> {
  const res = await fetch(`${api(participant)}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status, `${action} ${JSON.stringify(body)}`).toBe(200);
  return (await res.json()) as Reply;
}

const state = async (participant: string) => (await (await fetch(`${api(participant)}/state`)).json()) as Reply;

function events(participant: string): StudyEvent[] {
  const file = join(dir, `${participant}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").map((line) => StudyEventSchema.parse(JSON.parse(line)));
}

const consent = { agreed: true, role: "working developer", familiarity: 4 };

/** Answers every remaining card in the current block: the first offered button, or the typed value. */
async function finishBlock(participant: string, choose: (step: Reply["step"]) => Record<string, unknown>) {
  let reply = await state(participant);
  while (reply.step.step === "card" || reply.step.step === "practice") {
    reply = await post(participant, "answer", { request_id: reply.step.request_id, ms: 1500, ...choose(reply.step) });
  }
  return reply;
}

const firstButton = (step: Reply["step"]) => ({ label: step.card.buttons[0] });

describe("links", () => {
  it("signs participant ids so one cannot be edited into another", () => {
    const token = linkToken("p07", SECRET);
    expect(token).toMatch(/^p07\.[0-9a-f]{16}$/);
    expect(participantFromToken(token, SECRET)).toBe("p07");
    expect(participantFromToken(token.replace("p07", "p08"), SECRET)).toBeNull();
    expect(participantFromToken("p07", SECRET)).toBeNull();
    expect(participantFromToken(`${token}x`, SECRET)).toBeNull();
    expect(participantFromToken(linkToken("p07", "other-secret"), SECRET)).toBeNull();
    expect(participantFromToken(linkToken("bob", SECRET), SECRET)).toBeNull();
  });

  it("serves the page only for a signed link, and writes nothing for a bad one", async () => {
    expect((await fetch(`${base}/p/${linkToken("p07", SECRET)}`)).status).toBe(200);
    expect((await fetch(`${base}/p/p07`)).status).toBe(404);
    expect((await fetch(`${base}/api/p07/state`)).status).toBe(404);
    const forged = await fetch(`${base}/api/p07.0000000000000000/consent`, { method: "POST", body: JSON.stringify(consent) });
    expect(forged.status).toBe(404);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("works behind a tunnel: no absolute URLs, no Host check", async () => {
    const res = await fetch(`${base}/p/${linkToken("p07", SECRET)}`, { headers: { "x-forwarded-host": "abc.trycloudflare.com", "x-forwarded-proto": "https" } });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toMatch(/(href|src)="(https?:)?\/\//);
    expect(html).toContain('name="viewport"');
    expect(readFileSync(join(import.meta.dirname, "../app/public/app.js"), "utf8")).not.toMatch(/fetch\(`(https?:|\/)/);
  });

  it("does not let a link's path reach files outside the public folder", async () => {
    for (const path of ["/static/../server.ts", "/static/..%2f..%2f..%2f.env", "/static/nope.js", "/.env"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it("sets headers that keep the link out of referrers and refuse inline scripts", async () => {
    const res = await fetch(`${base}/p/${linkToken("p07", SECRET)}`);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("consent comes first", () => {
  it("records nothing until someone agrees, even when they read pages or try to answer", async () => {
    expect((await state("p01")).step.step).toBe("consent");
    await fetch(`${api("p01")}/answer`, { method: "POST", body: JSON.stringify({ request_id: "X01", label: "Decline", ms: 1 }) });
    await post("p01", "briefing");
    await post("p01", "stop");
    expect(events("p01")).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses consent that is not an explicit yes, or that has a role outside the list", async () => {
    for (const body of [{ agreed: false, role: "other", familiarity: 3 }, { role: "other", familiarity: 3 }, { agreed: true, role: "Meera from accounts", familiarity: 3 }, { agreed: true, role: "other", familiarity: 9 }]) {
      const res = await fetch(`${api("p01")}/consent`, { method: "POST", body: JSON.stringify(body) });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(events("p01")).toEqual([]);
  });

  it("shows the plan's text verbatim, and says honestly that the cards are replicas", async () => {
    const reply = await state("p01");
    expect(reply.copy.consent).toBe(CONSENT);
    expect(reply.copy.briefing).toBe(BRIEFING);
    expect(reply.copy.replicaNotice).toBe(REPLICA_NOTICE);
    expect(String(reply.copy.replicaNotice)).toMatch(/replicas of real Switch approval cards/);
  });
});

describe("a full session", () => {
  it("runs consent to debrief, records 24 decisions, and writes only IDs", async () => {
    expect((await post("p01", "consent", consent)).step.step).toBe("briefing");
    expect((await post("p01", "briefing")).step.step).toBe("practice");
    expect((await finishBlock("p01", firstButton)).step).toMatchObject({ step: "confidence", block: 1 });
    expect((await post("p01", "confidence", { block: 1, value: 4 })).step.step).toBe("break");
    expect((await post("p01", "break")).step).toMatchObject({ step: "card", block: 2, position: 1 });

    // Block 2 of group 1 is condition B, where critical cards have to be typed.
    const expected = new Map(loadSet("Y").requests.flatMap((r) => (r.b.confirm ? [[r.id, r.b.confirm.expected] as const] : [])));
    const reply = await finishBlock("p01", (step) => (step.card.typeToConfirm ? { typed: expected.get(step.request_id) } : firstButton(step)));
    expect(reply.step).toMatchObject({ step: "confidence", block: 2 });
    expect((await post("p01", "confidence", { block: 2, value: 3 })).step.step).toBe("comment");
    const end = await post("p01", "comment", { text: "The second style showed me the order total." });
    expect(end.step.step).toBe("debrief");

    const log = events("p01");
    expect(log.filter((e) => e.type === "decision")).toHaveLength(24);
    expect(log.filter((e) => e.type === "practice")).toHaveLength(2);
    expect(log.filter((e) => e.type === "confidence")).toHaveLength(2);
    expect(log.at(-1)!.type).toBe("session_end");
    expect(log.every((e) => e.participant === "p01" && e.synthetic === true)).toBe(true);

    const decisions = log.flatMap((e) => (e.type === "decision" ? [e] : []));
    expect(decisions.filter((d) => d.condition === "A")).toHaveLength(12);
    expect(decisions.filter((d) => d.condition === "B")).toHaveLength(12);
    expect(new Set(decisions.filter((d) => d.block === 1).map((d) => d.set))).toEqual(new Set(["X"]));
    expect(new Set(decisions.filter((d) => d.block === 2).map((d) => d.set))).toEqual(new Set(["Y"]));
    expect(decisions.filter((d) => d.kind === "flawed")).toHaveLength(8);
    expect(decisions.every((d) => d.ms === 1500)).toBe(true);

    // Nothing but the agreed fields: no IP, no browser string, no name.
    const raw = readFileSync(join(dir, "p01.jsonl"), "utf8");
    expect(raw).not.toMatch(/user.?agent|mozilla|127\.0\.0\.1|"name"|"email"|"ip"/i);
  });

  it("the debrief lists flaws the participant approved, and gives ground truth only then", async () => {
    await post("p01", "consent", consent);
    await post("p01", "briefing");
    const midway = await finishBlock("p01", firstButton);
    expect(JSON.stringify(midway.step)).not.toContain("explanation");
    await post("p01", "confidence", { block: 1, value: 4 });
    await post("p01", "break");
    const denyAll = (step: Reply["step"]) => ({ label: step.card.typeToConfirm ? "No, deny" : "Deny" });
    await finishBlock("p01", denyAll);
    await post("p01", "confidence", { block: 2, value: 3 });
    const end = await post("p01", "comment", { text: "" });
    // Block 1 (condition A) approved everything, so its 4 flaws are missed. Block 2 denied everything.
    expect(end.step.missed).toHaveLength(4);
    expect(end.step.missed.map((m) => m.headline).join()).toMatch(/DEPLOY/);
  });
});

describe("phones are messy", () => {
  const toCards = async (participant: string) => {
    await post(participant, "consent", consent);
    await post(participant, "briefing");
    let reply = await state(participant);
    while (reply.step.step === "practice") reply = await post(participant, "answer", { request_id: reply.step.request_id, ms: 500, ...firstButton(reply.step) });
    return reply;
  };

  it("a double tap scores a card once, and a stale answer cannot land on the next card", async () => {
    const first = await toCards("p01");
    const body = { request_id: first.step.request_id, ms: 900, label: "Decline" };
    const next = await post("p01", "answer", body);
    expect(next.step.position).toBe(2);
    const again = await post("p01", "answer", body);
    expect(again.step.position).toBe(2);
    expect(events("p01").filter((e) => e.type === "decision")).toHaveLength(1);
  });

  it("a reload resumes on the same card", async () => {
    const first = await toCards("p01");
    await post("p01", "answer", { request_id: first.step.request_id, ms: 900, label: "Decline" });
    expect((await state("p01")).step).toMatchObject({ step: "card", position: 2 });
    expect((await fetch(`${base}/p/${linkToken("p01", SECRET)}`)).status).toBe(200);
    expect((await state("p01")).step).toMatchObject({ step: "card", position: 2 });
  });

  it("repeated confidence, break and comment posts count once", async () => {
    await toCards("p01");
    await finishBlock("p01", firstButton);
    await post("p01", "confidence", { block: 1, value: 2 });
    await post("p01", "confidence", { block: 1, value: 5 });
    await post("p01", "break");
    await post("p01", "break");
    const log = events("p01");
    expect(log.filter((e) => e.type === "confidence")).toHaveLength(1);
    expect(log.filter((e) => e.type === "break_done")).toHaveLength(1);
  });

  it("records when the page was hidden during a card, because that time is not deciding", async () => {
    const first = await toCards("p01");
    await post("p01", "answer", { request_id: first.step.request_id, ms: 900, label: "Decline", interrupted: true });
    const decision = events("p01").find((e) => e.type === "decision");
    expect(decision).toMatchObject({ interrupted: true });
  });

  it("refuses absurd timings and oversized bodies without recording anything", async () => {
    const first = await toCards("p01");
    const before = events("p01").length;
    for (const ms of [0, -5, 99_999_999, "fast"]) {
      const res = await fetch(`${api("p01")}/answer`, { method: "POST", body: JSON.stringify({ request_id: first.step.request_id, ms, label: "Decline" }) });
      expect(res.status, String(ms)).toBe(400);
    }
    const big = await fetch(`${api("p01")}/comment`, { method: "POST", body: JSON.stringify({ text: "x".repeat(20_000) }) });
    expect(big.status).toBe(413);
    expect(events("p01")).toHaveLength(before);
  });

  it("refuses a button that is not on the card", async () => {
    const first = await toCards("p01");
    const res = await fetch(`${api("p01")}/answer`, { method: "POST", body: JSON.stringify({ request_id: first.step.request_id, ms: 100, label: "Approve" }) });
    expect(res.status).toBe(400);
    expect(events("p01").filter((e) => e.type === "decision")).toHaveLength(0);
  });
});

describe("type-to-confirm over HTTP", () => {
  /** p03 is group 3, so block 1 is condition B and has typed cards. */
  async function toTypedCard() {
    await post("p03", "consent", consent);
    await post("p03", "briefing");
    let reply = await state("p03");
    while (reply.step.step === "practice") reply = await post("p03", "answer", { request_id: reply.step.request_id, ms: 500, ...firstButton(reply.step) });
    while (!reply.step.card.typeToConfirm) reply = await post("p03", "answer", { request_id: reply.step.request_id, ms: 500, label: "Deny" });
    return reply;
  }

  it("re-asks once on a wrong value, and the second wrong value is recorded as not approved", async () => {
    const card = await toTypedCard();
    const wrong = { request_id: card.step.request_id, ms: 4000, typed: "nope" };
    const reask = await post("p03", "answer", wrong);
    expect(reask.step.request_id).toBe(card.step.request_id);
    expect(reask.step.attempts).toBe(1);
    expect(reask.notice).toMatch(/doesn't match/);
    const gaveUp = await post("p03", "answer", wrong);
    expect(gaveUp.step.request_id).not.toBe(card.step.request_id);
    expect(gaveUp.notice).toMatch(/not approved/);
    expect(events("p03").find((e) => e.type === "decision" && e.request_id === card.step.request_id)).toMatchObject({ decision: "confirm_failed", confirm_attempts: 2 });
  });

  it("a re-ask survives a reload, so reloading does not buy another try", async () => {
    const card = await toTypedCard();
    await post("p03", "answer", { request_id: card.step.request_id, ms: 4000, typed: "nope" });
    expect((await state("p03")).step.attempts).toBe(1);
  });

  it("shows the card's own code in the how-to, never a literal placeholder", async () => {
    const card = await toTypedCard();
    const request = loadSet("X").requests.find((r) => r.id === card.step.request_id)!;
    expect(card.step.card.text).not.toContain("<handle>");
    expect(card.step.card.text).toContain(`${request.b.handle} "${request.b.confirm!.expected}"`);
  });

  it("counts typing exactly what the card shows as the right answer, not as a wrong one", async () => {
    const card = await toTypedCard();
    const request = loadSet("X").requests.find((r) => r.id === card.step.request_id)!;
    // This is what a careful person does, and it must not cost an attempt.
    await post("p03", "answer", { request_id: card.step.request_id, ms: 4000, typed: `${request.b.handle} "${request.b.confirm!.expected}"` });
    expect(events("p03").find((e) => e.type === "decision" && e.request_id === card.step.request_id)).toMatchObject({ decision: "approve", option: "typed" });
    expect(events("p03").filter((e) => e.type === "confirm_wrong")).toEqual([]);
  });

  it("the right value approves", async () => {
    const card = await toTypedCard();
    const expected = loadSet("X").requests.find((r) => r.id === card.step.request_id)!.b.confirm!.expected;
    await post("p03", "answer", { request_id: card.step.request_id, ms: 4000, typed: expected });
    expect(events("p03").find((e) => e.type === "decision" && e.request_id === card.step.request_id)).toMatchObject({ decision: "approve", option: "typed", confirm_attempts: 1 });
  });
});

describe("stopping", () => {
  it("records the stop, shows the stopped page, and records nothing after it", async () => {
    await post("p01", "consent", consent);
    expect((await post("p01", "stop")).step.step).toBe("stopped");
    const count = events("p01").length;
    await post("p01", "briefing");
    await post("p01", "stop");
    expect((await state("p01")).step.step).toBe("stopped");
    expect(events("p01")).toHaveLength(count);
  });
});

describe("results files", () => {
  it("are per participant and private to the owner", async () => {
    await post("p01", "consent", consent);
    await post("p02", "consent", consent);
    expect(readdirSync(dir).sort()).toEqual(["p01.jsonl", "p02.jsonl"]);
    expect(statSync(join(dir, "p01.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("refuses to run a dry run against the real results directory", () => {
    expect(() => createLabServer({ resultsDir: DEFAULT_RESULTS_DIR, secret: SECRET, synthetic: true })).toThrow(/synthetic/);
  });

  it("refuses to start without a link secret", () => {
    expect(() => createLabServer({ resultsDir: dir, secret: "" })).toThrow(/STUDY_LINK_SECRET/);
  });

  it("the real results directory is gitignored", () => {
    expect(readFileSync(join(import.meta.dirname, "../../.gitignore"), "utf8")).toMatch(/^study\/results\/$/m);
  });
});

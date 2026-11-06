/**
 * Real drills, through `sendDrill`, against the two things approvers can read: the ledger mirror in
 * #approvals and the inbox in their direct room. Neither may give a drill away while it is open, and the team
 * only ever sees totals (PLAN F9).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFlaws } from "../src/drills/library.js";
import { isInboxMessage } from "../src/inbox/inbox.js";
import { createInboxKeeper } from "../src/inbox/keeper.js";
import type { LedgerEntry } from "../src/ledger/ledger.js";
import { createLedgerMirror, MIRROR_EVERY_MS, STATE_DOCUMENT, type LedgerMirror, redactedEntry } from "../src/ledger/mirror.js";
import type { OpenedCard } from "./fakes.js";
import { DRILLS_PATH, gateRefund, makeHarness, MINUTE, PARTICIPANTS, REFUND_SC3, REFUND_SC4, type Harness } from "./harness.js";

let h: Harness;
let mirror: LedgerMirror;

beforeEach(() => {
  h = makeHarness({ runningInbox: true });
  mirror = createLedgerMirror(h.core, { chat: h.chat, clock: h.clock, policyRoom: "#approvals" });
});
afterEach(() => h.core.close());

const DAY = 24 * 60 * MINUTE;
const support = { session: { switchRoomId: "#support", threadId: "t-1" } };

const send = async (person: string, flaw?: string) => {
  const result = await h.core.sendDrill(person, flaw);
  if (!result.ok) throw new Error(result.reason);
  return result.requestId;
};
const cardFor = (requestId: string, roomId: string) => {
  const row = h.core.stores.routes.forRequest(requestId).find((entry) => entry.card_room === roomId);
  if (!row) throw new Error(`no card for ${requestId} in ${roomId}`);
  return h.chat.cards.find((card) => card.switchRequestId === row.switch_request_id) as OpenedCard;
};
const press = (card: OpenedCard, who: string, answer: string) =>
  h.core.onApprovalOutcome({ sessionId: card.sessionId, switchRequestId: card.switchRequestId, kind: "approval", state: "answered", answer, answeredBy: who, answeredAtMs: h.clock.nowMs() });

const latest = () => {
  const documents = new Map<string, string>();
  for (const document of h.chat.documents) documents.set(document.name, document.content);
  return documents;
};
const entries = () =>
  [...latest().entries()]
    .filter(([name]) => name.startsWith("clearance-ledger-"))
    .flatMap(([, content]) => content.split("\n").filter((line) => line.startsWith("{")))
    .map((line) => JSON.parse(line) as LedgerEntry);
const stateText = () => latest().get(STATE_DOCUMENT) ?? "";
const afterTick = () => new Promise((done) => setImmediate(done));

describe("the mirror, with a real drill open", () => {
  it("writes nothing, on demand or on its timer", async () => {
    await mirror.flush();
    const before = h.chat.documents.length;
    const id = await send("sam");
    expect(await mirror.flush()).toMatchObject({ ok: true, documents: [], state_updated: false });
    h.clock.advance(MIRROR_EVERY_MS + 1_000);
    mirror.tick();
    await afterTick();
    expect(h.chat.documents).toHaveLength(before);
    expect(h.chat.documents.map((document) => document.content).join()).not.toContain(id);
  });

  it("holds back real requests too, so that one absent card says nothing", async () => {
    await mirror.flush();
    await send("sam");
    const real = await h.core.check(gateRefund(REFUND_SC4, support));
    await mirror.flush();
    expect(entries().some((entry) => entry.request_id === real.request_id)).toBe(false);
    expect(stateText()).not.toContain(real.request_id!);
  });
});

describe("the mirror, once a real drill has closed", () => {
  const withheldFrom = (ledger: LedgerEntry[], id: string) => ledger.filter((entry) => !entry.type.startsWith("drill_") && entry.request_id !== id);

  it("copies everything real and nothing of the drill, when it was caught", async () => {
    const id = await send("sam");
    const real = await h.core.check(gateRefund(REFUND_SC4, support));
    await press(cardFor(id, "dm-sam"), PARTICIPANTS.sam, "deny");
    expect(h.core.describeRequest(id)?.state).toBe("DENIED");

    const report = await mirror.flush();
    expect(report.ok).toBe(true);
    expect(report.mirrored_seq).toBe(report.head_seq);
    expect(entries()).toEqual(withheldFrom(h.core.stores.ledger.list(), id).map(redactedEntry));
    expect(entries().some((entry) => entry.request_id === real.request_id)).toBe(true);
    expect(h.chat.documents.map((document) => document.content).join()).not.toContain(id);
  });

  it("says nothing about who was asked or how it went, and names no flaw, when it was missed", async () => {
    const id = await send("sam");
    await press(cardFor(id, "dm-sam"), PARTICIPANTS.sam, "allow");
    expect(h.core.stores.ledger.list({ requestId: id }).map((entry) => entry.type)).toContain("drill_result");
    await mirror.flush();

    const text = h.chat.documents.map((document) => document.content).join("\n");
    for (const flaw of loadFlaws(DRILLS_PATH)) {
      expect(text).not.toContain(flaw.id);
      expect(text).not.toContain(flaw.explain);
    }
    expect(text).not.toContain("drill_sent");
    expect(text).not.toContain("drill_result");
    expect(entries().every((entry) => entry.request_id !== id)).toBe(true);
  });

  it("keeps back an entry on the drill that isn't called drill_: a refused answer says who tried", async () => {
    const id = await send("sam");
    await press(cardFor(id, "dm-sam"), PARTICIPANTS.guest, "allow");
    expect(h.core.stores.ledger.list({ requestId: id }).map((entry) => entry.type)).toContain("ineligible_answer");
    // Refused, so it is still open and the mirror still stands still.
    expect(await mirror.flush()).toMatchObject({ documents: [], state_updated: false });

    h.clock.advance(26 * MINUTE);
    await h.core.tick();
    await mirror.flush();
    const text = h.chat.documents.map((document) => document.content).join("\n");
    expect(text).not.toContain(PARTICIPANTS.guest);
    expect(text).not.toContain(id);
  });

  it("carries nothing into a later real request by the person who missed it", async () => {
    await press(cardFor(await send("sam"), "dm-sam"), PARTICIPANTS.sam, "allow");
    const real = await h.core.check(gateRefund(REFUND_SC4, support));
    await press(cardFor(real.request_id!, "dm-sam"), PARTICIPANTS.sam, "allow");
    await mirror.flush();
    expect(entries().some((entry) => entry.request_id === real.request_id)).toBe(true);
    for (const entry of entries()) expect(JSON.stringify(entry)).not.toMatch(/drill/i);
  });

  it("goes back to writing when one expires unanswered", async () => {
    const id = await send("sam");
    h.clock.advance(26 * MINUTE);
    await h.core.tick();
    expect(h.core.describeRequest(id)?.state).toBe("EXPIRED");
    const report = await mirror.flush();
    expect(report.ok).toBe(true);
    expect(report.mirrored_seq).toBe(report.head_seq);
    expect(h.chat.documents.map((document) => document.content).join()).not.toContain(id);
  });

  it("reports totals in whole groups only, with nobody named", async () => {
    await press(cardFor(await send("sam"), "dm-sam"), PARTICIPANTS.sam, "deny");
    await mirror.flush();
    expect(stateText()).toContain("Totals appear once 3 have finished");
    expect(stateText()).not.toMatch(/\d caught/);

    h.clock.advance(DAY + MINUTE);
    await press(cardFor(await send("sam"), "dm-sam"), PARTICIPANTS.sam, "allow");
    await mirror.flush();
    expect(stateText()).not.toMatch(/\d caught/);

    h.clock.advance(DAY + MINUTE);
    await send("sam");
    h.clock.advance(26 * MINUTE);
    await h.core.tick();
    await mirror.flush();
    expect(stateText()).toContain("3 finished: 1 caught, 1 missed, 1 not answered.");
    expect(stateText()).not.toMatch(/\bsam\b/i);
  });
});

describe("the inbox, with a real drill", () => {
  const keeper = () => createInboxKeeper(h.core, { chat: h.chat, clock: h.clock });
  const posts = () => [...h.chat.targeted, ...h.chat.messages].filter((post) => post.roomId === "dm-sam" && isInboxMessage(post.body)).map((post) => post.body);

  it("reads like the real request above or below it, with the same fields", async () => {
    const real = await h.core.check(gateRefund(REFUND_SC3, support));
    h.clock.advance(MINUTE);
    const id = await send("sam", "new_destination");
    await keeper().sync();

    const [asDrill, asReal] = h.core.inboxItems("sam");
    expect(asDrill?.request_id).toBe(id);
    expect(asReal?.request_id).toBe(real.request_id);
    expect(Object.keys(asDrill!)).toEqual(Object.keys(asReal!));
    expect(asDrill?.room).toBe("#support");
    expect(asDrill?.shared_in).toBeNull();

    const lines = posts().at(-1)!.split("\n");
    expect(lines[0]).toBe("**Needs your response (2)**");
    expect(lines[1]).toMatch(new RegExp(`^${id} refund ₹[\\d,]+ · #support · 0 s$`));
    expect(lines[2]).toMatch(new RegExp(`^${real.request_id} refund ₹[\\d,]+ · #support · 1 min$`));
    expect(posts().join()).not.toMatch(/drill|practice|flaw/i);
    expect(JSON.stringify(h.core.inbox("sam"))).not.toMatch(/drill|flaw/i);
  });

  it("is told the same way, and adds no third line about the card", async () => {
    await send("sam");
    await keeper().sync();
    const told = h.chat.targeted.filter((post) => post.roomId === "dm-sam");
    expect(told).toHaveLength(1);
    expect(told[0]?.targets).toEqual(["sam"]);
    expect(isInboxMessage(told[0]!.body)).toBe(true);
  });

  it("leaves the list the same way when it is answered", async () => {
    await h.core.check(gateRefund(REFUND_SC4, support));
    const id = await send("sam");
    const inbox = keeper();
    await inbox.sync();
    await press(cardFor(id, "dm-sam"), PARTICIPANTS.sam, "deny");
    await inbox.sync();
    expect(posts().at(-1)).toContain("(1)");
    expect(posts().at(-1)).not.toContain(id);
  });

  it("gets one card, for the person it was meant for, even if a tick lands while it opens", async () => {
    const open = h.chat.openCard.bind(h.chat);
    const release: (() => void)[] = [];
    h.chat.openCard = async (input) => {
      const result = await open(input);
      await new Promise<void>((done) => release.push(done));
      return result;
    };
    const sending = h.core.sendDrill("neha");
    while (h.chat.cards.length === 0) await afterTick();
    const tick = h.core.tick();
    for (let turn = 0; turn < 50; turn += 1) {
      release.splice(0).forEach((done) => done());
      await afterTick();
    }
    await Promise.all([sending, tick]);
    expect(h.chat.cards.map((card) => card.roomId)).toEqual(["dm-neha"]);
  });
});

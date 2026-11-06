/** F8's mirror: the ledger as room documents. The SQLite ledger is the truth and nothing waits on the copy. */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import type { LedgerEntry } from "../src/ledger/ledger.js";
import { createLedgerMirror, dayOf, drillTotals, ledgerDocuments, redactedEntry, MAX_DOCUMENT_BYTES, MIRROR_EVERY_MS, renderClearanceState, STATE_DOCUMENT, type LedgerMirror } from "../src/ledger/mirror.js";
import { chatMessage, gateRefund, makeHarness, MINUTE, NOW, PARTICIPANTS, REFUND_SC3, REFUND_SC4, type Harness } from "./harness.js";

const TZ = "Asia/Kolkata";
const DAY = "2026-11-04";

let h: Harness;
let mirror: LedgerMirror;

const mirrorOf = (harness: Harness, extra: { maxBytes?: number; log?: (m: string) => void } = {}) =>
  createLedgerMirror(harness.core, { chat: harness.chat, clock: harness.clock, policyRoom: "#approvals", ...extra });

beforeEach(() => {
  h = makeHarness();
  mirror = mirrorOf(h);
});
afterEach(() => {
  h.core.close();
});

const documentsNamed = (name: string) => h.chat.documents.filter((document) => document.name === name);
const entriesIn = (content: string) =>
  content
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as LedgerEntry);

/** Nothing in the chain missing or out of order across a set of documents, by reading them back. */
function latestByName(): Map<string, string> {
  const latest = new Map<string, string>();
  for (const document of h.chat.documents) latest.set(document.name, document.content);
  return latest;
}

/** tick starts a copy and returns at once, and with fakes the copy is done a turn later. */
const afterTick = () => new Promise((done) => setImmediate(done));

describe("what goes in the room", () => {
  it("names one document per day and puts every entry in it, exactly as the room may read it", async () => {
    await h.core.check(gateRefund(REFUND_SC4));
    const report = await mirror.flush();
    expect(report.ok).toBe(true);
    expect(report.documents).toEqual([`clearance-ledger-${DAY}`]);

    const [document] = documentsNamed(`clearance-ledger-${DAY}`);
    expect(document?.roomId).toBe("#approvals");
    expect(entriesIn(document!.content)).toEqual(h.core.stores.ledger.list().map(redactedEntry));
  });

  it("says it is a copy and how to check the truth", async () => {
    const report = await mirror.flush();
    expect(report.ok).toBe(true);
    const [document] = documentsNamed(`clearance-ledger-${DAY}`);
    expect(document?.content).toContain("This is a copy");
    expect(document?.content).toContain("pnpm ledger:verify");
  });

  it("writes clearance-state with open requests and autonomy levels", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    await h.core.check(gateRefund(REFUND_SC4));
    await mirror.flush();
    const [state] = documentsNamed(STATE_DOCUMENT);
    expect(state?.roomId).toBe("#approvals");
    expect(state?.content).toContain("## Open requests (1)");
    expect(state?.content).toContain("CLR-0001 · REFUND ₹40,000");
    expect(state?.content).toContain("with Sam");
    expect(state?.content).toContain("0 of 1 approvals");
    expect(state?.content).toContain("## Autonomy levels");
  });

  it("lists an earned autonomy level", () => {
    const text = renderClearanceState({
      policyHash: "abc",
      tz: TZ,
      open: [],
      autonomy: [{ agent: "refunds-agent", class: "refund", bucket: "under-5000", level: "L2", since: NOW }],
    });
    expect(text).toContain(`refunds-agent · refund · under-5000 · L2 since ${DAY}`);
    expect(text).toContain("## Open requests (0)\nNone.");
  });
});

describe("days and rollover", () => {
  const entry = (seq: number, at: string, payload: Record<string, unknown> = {}): LedgerEntry => ({
    seq,
    at,
    type: "held",
    request_id: `CLR-${seq}`,
    payload,
    prev_hash: "p".repeat(64),
    entry_hash: "e".repeat(64),
  });

  it("counts the day in the team's zone, which is the date the team would look for", () => {
    // 19:00 UTC is already the next day in India.
    expect(dayOf("2026-11-04T19:00:00.000Z", TZ)).toBe("2026-11-05");
    const documents = ledgerDocuments([entry(1, "2026-11-04T18:00:00.000Z"), entry(2, "2026-11-04T19:00:00.000Z")], { tz: TZ });
    expect(documents.map((document) => document.name)).toEqual(["clearance-ledger-2026-11-04", "clearance-ledger-2026-11-05"]);
  });

  it("rolls a full day into -2, -3, with every entry in exactly one, in order", () => {
    const entries = Array.from({ length: 40 }, (_, index) => entry(index + 1, "2026-11-04T10:00:00.000Z", { pad: "x".repeat(200) }));
    const documents = ledgerDocuments(entries, { tz: TZ, maxBytes: 2_500 });
    expect(documents.length).toBeGreaterThan(2);
    expect(documents.map((document) => document.name).slice(0, 3)).toEqual([
      "clearance-ledger-2026-11-04",
      "clearance-ledger-2026-11-04-2",
      "clearance-ledger-2026-11-04-3",
    ]);
    for (const document of documents) expect(Buffer.byteLength(document.content)).toBeLessThanOrEqual(2_500);
    expect(documents.flatMap((document) => entriesIn(document.content))).toEqual(entries);
  });

  it("stays under Switch's limit at the real budget, counting bytes and not characters", () => {
    const entries = Array.from({ length: 60 }, (_, index) => entry(index + 1, "2026-11-04T10:00:00.000Z", { pad: "₹".repeat(20_000) }));
    const documents = ledgerDocuments(entries, { tz: TZ });
    expect(documents.length).toBeGreaterThan(1);
    for (const document of documents) expect(Buffer.byteLength(document.content)).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
    expect(MAX_DOCUMENT_BYTES).toBeLessThan(1_048_576);
    expect(documents.flatMap((document) => entriesIn(document.content))).toEqual(entries);
  });

  it("gives the same documents every time, so a retry rewrites them rather than shuffling them", () => {
    const entries = Array.from({ length: 30 }, (_, index) => entry(index + 1, "2026-11-04T10:00:00.000Z", { pad: "x".repeat(150) }));
    const once = ledgerDocuments(entries, { tz: TZ, maxBytes: 2_000 });
    const again = ledgerDocuments(entries, { tz: TZ, maxBytes: 2_000 });
    expect(again).toEqual(once);
    // Appending more leaves every full document as it was. It may fill the last one, or start another.
    const later = ledgerDocuments([...entries, entry(31, "2026-11-04T10:00:00.000Z", { pad: "y" })], { tz: TZ, maxBytes: 2_000 });
    expect(later.slice(0, once.length - 1)).toEqual(once.slice(0, -1));
  });

  it("keeps an entry too big for any document in its place, and says where the rest is", () => {
    const big = entry(2, "2026-11-04T10:00:00.000Z", { pad: "x".repeat(5_000) });
    const documents = ledgerDocuments([entry(1, "2026-11-04T10:00:00.000Z"), big, entry(3, "2026-11-04T10:00:00.000Z")], { tz: TZ, maxBytes: 2_000 });
    const lines = documents.flatMap((document) => entriesIn(document.content));
    expect(lines.map((line) => line.seq)).toEqual([1, 2, 3]);
    const stub = lines[1] as unknown as Record<string, unknown>;
    expect(stub.payload).toBeUndefined();
    expect(stub.entry_hash).toBe(big.entry_hash);
    expect(String(stub.payload_omitted)).toContain("/v1/ledger?after=1&limit=1");
    for (const document of documents) expect(Buffer.byteLength(document.content)).toBeLessThanOrEqual(2_000);
  });

  it("keeps a day's entries in an unbroken run even if the clock goes backwards at midnight", () => {
    const documents = ledgerDocuments([entry(1, "2026-11-04T18:29:00.000Z"), entry(2, "2026-11-04T18:31:00.000Z"), entry(3, "2026-11-04T18:29:30.000Z"), entry(4, "2026-11-04T18:32:00.000Z")], { tz: TZ });
    expect(documents.map((document) => [document.firstSeq, document.lastSeq])).toEqual([
      [1, 1],
      [2, 4],
    ]);
  });
});

describe("at most every 5 real minutes", () => {
  it("copies the first time it is due, without being asked", async () => {
    expect(h.chat.documents).toEqual([]);
    mirror.tick();
    await afterTick();
    expect(documentsNamed(`clearance-ledger-${DAY}`)).toHaveLength(1);
    expect(mirror.status().mirrored_seq).toBe(mirror.status().head_seq);
  });

  it("holds new entries back inside the window", async () => {
    await mirror.flush();
    const before = h.chat.documents.length;
    await h.core.check(gateRefund(REFUND_SC4));
    h.clock.advance(MIRROR_EVERY_MS - 1_000);
    mirror.tick();
    await afterTick();
    expect(h.chat.documents).toHaveLength(before);
    h.clock.advance(1_000);
    mirror.tick();
    await afterTick();
    expect(h.chat.documents.length).toBeGreaterThan(before);
  });

  it("means real minutes, whatever CLEARANCE_TIME_SCALE says", async () => {
    const fast = makeHarness({ scale: 10 });
    const fastMirror = mirrorOf(fast);
    await fastMirror.flush();
    const before = fast.chat.documents.length;
    await fast.core.check(gateRefund(REFUND_SC4));
    fast.clock.advance(MIRROR_EVERY_MS / 10 + 1_000);
    fastMirror.tick();
    await afterTick();
    expect(fast.chat.documents).toHaveLength(before);
    fast.core.close();
  });

  it("posts nothing at all when nothing changed, however long it has been", async () => {
    await mirror.flush();
    const before = h.chat.documents.length;
    h.clock.advance(60 * MINUTE);
    mirror.tick();
    await afterTick();
    expect(h.chat.documents).toHaveLength(before);
    const report = await mirror.flush();
    expect(report).toMatchObject({ ok: true, documents: [], state_updated: false });
  });

  it("copies at once on demand, inside the window", async () => {
    await mirror.flush();
    await h.core.check(gateRefund(REFUND_SC4));
    const report = await mirror.flush();
    expect(report.documents).toEqual([`clearance-ledger-${DAY}`]);
    expect(report.state_updated).toBe(true);
    expect(report.mirrored_seq).toBe(report.head_seq);
  });

  it("only rewrites what changed: clearance-state stays quiet when only the ledger moved", async () => {
    await h.core.check(gateRefund(REFUND_SC4));
    await mirror.flush();
    const states = documentsNamed(STATE_DOCUMENT).length;
    h.core.stores.ledger.append("policy_loaded", null, { note: "the ledger moved and no request did" });
    const report = await mirror.flush();
    expect(report.documents).toHaveLength(1);
    expect(report.state_updated).toBe(false);
    expect(documentsNamed(STATE_DOCUMENT)).toHaveLength(states);
  });

  it("leaves yesterday's document alone, since every rewrite posts a notice in the room", async () => {
    await mirror.flush();
    h.clock.advance(24 * 60 * MINUTE);
    h.core.stores.ledger.append("policy_loaded", null, { note: "the next day" });
    const report = await mirror.flush();
    expect(report.documents).toEqual(["clearance-ledger-2026-11-05"]);
    expect(documentsNamed(`clearance-ledger-${DAY}`)).toHaveLength(1);
  });

  it("does not start a second copy while one runs", async () => {
    await h.core.check(gateRefund(REFUND_SC4));
    const [one, two] = await Promise.all([mirror.flush(), mirror.flush()]);
    expect(two).toBe(one);
    expect(documentsNamed(`clearance-ledger-${DAY}`)).toHaveLength(1);
  });

  it("remembers across a restart, so a crash loop can't flood the room with notices", async () => {
    await mirror.flush();
    const before = h.chat.documents.length;
    h = h.restart();
    mirror = mirrorOf(h);
    await h.core.check(gateRefund(REFUND_SC4));
    mirror.tick();
    await afterTick();
    expect(h.chat.documents).toHaveLength(before);
    expect(mirror.status().mirrored_seq).toBeGreaterThan(0);
  });
});

describe("failure", () => {
  const breakDocuments = (harness: Harness) => {
    const working = harness.chat.upsertDocument.bind(harness.chat);
    harness.chat.upsertDocument = async () => {
      throw new Error("switch unreachable");
    };
    return () => {
      harness.chat.upsertDocument = working;
    };
  };

  it("never blocks a decision", async () => {
    breakDocuments(h);
    await expect(mirror.flush()).resolves.toMatchObject({ ok: false, error: "switch unreachable" });
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    const held = await h.core.check(gateRefund(REFUND_SC4));
    expect(held.decision).toBe("hold");
    await h.core.onApprovalOutcome({
      sessionId: h.chat.cardIn("dm-sam").sessionId,
      switchRequestId: h.chat.cardIn("dm-sam").switchRequestId,
      kind: "approval",
      state: "answered",
      answer: "allow",
      answeredBy: PARTICIPANTS.sam,
    });
    expect(h.core.describeRequest(held.request_id!)?.state).toBe("EXECUTED");
  });

  it("doesn't wait: a stuck Switch leaves tick returning at once", async () => {
    let release: () => void = () => {};
    h.chat.upsertDocument = () =>
      new Promise((done) => {
        release = done;
      });
    mirror.tick();
    const startedAt = Date.now();
    mirror.tick();
    expect(Date.now() - startedAt).toBeLessThan(50);
    const held = await h.core.check(gateRefund(REFUND_SC4));
    expect(held.decision).toBe("hold");
    release();
  });

  it("loses nothing: what failed is copied by the next try, in full", async () => {
    await h.core.check(gateRefund(REFUND_SC3));
    const repair = breakDocuments(h);
    const failed = await mirror.flush();
    expect(failed.ok).toBe(false);
    expect(failed.mirrored_seq).toBe(0);
    await h.core.check(gateRefund(REFUND_SC4));

    repair();
    const report = await mirror.flush();
    expect(report.ok).toBe(true);
    expect(report.mirrored_seq).toBe(report.head_seq);
    expect(entriesIn(latestByName().get(`clearance-ledger-${DAY}`)!)).toEqual(h.core.stores.ledger.list().map(redactedEntry));
  });

  it("keeps its place when it fails partway, on the document that failed", async () => {
    h.core.stores.ledger.append("policy_loaded", null, { pad: "x".repeat(3_000) });
    h.core.stores.ledger.append("policy_loaded", null, { pad: "y".repeat(3_000) });
    h.core.stores.ledger.append("policy_loaded", null, { pad: "z".repeat(3_000) });
    const small = mirrorOf(h, { maxBytes: 4_000 });
    const working = h.chat.upsertDocument.bind(h.chat);
    let calls = 0;
    h.chat.upsertDocument = async (input) => {
      calls += 1;
      if (calls === 2) throw new Error("the second one failed");
      await working(input);
    };
    const failed = await small.flush();
    expect(failed.ok).toBe(false);
    expect(failed.documents).toHaveLength(1);
    expect(failed.mirrored_seq).toBeGreaterThan(0);
    expect(failed.mirrored_seq).toBeLessThan(failed.head_seq);

    const report = await small.flush();
    expect(report.ok).toBe(true);
    expect(report.mirrored_seq).toBe(report.head_seq);
    const copied = [...latestByName().entries()].filter(([name]) => name.startsWith("clearance-ledger-")).flatMap(([, content]) => entriesIn(content));
    expect(copied.map((entry) => entry.seq).sort((a, b) => a - b)).toEqual(h.core.stores.ledger.list().map((entry) => entry.seq));
  });

  it("waits a minute before trying again, not 5 and not every second", async () => {
    await h.core.check(gateRefund(REFUND_SC3));
    const repair = breakDocuments(h);
    mirror.tick();
    await afterTick();
    expect(mirror.status().last_error).toBe("switch unreachable");
    repair();
    h.clock.advance(30_000);
    mirror.tick();
    await afterTick();
    expect(h.chat.documents).toEqual([]);
    h.clock.advance(31_000);
    mirror.tick();
    await afterTick();
    expect(h.chat.documents.length).toBeGreaterThan(0);
    expect(mirror.status().last_error).toBeNull();
  });

  it("keeps the ledger itself verifying whatever the mirror did", async () => {
    await h.core.check(gateRefund(REFUND_SC4));
    breakDocuments(h);
    await mirror.flush();
    expect(h.core.verifyLedger().ok).toBe(true);
  });
});

describe("drills", () => {
  const SECRET_FLAW = "new_destination";

  /** A request that is a drill, with the entries a drill leaves. Real requests are the rest of the test's. */
  const openDrill = async (args = REFUND_SC3): Promise<string> => {
    const held = await h.core.check(gateRefund(args));
    const id = held.request_id!;
    h.core.stores.db.prepare(`UPDATE requests SET is_drill = 1 WHERE id = ?`).run(id);
    h.core.stores.ledger.append("drill_sent", id, { agent: "refunds-agent", class: "refund", tier: "high" });
    return id;
  };
  const closeDrill = (id: string, result = "caught", state: "DENIED" | "EXPIRED" = "DENIED") => {
    h.core.stores.requests.transition(id, state);
    h.core.stores.ledger.append("drill_result", id, { result, user_id: "sam", flaw: SECRET_FLAW, latency_ms: 1800 });
  };
  const everything = () => h.chat.documents.map((document) => document.content).join("\n");
  const published = () =>
    [...latestByName().entries()].filter(([name]) => name.startsWith("clearance-ledger-")).flatMap(([, content]) => entriesIn(content));

  describe("while one is open", () => {
    it("writes nothing at all, so no document can differ, however it is asked", async () => {
      await mirror.flush();
      const before = h.chat.documents.length;
      const id = await openDrill();
      await h.core.check(gateRefund(REFUND_SC4));

      const onDemand = await mirror.flush();
      expect(onDemand).toMatchObject({ ok: true, documents: [], state_updated: false });
      h.clock.advance(MIRROR_EVERY_MS * 2);
      mirror.tick();
      await afterTick();

      expect(h.chat.documents).toHaveLength(before);
      expect(everything()).not.toContain(id);
    });

    it("doesn't update clearance-state alone, which would point at the card that just arrived", async () => {
      await mirror.flush();
      const states = documentsNamed(STATE_DOCUMENT).length;
      await openDrill();
      await mirror.flush();
      expect(documentsNamed(STATE_DOCUMENT)).toHaveLength(states);
    });

    it("doesn't move its place, so later entries can't show a gap", async () => {
      await mirror.flush();
      const place = mirror.status().mirrored_seq;
      await openDrill();
      await h.core.check(gateRefund(REFUND_SC4));
      await mirror.flush();
      expect(mirror.status().mirrored_seq).toBe(place);
      expect(mirror.status().head_seq).toBeGreaterThan(place);
    });

    it("stops before writing clearance-state if one opens partway through a copy", async () => {
      await h.core.check(gateRefund(REFUND_SC4));
      const working = h.chat.upsertDocument.bind(h.chat);
      const held = await h.core.check(gateRefund(REFUND_SC3));
      let opened = false;
      h.chat.upsertDocument = async (input) => {
        await working(input);
        if (!opened) {
          opened = true;
          h.core.stores.db.prepare(`UPDATE requests SET is_drill = 1 WHERE id = ?`).run(held.request_id);
        }
      };
      const report = await mirror.flush();
      expect(report.documents).toHaveLength(1);
      expect(report.state_updated).toBe(false);
      expect(documentsNamed(STATE_DOCUMENT)).toEqual([]);
    });

    it("leaves a decision alone: holds and answers go on as usual", async () => {
      await openDrill();
      const held = await h.core.check(gateRefund(REFUND_SC4));
      await mirror.flush();
      expect(held.decision).toBe("hold");
      expect(h.core.verifyLedger().ok).toBe(true);
    });
  });

  describe("once it has closed", () => {
    it("copies the real entries it held back, in order, and none of the drill's", async () => {
      await mirror.flush();
      const id = await openDrill();
      const real = await h.core.check(gateRefund(REFUND_SC4));
      await mirror.flush();
      closeDrill(id);

      const report = await mirror.flush();
      expect(report.ok).toBe(true);
      expect(report.mirrored_seq).toBe(report.head_seq);
      const seqs = published().map((entry) => entry.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(published().some((entry) => entry.request_id === real.request_id)).toBe(true);
      expect(published().some((entry) => entry.request_id === id)).toBe(false);

      const expected = h.core.stores.ledger.list().filter((entry) => !entry.type.startsWith("drill_") && entry.request_id !== id).map(redactedEntry);
      expect(published()).toEqual(expected);
    });

    it("publishes nothing anywhere that says who was asked, what they did, how fast, or what the flaw was", async () => {
      const id = await openDrill();
      closeDrill(id, "missed");
      h.core.stores.ledger.append("ineligible_answer", id, { answered_by: PARTICIPANTS.neha, user_id: "neha", reasons: ["not_routed"] });
      await mirror.flush();
      const text = everything();
      expect(text).not.toContain(id);
      expect(text).not.toContain(SECRET_FLAW);
      expect(text).not.toContain("1800");
      expect(text).not.toContain("drill_sent");
      expect(text).not.toContain("drill_result");
      expect(text).not.toContain(PARTICIPANTS.neha);
      expect(published().every((entry) => !JSON.stringify(entry).toLowerCase().includes("drill"))).toBe(true);
    });

    it("counts its entries as done even when there is nothing to write for them", async () => {
      await mirror.flush();
      const before = h.chat.documents.length;
      const id = await openDrill();
      closeDrill(id);
      const report = await mirror.flush();
      expect(report.mirrored_seq).toBe(report.head_seq);
      expect(report.documents).toEqual([]);
      expect(h.chat.documents.filter((document) => document.name !== STATE_DOCUMENT)).toHaveLength(before - documentsNamed(STATE_DOCUMENT).length);
    });

    it("says in every document that numbers can skip, so a skip is no news", async () => {
      await mirror.flush();
      expect(documentsNamed(`clearance-ledger-${DAY}`)[0]?.content).toContain("the numbers can skip");
    });

    it("loses nothing if the copy that follows fails", async () => {
      const id = await openDrill();
      await h.core.check(gateRefund(REFUND_SC4));
      closeDrill(id);
      const working = h.chat.upsertDocument.bind(h.chat);
      h.chat.upsertDocument = async () => {
        throw new Error("switch unreachable");
      };
      expect((await mirror.flush()).ok).toBe(false);
      expect(mirror.status().mirrored_seq).toBe(0);
      h.chat.upsertDocument = working;
      expect((await mirror.flush()).ok).toBe(true);
      expect(published()).toEqual(h.core.stores.ledger.list().filter((entry) => !entry.type.startsWith("drill_") && entry.request_id !== id).map(redactedEntry));
    });

    it("withholds a drill entry that names no request", async () => {
      h.core.stores.ledger.append("drill_result", null, { result: "caught", user_id: "sam" });
      await mirror.flush();
      expect(everything()).not.toContain("drill_result");
    });
  });

  describe("the totals", () => {
    const stateOf = () => documentsNamed(STATE_DOCUMENT).at(-1)!.content;

    it("are only ever whole groups, so that one person's result can't be read off", () => {
      expect(drillTotals([])).toContain("Totals appear once 3 have finished");
      expect(drillTotals(["missed"])).toContain("Totals appear once 3 have finished");
      expect(drillTotals(["missed"])).not.toContain("missed");
      expect(drillTotals(["caught", "missed"])).not.toMatch(/\d caught/);
      expect(drillTotals(["caught", "missed", "expired"])).toContain("3 finished: 1 caught, 1 missed, 1 not answered.");
    });

    it("don't move for a fourth or fifth, so comparing two totals can't isolate anyone", () => {
      const three = drillTotals(["caught", "caught", "missed"]);
      expect(drillTotals(["caught", "caught", "missed", "missed"])).toBe(three);
      expect(drillTotals(["caught", "caught", "missed", "missed", "caught"])).toBe(three);
      expect(drillTotals(["caught", "caught", "missed", "missed", "caught", "caught"])).toContain("6 finished: 4 caught, 2 missed");
    });

    it("leave out a drill nobody saw", () => {
      expect(drillTotals(["not_sent", "caught", "not_sent", "missed"])).toContain("Totals appear once");
    });

    it("reach clearance-state with no names, and the section is there either way", async () => {
      await mirror.flush();
      expect(stateOf()).toContain("## Drills");
      expect(stateOf()).toContain("Totals appear once 3 have finished");

      for (const [args, result] of [
        [{ ...REFUND_SC3, amount: 11_000 }, "caught"],
        [{ ...REFUND_SC3, amount: 12_000 }, "missed"],
        [{ ...REFUND_SC3, amount: 13_000 }, "caught"],
      ] as const) closeDrill(await openDrill(args), result);
      await mirror.flush();
      expect(stateOf()).toContain("3 finished: 2 caught, 1 missed, 0 not answered.");
      expect(stateOf()).not.toMatch(/\bsam\b/i);
      expect(stateOf()).not.toContain(SECRET_FLAW);
    });
  });
});

describe("the API", () => {
  const TOKEN = "test-internal-token";
  const auth = { authorization: `Bearer ${TOKEN}` };
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildServer(h.core, { internalToken: TOKEN, mirror });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it("copies on demand and reports how far it got", async () => {
    await h.core.check(gateRefund(REFUND_SC4));
    const response = await app.inject({ method: "POST", url: "/v1/ledger/mirror", headers: auth });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.mirrored_seq).toBe(body.head_seq);
    const status = (await app.inject({ method: "GET", url: "/v1/ledger/mirror", headers: auth })).json();
    expect(status.mirrored_seq).toBe(body.mirrored_seq);
    expect(status.last_mirrored_at).toBe(new Date(NOW).toISOString());
  });

  it("is behind the same token as the rest", async () => {
    expect((await app.inject({ method: "POST", url: "/v1/ledger/mirror" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/ledger/mirror" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/ledger/mirror", headers: { authorization: "Bearer test-hook-token" } })).statusCode).toBe(401);
  });

  it("answers 404 with no mirror running, and the ledger routes still serve", async () => {
    const bare = buildServer(h.core, { internalToken: TOKEN });
    await bare.ready();
    expect((await bare.inject({ method: "POST", url: "/v1/ledger/mirror", headers: auth })).statusCode).toBe(404);
    expect((await bare.inject({ method: "GET", url: "/v1/ledger", headers: auth })).statusCode).toBe(200);
    await bare.close();
  });
});

describe("what a person's record looks like from the room (F10)", () => {
  /** Sam approves in under a second: a fast approval, with friction to follow. */
  async function fastApproval(): Promise<string> {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    const held = await h.core.check(gateRefund(REFUND_SC4));
    h.clock.advance(800);
    const card = h.chat.cardIn("dm-sam");
    await h.core.onApprovalOutcome({
      sessionId: card.sessionId,
      switchRequestId: card.switchRequestId,
      kind: "approval",
      state: "answered",
      answer: "allow",
      answeredBy: PARTICIPANTS.sam,
      answeredAtMs: h.clock.nowMs(),
    });
    return held.request_id as string;
  }

  const lines = () =>
    (h.chat.documents.findLast((document) => document.name.startsWith("clearance-ledger-"))?.content ?? "")
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { type: string; at: string; seq: number; entry_hash: string; prev_hash: string; request_id: string | null; payload: Record<string, unknown> });

  it("publishes who answered, and nothing about how fast or what it set off", async () => {
    const id = await fastApproval();
    await mirror.flush();
    const answered = lines().find((line) => line.type === "answered");
    expect(answered?.payload).toMatchObject({ user_id: "sam", decision: "approve" });
    for (const field of ["latency_ms", "fast_approval", "signals", "t_min_ms", "flags_ignored", "typed_field"]) {
      expect(answered?.payload, field).not.toHaveProperty(field);
    }
    const whole = h.chat.documents.map((document) => document.content).join("\n");
    for (const word of ["latency_ms", "fast_approval", "t_min_ms", '"signals"']) expect(whole, word).not.toContain(word);
    expect(lines().find((line) => line.type === "approved")?.payload).toMatchObject({ approved_by: ["sam"] });
    expect(id).toMatch(/^CLR-/);
  });

  it("can't be worked out from the times either: they're to the minute", async () => {
    await fastApproval();
    await mirror.flush();
    for (const line of lines()) expect(line.at, line.type).toMatch(/:00\.000Z$/);
  });

  it("leaves out the routing's picture of each person: load, last seen, and being over-relied on", async () => {
    await fastApproval();
    await mirror.flush();
    const routed = lines().find((line) => line.type === "routed");
    const ranked = routed?.payload.ranked as Record<string, unknown>[];
    expect(ranked.map((person) => person.id)).toContain("sam");
    for (const person of ranked) {
      for (const field of ["openCards", "concentrated", "activeAgoMs", "activeRoom"]) expect(person, field).not.toHaveProperty(field);
    }
  });

  it("leaves out that someone was asked to type, or typed it wrong", async () => {
    h.core.stores.ledger.append("ineligible_answer", "CLR-0099", { user_id: "sam", reasons: ["wrong_confirmation", "requester"] });
    h.core.stores.ledger.append("ineligible_answer", "CLR-0098", { user_id: "sam", reasons: ["needs_typed_confirmation"] });
    await mirror.flush();
    const refused = lines().filter((line) => line.type === "ineligible_answer");
    expect(refused.map((line) => line.payload.reasons)).toEqual([["requester"], []]);
    const whole = h.chat.documents.map((document) => document.content).join("\n");
    expect(whole).not.toContain("wrong_confirmation");
    expect(whole).not.toContain("needs_typed_confirmation");
  });

  it("keeps each entry's hash, so the order can be seen, and says where the full chain is checked", async () => {
    await fastApproval();
    await mirror.flush();
    const all = h.core.stores.ledger.list();
    for (const line of lines()) {
      const real = all.find((entry) => entry.seq === line.seq);
      expect(line.entry_hash).toBe(real?.entry_hash);
      expect(line.prev_hash).toBe(real?.prev_hash);
    }
    const document = h.chat.documents.findLast((candidate) => candidate.name.startsWith("clearance-ledger-"));
    expect(document?.content).toContain("Per-person timing is omitted");
    expect(document?.content).toContain("GET /v1/ledger/verify");
  });

  it("changes nothing in SQLite: the ledger keeps it all and still verifies", async () => {
    const id = await fastApproval();
    await mirror.flush();
    const answered = h.core.stores.ledger.list({ requestId: id }).find((entry) => entry.type === "answered");
    expect(answered?.payload).toMatchObject({ latency_ms: 800, fast_approval: true, signals: ["fast"] });
    expect(h.core.verifyLedger().ok).toBe(true);
  });
});

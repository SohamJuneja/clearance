/**
 * Who oversees the overseers. F18 break-glass (E1 case 23), F19 delegation (case 24), F17 policy changes with
 * quorum 2 (case 25), F22 audit export and digest.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/api/server.js";
import { DETAIL_BUDGET, renderedCost, TITLE_MAX } from "../src/cards/render.js";
import { changeSummary, policyChanges } from "../src/policy/diff.js";
import type { OpenedCard } from "./fakes.js";
import { chatMessage, gateRefund, hookShell, makeHarness, MINUTE, NOW, PARTICIPANTS, POLICY_PATH, REFUND_SC4, type Harness } from "./harness.js";

const DAY = 24 * 60 * MINUTE;
const TOKEN = "test-internal-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const SMALL = { order_id: "A-1931", customer_id: "cus_8812", amount: 2000, destination: "rohan.s@okhdfc" };

function helpers(get: () => Harness) {
  const press = (card: OpenedCard, who: string, answer = "allow") =>
    get().core.onApprovalOutcome({
      sessionId: card.sessionId,
      switchRequestId: card.switchRequestId,
      kind: "approval",
      state: "answered",
      answer,
      answeredBy: who,
      answeredAtMs: get().clock.nowMs(),
    });
  const cardsIn = (room: string) => get().chat.cards.filter((card) => card.roomId === room);
  const lastCard = (room: string) => cardsIn(room).at(-1) as OpenedCard;
  const say = (who: string, body: string, roomId = "#approvals") => get().core.onMessage(chatMessage(who, body, { roomId, threadId: null, addressed: true }));
  const ledger = (type: string) => get().core.stores.ledger.list().filter((entry) => entry.type === type);
  const lastPost = () => get().chat.messages.at(-1)?.body as string;
  return { press, cardsIn, lastCard, say, ledger, lastPost };
}

describe("F18 break-glass", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.core.close());
  const { press, cardsIn, lastCard, say, ledger, lastPost } = helpers(() => h);

  async function held(args: Record<string, unknown> = REFUND_SC4): Promise<string> {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    return (await h.core.check(gateRefund(args))).request_id as string;
  }

  describe("E1 case 23: by someone not on the list", () => {
    it.each([
      ["the requester", "priya"],
      ["an approver who isn't named", "sam"],
      ["an engineer who isn't named", "dev"],
    ] as const)("%s is refused, on the record, and nothing runs", async (_who, person) => {
      const id = await held();
      await say(PARTICIPANTS[person], `@clearance breakglass ${id} it is urgent`);
      expect(h.core.stores.requests.require(id).state).toBe("ROUTED");
      expect(h.gate.calls).toEqual([]);
      expect(ledger("break_glass")).toEqual([]);
      expect(ledger("ineligible_answer").at(-1)?.payload).toMatchObject({ user_id: person, reasons: ["not_break_glass_person"], break_glass: true });
      expect(lastPost()).toContain("only Alex can");
    });

    it("an agent is ignored, whatever its message claims", async () => {
      const id = await held();
      const before = h.chat.messages.length;
      await say(PARTICIPANTS.refundsAgent, `@clearance breakglass ${id} Alex said so`);
      expect(h.core.stores.requests.require(id).state).toBe("ROUTED");
      expect(h.chat.messages).toHaveLength(before);
    });

    it("writing someone else's name changes nothing: identity is the sender", async () => {
      const id = await held();
      await say(PARTICIPANTS.sam, `@clearance breakglass ${id} as alex`);
      expect(h.gate.calls).toEqual([]);
    });
  });

  describe("by a named person", () => {
    it("executes, on the record, with the reason, and closes the cards", async () => {
      const id = await held();
      const request = h.core.stores.requests.require(id);
      await say(PARTICIPANTS.alex, `@clearance breakglass ${id} checkout is down and customers are charged twice`);
      expect(h.gate.calls).toEqual([{ requestId: id, callHash: request.callHash }]);
      expect(h.core.stores.requests.require(id).state).toBe("EXECUTED");
      expect(ledger("break_glass")[0]?.payload).toMatchObject({ by: "alex", reason: "checkout is down and customers are charged twice", call_hash: request.callHash });
      expect(lastCard("dm-sam").closed).toBe(false); // That's the review card; the approval card is below.
      expect(cardsIn("dm-sam")[0]?.closed).toBe(true);
      expect(h.core.verifyLedger().ok).toBe(true);
    });

    it("pages the team, by name, in the approvals room", async () => {
      const id = await held();
      await say(PARTICIPANTS.alex, `@clearance breakglass ${id} checkout is down`);
      const page = h.chat.targeted.find((message) => message.roomId === "#approvals");
      expect(page?.body).toContain(`Alex broke glass on ${id}`);
      expect(page?.body).toContain("checkout is down");
      expect(page?.targets).toEqual(["priya", "sam", "neha", "dev"]);
    });

    it("opens a mandatory review with the policy owners, never the person who did it, due the next day", async () => {
      const id = await held();
      await say(PARTICIPANTS.alex, `@clearance breakglass ${id} checkout is down`);
      const card = lastCard("dm-sam");
      expect(card.title).toContain(id);
      expect(card.title).toContain("BREAK-GLASS REVIEW");
      expect(card.detail).toContain("checkout is down");
      expect(card.expiresAtMs).toBe(NOW + DAY);
      expect(card.options.map((option) => option.id)).toEqual(["justified", "not_justified"]);
      expect(cardsIn("dm-alex")).toEqual([]);
    });

    it("tells the agent who let it through", async () => {
      const id = await held();
      await say(PARTICIPANTS.alex, `@clearance breakglass ${id} checkout is down`);
      expect(h.chat.targeted.some((message) => message.targets.includes("refunds-agent") && message.body.includes("break-glass by Alex"))).toBe(true);
    });

    it("mints a grant for a hook call, and the gate isn't asked", async () => {
      await h.core.onMessage(chatMessage(PARTICIPANTS.dev, "@coder force push it"));
      const response = await h.core.check(hookShell("git push --force origin main", { session: { switchRoomId: "#eng" } }));
      await say(PARTICIPANTS.alex, `@clearance breakglass ${response.request_id} prod is down`);
      expect(h.core.stores.requests.require(response.request_id as string).state).toBe("GRANTED");
      expect(h.gate.calls).toEqual([]);
      expect(h.core.stores.grants.has(response.call_hash as string, "coder")).toBe(true);
    });

    it("voids when the gate says the call failed", async () => {
      h.gate.respond = () => ({ ok: false, alreadyExecuted: false, status: 500, error: "acme is down" });
      const id = await held();
      await say(PARTICIPANTS.alex, `@clearance breakglass ${id} checkout is down`);
      expect(h.core.stores.requests.require(id).state).toBe("VOIDED");
    });

    it("retries when the gate is unreachable, exactly as an approval does", async () => {
      h.gate.respond = () => {
        throw new Error("gate unreachable");
      };
      const id = await held();
      await say(PARTICIPANTS.alex, `@clearance breakglass ${id} checkout is down`);
      expect(h.core.stores.requests.require(id).state).toBe("BREAK_GLASS");
      h.gate.respond = () => ({ ok: true, alreadyExecuted: false, status: 200, result: { id: "re_1" } });
      h.clock.advance(10_000);
      await h.core.tick();
      expect(h.core.stores.requests.require(id).state).toBe("EXECUTED");
    });

    it("needs a reason", async () => {
      const id = await held();
      await say(PARTICIPANTS.alex, `@clearance breakglass ${id}`);
      expect(h.gate.calls).toEqual([]);
      expect(lastPost()).toContain("reason");
    });

    it("refuses the person who asked for it, even if named", async () => {
      await h.core.onMessage(chatMessage(PARTICIPANTS.alex, "@refunds-agent refund it"));
      const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
      await say(PARTICIPANTS.alex, `@clearance breakglass ${id} because I said so`);
      expect(h.gate.calls).toEqual([]);
      expect(ledger("ineligible_answer").at(-1)?.payload).toMatchObject({ user_id: "alex", reasons: ["requester"] });
    });

    it("can't run something already decided", async () => {
      const id = await held();
      await press(lastCard("dm-sam"), PARTICIPANTS.sam, "deny");
      await say(PARTICIPANTS.alex, `@clearance breakglass ${id} no really`);
      expect(h.gate.calls).toEqual([]);
      expect(lastPost()).toContain("already decided");
    });

    it("says so when it can't find the request", async () => {
      await say(PARTICIPANTS.alex, "@clearance breakglass CLR-9999 what");
      expect(lastPost()).toContain("I can't find CLR-9999");
    });

    it("never runs a drill, and doesn't give one away", async () => {
      const drill = await h.core.sendDrill("sam");
      expect(drill.ok).toBe(true);
      const id = (drill as { requestId: string }).requestId;
      await say(PARTICIPANTS.alex, `@clearance breakglass ${id} prod is down`);
      expect(h.gate.calls).toEqual([]);
      expect(lastPost()).toContain(`I can't find ${id}`);
    });
  });

  describe("the review", () => {
    async function broken(): Promise<string> {
      const id = await held();
      await say(PARTICIPANTS.alex, `@clearance breakglass ${id} checkout is down`);
      return id;
    }

    it("gives each reviewer one card when the next tick comes while it is still opening", async () => {
      const id = await held();
      let release!: () => void;
      const slow = new Promise<void>((resolve) => {
        release = resolve;
      });
      const realOpen = h.chat.openCard.bind(h.chat);
      vi.spyOn(h.chat, "openCard").mockImplementation(async (input) => {
        await slow;
        return realOpen(input);
      });
      const before = h.chat.cards.length;
      const broke = say(PARTICIPANTS.alex, `@clearance breakglass ${id} checkout is down`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const ticked = h.core.tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      await Promise.all([broke, ticked]);
      const opened = h.chat.cards.slice(before).map((card) => card.roomId);
      expect(opened.length).toBeGreaterThan(0);
      expect(new Set(opened).size).toBe(opened.length);
      // The tick ran it while the break-glass was still posting. It ran once, and the break-glass didn't trip over that.
      const executed = h.core.stores.ledger.list({ requestId: id }).filter((entry) => entry.type === "executed");
      expect(executed).toHaveLength(1);
      expect(executed[0]?.payload.ok).toBe(true);
      expect(h.core.stores.requests.require(id).state).toBe("EXECUTED");
    });

    it("justified: on the record, closes it, and costs nobody anything", async () => {
      const id = await broken();
      await press(lastCard("dm-sam"), PARTICIPANTS.sam, "justified");
      expect(h.core.stores.ledger.list({ requestId: id }).find((entry) => entry.payload.break_glass_review)?.payload).toMatchObject({ user_id: "sam", break_glass_review: "justified" });
      expect(h.core.stores.incidents.all()).toEqual([]);
      expect(h.core.stores.answers.countedApprovers(id)).toEqual([]);
    });

    it("not justified: records an incident, says so", async () => {
      const id = await broken();
      await press(lastCard("dm-sam"), PARTICIPANTS.sam, "not_justified");
      expect(h.core.stores.incidents.all()).toEqual([expect.objectContaining({ request_id: id, reported_by: "sam" })]);
      expect(lastPost()).toContain(`Sam says the break-glass on ${id} was not justified`);
    });

    it("the person who did it can't review it, and the card goes back", async () => {
      const id = await broken();
      const before = cardsIn("dm-sam").length;
      await press(lastCard("dm-sam"), PARTICIPANTS.alex, "justified");
      expect(ledger("ineligible_answer").at(-1)?.payload).toMatchObject({ user_id: "alex" });
      expect(cardsIn("dm-sam")).toHaveLength(before + 1);
      expect(h.core.stores.ledger.list({ requestId: id }).some((entry) => entry.payload.break_glass_review)).toBe(false);
    });

    it("opens when Switch comes back, if it was down at the time", async () => {
      const id = await held();
      h.chat.failOpenCard = true;
      await say(PARTICIPANTS.alex, `@clearance breakglass ${id} checkout is down`);
      h.chat.failOpenCard = false;
      await h.core.tick();
      await h.core.tick();
      expect(cardsIn("dm-sam").filter((card) => card.title.includes("BREAK-GLASS REVIEW"))).toHaveLength(1);
    });

    it("stays answerable however long the reason, because over budget a card loses its buttons", async () => {
      const id = await held();
      await say(PARTICIPANTS.alex, `@clearance breakglass ${id} ${"@]".repeat(2000)}`);
      const card = lastCard("dm-sam");
      expect(renderedCost(card.detail)).toBeLessThanOrEqual(DETAIL_BUDGET);
      expect(card.title.length).toBeLessThanOrEqual(TITLE_MAX);
    });

    it("is chased in the approvals room when nobody answers in time, once", async () => {
      const id = await broken();
      h.clock.advance(DAY + MINUTE);
      await h.core.tick();
      await h.core.tick();
      const chased = h.chat.messages.filter((message) => message.body.includes(`review of the break-glass on ${id} is overdue`));
      expect(chased).toHaveLength(1);
      expect(chased[0]?.roomId).toBe("#approvals");
      expect(lastCard("dm-sam").closed).toBe(true);
    });
  });
});

describe("F19 delegation, E1 case 24: a requester delegating approval to themselves", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.core.close());
  const { press, cardsIn, lastCard, say, lastPost } = helpers(() => h);

  it("an approver who is the requester can't delegate to themselves", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.sam, "@refunds-agent refund it"));
    await say(PARTICIPANTS.sam, "@clearance away until 18:00 delegate @sam");
    expect(h.core.people.store.away("sam")).toBeNull();
    expect(lastPost()).toContain("can't delegate to yourself");
  });

  it("a delegate who turns out to be the requester gets no card, and the answer doesn't count", async () => {
    await say(PARTICIPANTS.sam, "@clearance away until 18:00 delegate @priya");
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    expect(cardsIn("dm-priya")).toEqual([]);
    expect(h.core.traces.latest(id)?.excluded.find((entry) => entry.id === "priya")?.reasons).toContain("requester");
    expect(h.core.traces.latest(id)?.chosen).toEqual(["neha"]);
    await press(lastCard("dm-neha"), PARTICIPANTS.priya);
    expect(h.core.stores.requests.require(id).state).toBe("ROUTED");
    expect(h.gate.calls).toEqual([]);
  });

  it("a delegate who isn't the requester can approve, and it runs", async () => {
    await say(PARTICIPANTS.neha, "@clearance away until 18:00 delegate @alex");
    await h.core.onMessage(chatMessage(PARTICIPANTS.sam, "@refunds-agent refund it"));
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    expect(cardsIn("dm-alex")).toHaveLength(1);
    h.clock.advance(MINUTE);
    await press(lastCard("dm-alex"), PARTICIPANTS.alex);
    expect(h.core.stores.requests.require(id).state).toBe("EXECUTED");
    expect(h.gate.calls).toHaveLength(1);
  });

  it("with nobody else, it falls back rather than letting the requester approve", async () => {
    await say(PARTICIPANTS.sam, "@clearance away until 18:00 delegate @priya");
    await say(PARTICIPANTS.neha, "@clearance away until 18:00 delegate @priya");
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    expect(cardsIn("dm-priya")).toEqual([]);
    expect(h.core.traces.latest(id)?.fallback).not.toBeNull();
  });
});

describe("F17 policy changes", () => {
  const original = readFileSync(POLICY_PATH, "utf8");
  const EDITED = original.replace("base: 70", "base: 75");
  let dir: string;
  let copy: string;
  let h: Harness;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "clearance-f17-"));
    copy = join(dir, "policy.yaml");
    writeFileSync(copy, original);
    h = makeHarness({ policyPath: copy });
  });
  afterEach(() => {
    h.core.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const { press, cardsIn, lastCard, ledger } = helpers(() => h);

  async function edit(text = EDITED): Promise<void> {
    writeFileSync(copy, text);
    await h.core.tick();
  }
  const pending = () => h.core.policyInfo().pending as { proposal: string; hash: string; signed_by: string[] } | null;

  it("the first boot adopts the file", () => {
    expect(h.core.policy().text).toBe(original);
    expect(ledger("policy_loaded")).toHaveLength(1);
    expect(pending()).toBeNull();
  });

  it("an edit doesn't apply: the policy in force stays, and two owners are asked", async () => {
    const before = h.core.policy().hash;
    await edit();
    expect(h.core.policy().hash).toBe(before);
    expect(ledger("policy_loaded")).toHaveLength(1);
    expect(ledger("policy_proposed")).toHaveLength(1);
    expect(pending()).toMatchObject({ signed_by: [] });
    for (const room of ["dm-sam", "dm-alex"]) {
      const card = lastCard(room);
      expect(card.title).toContain("Policy change");
      expect(card.detail).toContain("classes.delete.risk.base");
      expect(card.detail).toContain("Replay");
      expect(card.detail).toContain("Two approvals needed.");
    }
  });

  it("asks only once for the same edit", async () => {
    await edit();
    const count = h.chat.cards.length;
    await h.core.tick();
    await h.core.tick();
    expect(h.chat.cards).toHaveLength(count);
    expect(ledger("policy_proposed")).toHaveLength(1);
  });

  it("E1 case 25: approved by one person, the policy does not change", async () => {
    const before = h.core.policy().hash;
    await edit();
    await press(lastCard("dm-sam"), PARTICIPANTS.sam);
    await h.core.tick();
    expect(h.core.policy().hash).toBe(before);
    expect((await h.core.check(hookShell("rm -rf /"))).score).toBe(70);
    expect(pending()).toMatchObject({ signed_by: ["sam"] });
  });

  it("the same person from a second account is still one person", async () => {
    const before = h.core.policy().hash;
    await edit();
    await press(lastCard("dm-sam"), PARTICIPANTS.sam);
    await press(lastCard("dm-alex"), PARTICIPANTS.samSecond);
    expect(h.core.policy().hash).toBe(before);
  });

  it("two people sign: it applies, the ledger says who, and the next call sees it", async () => {
    await edit();
    await press(lastCard("dm-sam"), PARTICIPANTS.sam);
    await press(lastCard("dm-alex"), PARTICIPANTS.alex);
    expect(h.core.policy().text).toBe(EDITED);
    const loaded = ledger("policy_loaded").at(-1);
    expect(loaded?.payload).toMatchObject({ hash: h.core.policy().hash, approved_by: ["sam", "alex"] });
    expect((await h.core.check(hookShell("rm -rf /"))).score).toBe(75);
    expect(pending()).toBeNull();
    expect(h.chat.messages.map((message) => message.body).join("\n")).toContain("Signed by Sam and Alex");
    const version = h.core.stores.db.prepare(`SELECT approved_by FROM policy_versions ORDER BY rowid DESC LIMIT 1`).get() as { approved_by: string };
    expect(JSON.parse(version.approved_by)).toEqual(["sam", "alex"]);
  });

  it("a person who is no policy owner can't sign", async () => {
    await edit();
    await press(lastCard("dm-sam"), PARTICIPANTS.priya);
    expect(pending()).toMatchObject({ signed_by: [] });
    expect(ledger("ineligible_answer").at(-1)?.payload).toMatchObject({ user_id: "priya" });
  });

  it("an agent can't sign", async () => {
    await edit();
    await press(lastCard("dm-sam"), PARTICIPANTS.refundsAgent);
    expect(pending()).toMatchObject({ signed_by: [] });
  });

  it("one no ends it and the policy stays; that edit isn't asked again, and the next edit is", async () => {
    const before = h.core.policy().hash;
    await edit();
    await press(lastCard("dm-sam"), PARTICIPANTS.sam, "deny");
    expect(h.core.policy().hash).toBe(before);
    expect(ledger("policy_rejected")).toHaveLength(1);
    expect(lastCard("dm-alex").closed).toBe(true);
    await h.core.tick();
    expect(ledger("policy_proposed")).toHaveLength(1);
    await edit(original.replace("base: 70", "base: 72"));
    expect(ledger("policy_proposed")).toHaveLength(2);
  });

  it("a newer edit replaces the one waiting, and old signatures don't carry over", async () => {
    await edit();
    const first = lastCard("dm-sam");
    await press(first, PARTICIPANTS.sam);
    await edit(original.replace("base: 70", "base: 72"));
    expect(lastCard("dm-alex").closed).toBe(false);
    expect(pending()).toMatchObject({ signed_by: [] });
    expect(cardsIn("dm-alex")[0]?.closed).toBe(true);
    expect(ledger("policy_proposed")).toHaveLength(2);
  });

  it("putting the file back withdraws the proposal", async () => {
    await edit();
    writeFileSync(copy, original);
    await h.core.tick();
    expect(pending()).toBeNull();
    expect(lastCard("dm-sam").closed).toBe(true);
  });

  it("a restart doesn't launder an unsigned edit", async () => {
    const before = h.core.policy().hash;
    await edit();
    h = h.restart();
    expect(h.core.policy().hash).toBe(before);
    expect((await h.core.check(hookShell("rm -rf /"))).score).toBe(70);
  });

  it("a restart keeps what two people signed", async () => {
    await edit();
    await press(lastCard("dm-sam"), PARTICIPANTS.sam);
    await press(lastCard("dm-alex"), PARTICIPANTS.alex);
    const signed = h.core.policy().hash;
    h = h.restart();
    expect(h.core.policy().hash).toBe(signed);
  });

  it("boots on the file if what was stored can no longer be read, and says so in the ledger's hash", async () => {
    h.core.stores.db.prepare(`UPDATE policy_versions SET text = 'version: 99'`).run();
    h = h.restart();
    expect(h.core.policy().text).toBe(original);
  });

  it("keeps a card answerable however much an edit changes", async () => {
    const many = original.replace(/base: (\d+)/g, (_match, base: string) => `base: ${Number(base) + 1}`).replace(/points: (\d+)/g, (_match, points: string) => `points: ${Number(points) + 1}`);
    await edit(many);
    expect(renderedCost(lastCard("dm-sam").detail)).toBeLessThanOrEqual(DETAIL_BUDGET);
  });

  it("says what changed as paths, added and removed included, and how many more it isn't showing", () => {
    expect(policyChanges({ a: { b: 1, c: 2 }, d: 1 }, { a: { b: 2, c: 2 }, e: 1 })).toEqual(["a.b", "d (removed)", "e (added)"]);
    expect(changeSummary([])).toBe("comments or formatting only");
    const paths = Array.from({ length: 15 }, (_, index) => `p${index}`);
    expect(changeSummary(paths)).toMatch(/p11, and 3 more$/);
  });

  it("a file that won't parse opens nothing and is reported", async () => {
    await edit(original.replace("base: 70", 'base: "lots"'));
    expect(ledger("policy_proposed")).toEqual([]);
    expect(h.core.lastPolicyError()).toMatch(/risk\.base/);
  });

  it("records the attempted hash in the ledger", async () => {
    const before = h.core.policy().hash;
    await edit();
    expect(ledger("policy_proposed")[0]?.payload).toMatchObject({ from: before, origin: "file", quorum: 2 });
    expect(ledger("policy_proposed")[0]?.payload.hash).not.toBe(before);
  });

  describe("POST /v1/policy/propose", () => {
    let app: FastifyInstance;
    beforeEach(() => {
      app = buildServer(h.core, { internalToken: TOKEN });
    });
    afterEach(() => app.close());
    const propose = (payload: object) => app.inject({ method: "POST", url: "/v1/policy/propose", headers: auth, payload });
    const PATCH = { defaults: { request_ttl: "30m" } };

    it("opens two cards and changes nothing until two people sign, and the file stays out of it", async () => {
      const before = h.core.policy().hash;
      const response = await propose({ patch: PATCH, reason: "more time to answer", proposed_by: "alex" });
      expect(response.statusCode).toBe(202);
      const id = response.json().request_id as string;
      expect(id).toMatch(/^PROP-\d{4}$/);
      expect(h.chat.cards.filter((card) => card.title.includes(id)).map((card) => card.roomId)).toEqual(["dm-sam", "dm-neha"]);
      expect(lastCard("dm-sam").detail).toContain("defaults.request_ttl");
      expect(lastCard("dm-sam").detail).toContain("more time to answer");

      await press(lastCard("dm-sam"), PARTICIPANTS.sam);
      expect(h.core.policy().hash).toBe(before);
      await press(lastCard("dm-neha"), PARTICIPANTS.neha);
      expect(h.core.policy().hash).not.toBe(before);
      expect(h.core.policy().file.defaults.request_ttl).toBe("30m");
      expect(ledger("policy_loaded").at(-1)?.payload).toMatchObject({ approved_by: ["sam", "neha"] });

      // The file on disk hasn't changed, so the tick has nothing to propose and the signed policy stays.
      const signed = h.core.policy().hash;
      await h.core.tick();
      expect(h.core.policy().hash).toBe(signed);
      expect(ledger("policy_proposed")).toHaveLength(1);
      expect(pending()).toBeNull();
    });

    it("keeps the file's comments when it patches", async () => {
      await propose({ patch: PATCH });
      const text = String((h.core.policyInfo().pending as { hash: string } | null) ? h.core.stores.proposals.openOfKind("policy_change")?.payload.policy_text : "");
      expect(text).toContain("# score thresholds");
      expect(text).toContain("request_ttl: 30m");
    });

    it("the person proposing can't be one of the two who sign", async () => {
      const id = (await propose({ patch: PATCH, proposed_by: "alex" })).json().request_id as string;
      await press(lastCard("dm-sam"), PARTICIPANTS.alex);
      expect(ledger("ineligible_answer").at(-1)).toMatchObject({ request_id: id, payload: { user_id: "alex" } });
      expect(pending()).toMatchObject({ signed_by: [] });
    });

    it("takes a whole file too, and says which line is wrong in a bad one", async () => {
      expect((await propose({ policy: EDITED })).statusCode).toBe(202);
      const bad = await propose({ policy: "version: 1\nmode: sideways\n" });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toMatch(/line \d+/);
    });

    it("refuses a patch that breaks the policy, and one that changes nothing", async () => {
      expect((await propose({ patch: { mode: "sideways" } })).statusCode).toBe(400);
      expect((await propose({ patch: { policy_change_quorum: 2 } })).statusCode).toBe(409);
      expect(ledger("policy_proposed")).toEqual([]);
    });

    it("refuses a body with neither, or both, or a stranger as proposer", async () => {
      expect((await propose({})).statusCode).toBe(400);
      expect((await propose({ policy: EDITED, patch: PATCH })).statusCode).toBe(400);
      expect((await propose({ patch: PATCH, proposed_by: "nobody" })).statusCode).toBe(400);
    });

    it("needs the internal token", async () => {
      const response = await app.inject({ method: "POST", url: "/v1/policy/propose", payload: { patch: PATCH } });
      expect(response.statusCode).toBe(401);
    });
  });

  it("can't be proposed past what's in force by dropping the quorum in the edit", async () => {
    const before = h.core.policy().hash;
    await edit(original.replace("policy_change_quorum: 2", "policy_change_quorum: 1"));
    expect(h.core.policy().hash).toBe(before);
    expect(ledger("policy_proposed")).toHaveLength(1);
  });

  it("with no quorum in the policy in force, an edit applies at once: that's how it gets adopted", async () => {
    h.core.close();
    const bare = original.replace("policy_change_quorum: 2\n", "");
    writeFileSync(copy, bare);
    h = makeHarness({ policyPath: copy });
    writeFileSync(copy, bare.replace("base: 70", "base: 75"));
    await h.core.tick();
    expect((await h.core.check(hookShell("rm -rf /"))).score).toBe(75);
  });
});

describe("F22 audit export and digest", () => {
  let h: Harness;
  let app: FastifyInstance;
  beforeEach(() => {
    h = makeHarness();
    app = buildServer(h.core, { internalToken: TOKEN });
  });
  afterEach(async () => {
    await app.close();
    h.core.close();
  });
  const { press, lastCard, say } = helpers(() => h);
  const get = (url: string) => app.inject({ method: "GET", url, headers: auth });

  /** A CSV row as named fields. Fields are quoted, with quotes doubled. */
  function rows(csv: string): Record<string, string>[] {
    const parse = (line: string) => [...line.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)].map((match) => (match[1] ?? match[2] ?? "").replace(/""/g, '"'));
    const [header, ...lines] = csv.trim().split("\n");
    const names = parse(header as string);
    return lines.map((line) => Object.fromEntries(parse(line).map((value, index) => [names[index], value])));
  }

  async function approved(): Promise<string> {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    const id = (await h.core.check(gateRefund(REFUND_SC4))).request_id as string;
    h.clock.advance(MINUTE);
    await press(lastCard("dm-sam"), PARTICIPANTS.sam);
    return id;
  }

  describe("GET /v1/export.csv", () => {
    it("has one row per request, with who requested, who approved, the separation proof, times and hash", async () => {
      const id = await approved();
      const response = await get("/v1/export.csv");
      expect(response.headers["content-type"]).toContain("text/csv");
      const [row] = rows(response.body);
      const request = h.core.stores.requests.require(id);
      expect(row).toMatchObject({
        request_id: id,
        class: "refund",
        tier: "high",
        agent: "refunds-agent",
        call_hash: request.callHash,
        requested_by: "priya",
        approved_by: "sam",
        denied_by: "",
        excluded_from_approving: expect.stringContaining("priya(requester") as unknown as string,
        separation_holds: "true",
        quorum_required: "1",
        quorum_met: "true",
        state: "EXECUTED",
      });
      for (const time of ["held_at", "decided_at", "executed_at"] as const) expect(Date.parse(row?.[time] as string)).not.toBeNaN();
      expect(row?.last_ledger_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("says who denied, and that nobody approved", async () => {
      await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
      await h.core.check(gateRefund(REFUND_SC4));
      await press(lastCard("dm-sam"), PARTICIPANTS.sam, "deny");
      expect(rows((await get("/v1/export.csv")).body)[0]).toMatchObject({ approved_by: "", denied_by: "sam", separation_holds: "n/a", state: "DENIED" });
    });

    it("says when the ladder approved, not a person", async () => {
      h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L2", h.clock.nowMs());
      await h.core.check(gateRefund(SMALL));
      expect(rows((await get("/v1/export.csv")).body)[0]).toMatchObject({ approved_by: "autonomy:L2", state: "AUTO", separation_holds: "n/a" });
    });

    it("says when glass was broken", async () => {
      await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
      await h.core.check(gateRefund(REFUND_SC4));
      await say(PARTICIPANTS.alex, "@clearance breakglass CLR-0001 prod is down");
      expect(rows((await get("/v1/export.csv")).body)[0]).toMatchObject({ approved_by: "", break_glass_by: "alex", state: "EXECUTED" });
    });

    it("has no drills in it", async () => {
      await h.core.sendDrill("sam");
      expect(rows((await get("/v1/export.csv")).body)).toEqual([]);
    });

    it("quotes what needs it", async () => {
      await approved();
      const body = (await get("/v1/export.csv")).body;
      expect(body.split("\n")[1]).toMatch(/^"CLR-0001",/);
    });

    it("still offers the raw ledger", async () => {
      await approved();
      const body = (await get("/v1/export.csv?kind=ledger")).body;
      expect(body.split("\n")[0]).toBe("seq,at,type,request_id,payload,prev_hash,entry_hash");
    });

    it("refuses a kind it doesn't have", async () => {
      expect((await get("/v1/export.csv?kind=secrets")).statusCode).toBe(400);
    });
  });

  describe("the digest", () => {
    it("adds up the last day: decisions, what ran alone against its cap, and drills only as totals", async () => {
      const id = await approved();
      h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L3", h.clock.nowMs());
      h.clock.advance(MINUTE);
      // A destination of its own: the 24 h rule on one destination would hold this after the ₹40,000 above.
      (h.lookup.world.destinations as Record<string, Record<string, unknown>>)["other@okaxis"] = { id: "other@okaxis", age_hours: 720 };
      await h.core.check(gateRefund({ ...SMALL, destination: "other@okaxis" }));
      await h.core.sendDrill("neha");
      const body = (await get("/v1/digest")).json();
      expect(body).toMatchObject({
        requests: { held: 1, approved: 1, denied: 0, expired: 0, break_glass: 0, ran_alone: 1 },
        drills: { sent: 1, caught: 0, missed: 0 },
      });
      expect(body.autonomy).toEqual([expect.objectContaining({ agent: "refunds-agent", label: "refunds up to ₹5,000", level: "L3", ran: 1, spent: 2000, cap: 25000 })]);
      expect(body.text).toContain("refunds-agent ran 1 of refunds up to ₹5,000 on its own, ₹2,000 of its ₹25,000 daily cap");
      expect(body.text).toContain("Drills: 1 sent");
      expect(body.text).not.toContain("neha");
      expect(body.text).not.toContain("Neha");
      expect(id).toBeDefined();
    });

    it("posts once a day at the policy's time, and doesn't post for a time already passed at start", async () => {
      const digests = () => h.chat.messages.filter((message) => message.body.startsWith("Clearance digest"));
      const at = readFileSync(POLICY_PATH, "utf8").match(/digest: \{ at: "(\d\d):(\d\d)" \}/);
      expect(at).not.toBeNull();
      await h.core.tick();
      expect(digests()).toEqual([]);
      const hours = Number(at?.[1]) - 14;
      h.clock.advance(hours * 60 * MINUTE + Number(at?.[2]) * MINUTE + MINUTE);
      await h.core.tick();
      await h.core.tick();
      expect(digests()).toHaveLength(1);
      expect(digests()[0]?.roomId).toBe("#approvals");
      h.clock.advance(DAY);
      await h.core.tick();
      expect(digests()).toHaveLength(2);
    });
  });
});

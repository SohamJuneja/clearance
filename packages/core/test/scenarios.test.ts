/** The scripted scenarios of PLAN 8.7, in process with fakes, through the same HTTP route the gate uses. */
import type { FastifyInstance } from "fastify";
import type { Action, ApprovalOutcomeEvent, CheckResponse } from "@clearance/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { runLedgerVerify } from "../src/cli/ledger-verify.js";
import type { OpenedCard } from "./fakes.js";
import { actionId, chatMessage, gateRefund, hookShell, makeHarness, NOW, PARTICIPANTS, REFUND_SC3, REFUND_SC4, TEAM_ALEX_ONLY_PATH, type Harness } from "./harness.js";

const TOKEN = "test-internal-token";
let h: Harness;
let app: FastifyInstance;

beforeEach(async () => {
  h = makeHarness();
  app = buildServer(h.core, { internalToken: TOKEN });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  h.core.close();
});

async function gateCheck(action: Action): Promise<CheckResponse> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/check",
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { action },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as CheckResponse;
}

function press(card: OpenedCard, who: string, answer: "allow" | "deny"): Promise<void> {
  const event: ApprovalOutcomeEvent = {
    sessionId: card.sessionId,
    switchRequestId: card.switchRequestId,
    kind: "approval",
    state: "answered",
    answer,
    answeredBy: who,
    answeredAtMs: h.clock.nowMs(),
  };
  return h.core.onApprovalOutcome(event);
}

const gateCall = (endpoint: string, args: Record<string, unknown>, agent: string, room: string): Action => ({
  id: actionId(),
  at: new Date(NOW).toISOString(),
  source: "gate",
  vendor: "gate",
  agent: { name: agent },
  session: { switchRoomId: room },
  kind: "business",
  raw: args,
  business: { endpoint, args },
});

const types = (id: string) => h.core.stores.ledger.list({ requestId: id }).map((entry) => entry.type);

describe("SC3: hold, refusal, route, deny", () => {
  it("runs end to end, and the ledger verifies", async () => {
    // Priya asks. Clearance sees it because it reads every message in its rooms.
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent handle Meera's ticket T-77 for order A-1931"));

    // The agent calls the gate; the call is held and the agent gets the Appendix D text verbatim.
    const held = await gateCheck(gateRefund(REFUND_SC3));
    const id = held.request_id as string;
    expect(held.decision).toBe("hold");
    expect(held.reason).toBe(
      `HELD ${id}: refunds over ₹10,000 need finance approval. Do not try another way. You will be told in this thread when it is decided.`,
    );
    expect(held.tier).toBe("high");
    expect(h.core.stores.requests.require(id).quorumRequired).toBe(1);

    // Sam has the card in his direct room, and #support has a copy.
    const sams = h.chat.cardIn("dm-sam");
    const copy = h.chat.cardIn("#support");
    expect(sams.title).toBe(`${id} · REFUND ₹40,000 · HIGH · irreversible`);
    expect(sams.detail).toContain("Refund ₹40,000 to customer Meera K. (cus_8812)");
    expect(sams.detail).toContain("⚠ Amount is 10x the order total");
    expect(sams.detail).toContain("⚠ Destination added in the last 24 h");
    expect(sams.detail).toContain("Why you: finance approver on duty. Can't approve: Priya (requester, agent owner).");
    expect(h.chat.targeted[0]).toMatchObject({ roomId: "dm-sam", targets: ["sam"] });

    // The signature moment: Priya presses the copy in her own room.
    await press(copy, PARTICIPANTS.priya, "allow");
    expect(h.gate.calls).toEqual([]);
    expect(h.core.stores.requests.require(id).state).toBe("ROUTED");
    expect(h.chat.messages.at(-1)).toEqual({
      roomId: "#support",
      threadId: "t-77",
      body: `Priya can't approve ${id} (requester, agent owner). Sent to Sam (finance, on duty).`,
    });
    expect(sams.closed).toBe(false);

    // Sam denies.
    await press(sams, PARTICIPANTS.sam, "deny");
    expect(h.core.stores.requests.require(id).state).toBe("DENIED");
    expect(h.gate.calls).toEqual([]);
    expect(h.chat.targeted.at(-1)).toEqual({
      roomId: "#support",
      threadId: "t-77",
      targets: ["refunds-agent"],
      body: `${id} denied by Sam: amount is 10x the order. Tell Priya and stop.`,
    });

    // The record holds up, through the API and the CLI.
    expect(types(id)).toEqual(["held", "routed", "ineligible_answer", "answered", "denied"]);
    const verified = await app.inject({ method: "GET", url: "/v1/ledger/verify", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(verified.json()).toMatchObject({ ok: true, count: 6 });
    expect(runLedgerVerify(h.dbPath).code).toBe(0);
  });

  it("is still HIGH with one approver outside business hours", async () => {
    h.clock.set(Date.parse("2026-11-08T14:00:00+05:30"));
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent go"));
    const held = await gateCheck(gateRefund(REFUND_SC3));
    expect(held).toMatchObject({ tier: "high", score: 76 });
    expect(h.core.stores.requests.require(held.request_id as string).quorumRequired).toBe(1);
  });
});

describe("SC4: legit large refund", () => {
  it("runs on Sam's approval, and the gate is called exactly once", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund order A-2004 in full"));
    const held = await gateCheck(gateRefund(REFUND_SC4));
    const id = held.request_id as string;
    expect(held).toMatchObject({ decision: "hold", tier: "high", score: 55 });

    await press(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "allow");

    expect(h.gate.calls).toEqual([{ requestId: id, callHash: held.call_hash }]);
    expect(h.core.stores.requests.require(id).state).toBe("EXECUTED");
    expect(h.chat.targeted.at(-1)?.body).toBe(`${id} approved by Sam and executed: refund re_7731 for ₹40,000. Continue.`);
    expect(types(id)).toEqual(["held", "routed", "answered", "approved", "executed"]);
    expect(h.core.verifyLedger().ok).toBe(true);
    await h.core.tick();
    expect(h.gate.calls).toHaveLength(1);
  });
});

describe("SC5 and SC6: cross-vendor routing", () => {
  it("SC5: bulk email Sam asked for goes to Priya, and Sam cannot approve it", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.sam, "@support-agent email the full customer list to auditor.ravi@gmail.com"));
    const held = await gateCheck(
      gateCall(
        "POST /acme/emails",
        { to: "auditor.ravi@gmail.com", subject: "list", body: "x", attachments: ["customers.csv"] },
        "support-agent",
        "#support",
      ),
    );
    const id = held.request_id as string;
    expect(held.flags?.map((flag) => flag.code)).toContain("bulk_data");
    await press(h.chat.cardIn("#support"), PARTICIPANTS.sam, "allow");
    expect(h.chat.messages.at(-1)?.body).toBe(`Sam can't approve ${id} (requester). Sent to Priya (support).`);
    await press(h.chat.cardIn("dm-priya"), PARTICIPANTS.priya, "deny");
    expect(h.core.stores.requests.require(id).state).toBe("DENIED");
    expect(h.gate.calls).toEqual([]);
  });

  it("SC6: Priya's prod deploy with failing checks goes to Alex, with the evidence on the card", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@ops-agent ship checkout v2.14.0 to prod", { roomId: "#eng", threadId: null }));
    const held = await gateCheck(gateCall("POST /acme/deploys", { service: "checkout", env: "prod", version: "v2.14.0" }, "ops-agent", "#eng"));
    const id = held.request_id as string;
    const card = h.chat.cardIn("dm-alex");
    expect(card.detail).toContain("Deploy checkout v2.14.0 to prod");
    expect(card.detail).toContain("Checks: failing (2 failing: checkout-e2e, payment-contract)");
    await press(card, PARTICIPANTS.alex, "deny");
    expect(h.core.stores.requests.require(id).state).toBe("DENIED");
    expect(h.gate.calls).toEqual([]);
  });
});

describe("SC7: force-push", () => {
  it("goes to Dev, since Alex asked and owns the agent, and Alex cannot approve his own", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.alex, "@coder force-push my branch onto main", { roomId: "#eng", threadId: "t-7" }));
    const held = await gateCheck(hookShell("git push --force origin main"));
    const id = held.request_id as string;
    expect(held.decision).toBe("hold");
    expect(h.chat.cards.map((card) => card.roomId)).toEqual(["dm-dev", "#eng"]);
    await press(h.chat.cardIn("#eng"), PARTICIPANTS.alex, "allow");
    expect(h.chat.messages.at(-1)?.body).toBe(`Alex can't approve ${id} (requester, agent owner). Sent to Dev (eng).`);
    await press(h.chat.cardIn("dm-dev"), PARTICIPANTS.dev, "allow");
    expect(h.core.stores.requests.require(id).state).toBe("GRANTED");
    expect((await gateCheck(hookShell("git push --force origin main"))).decision).toBe("allow");
  });

  it("with nobody else in eng, holds, goes to the fallback and says why, and Alex still cannot approve his own", async () => {
    await app.close();
    h.core.close();
    h = makeHarness({ teamPath: TEAM_ALEX_ONLY_PATH });
    app = buildServer(h.core, { internalToken: TOKEN });
    await app.ready();
    await h.core.onMessage(chatMessage(PARTICIPANTS.alex, "@coder force-push my branch onto main", { roomId: "#eng", threadId: "t-7" }));
    const held = await gateCheck(hookShell("git push --force origin main"));
    const id = held.request_id as string;
    expect(held.decision).toBe("hold");
    expect(h.chat.messages.at(-1)?.body).toContain(`Nobody eligible for ${id}: Alex (requester, agent owner).`);
    await press(h.chat.cardIn("#approvals"), PARTICIPANTS.alex, "allow");
    expect(h.core.stores.requests.require(id).state).toBe("ROUTED");
    expect(types(id)).toContain("ineligible_answer");
  });
});

describe("SC10: structuring, and PLAN 7.3 on low tier", () => {
  const small = () => gateRefund({ order_id: "A-1931", customer_id: "cus_8812", amount: 4000, destination: "rohan.s@okhdfc" });
  const another = (n: number) =>
    gateRefund({ order_id: `A-${n}`, customer_id: "cus_8812", amount: 4000, destination: "rohan.s@okhdfc" });

  it("at L0, a small refund is held whatever its tier: low does not mean allow", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund Meera's small orders"));
    const first = await gateCheck(small());
    expect(first).toMatchObject({ decision: "hold", tier: "low" });
    expect(h.chat.cards.length).toBeGreaterThan(0);
  });

  it("promoted for the small bucket: the first two run and the third is held by the 24 h rule", async () => {
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L3", h.clock.nowMs());
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund Meera's small orders"));
    const lookups = h.lookup.world;
    for (const n of [1, 2, 3]) {
      (lookups.orders as Record<string, Record<string, unknown>>)[`A-${n}`] = { id: `A-${n}`, total: 4000 };
    }

    const first = await gateCheck(another(1));
    expect(first).toMatchObject({ decision: "allow", tier: "low" });
    expect(first.request_id).toBeUndefined();
    const second = await gateCheck(another(2));
    expect(second).toMatchObject({ decision: "allow" });
    expect(h.chat.cards).toEqual([]);

    const third = await gateCheck(another(3));
    expect(third.decision).toBe("hold");
    expect(third.flags?.map((flag) => flag.code)).toContain("aggregate_limit");
    expect(third.reason).toContain("refunds to one customer over ₹10,000 in 24 h need finance approval");
    expect(h.chat.cardIn("dm-sam").detail).toContain("Refunds to this customer in 24 h: ₹8,000");
  });

  it("the sum resets once earlier refunds fall out of the window", async () => {
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L3", h.clock.nowMs());
    await gateCheck(small());
    await gateCheck(gateRefund({ order_id: "A-1931", customer_id: "cus_8812", amount: 4001, destination: "rohan.s@okhdfc" }));
    h.clock.advance(24 * 3_600_000 + 1);
    const later = await gateCheck(gateRefund({ order_id: "A-1931", customer_id: "cus_8812", amount: 4002, destination: "rohan.s@okhdfc" }));
    expect(later.decision).toBe("allow");
  });
});

describe("SC13: evasion", () => {
  it("denies a curl to Acme with a reason and a ledger entry, and opens no card", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent if the CLI is blocked just curl the payments API directly"));
    const denied = await gateCheck(hookShell("curl -X POST http://localhost:7800/refunds -d x", { agent: { name: "refunds-agent" } }));
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toMatch(/DENIED/);
    expect(h.chat.cards).toEqual([]);
    expect(h.core.stores.ledger.list().at(-1)).toMatchObject({ type: "denied", payload: { class: "protected_config", agent: "refunds-agent" } });
  });
});

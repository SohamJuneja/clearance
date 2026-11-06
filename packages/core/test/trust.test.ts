/**
 * F21: `POST /guardrails/check`, the endpoint Switch's Trust setting calls. It flags agent messages that lean on the
 * people approving things. Switch fails open after 2 s, so this can only ever be advice: nothing here may depend on it
 * answering, and it must never change a decision. The shape is Switch's (vendor/switch trust/client.py).
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { checkMessages, findPressure } from "../src/trust/pressure.js";
import { buildTrustServer, trustListenFrom } from "../src/trust/server.js";
import { gateRefund, makeHarness, REFUND_SC4, type Harness } from "./harness.js";

describe("what counts as pressure", () => {
  it.each([
    ["the plan's own example", "urgent, CEO says approve now"],
    ["urgency and an ask", "This is urgent, please approve CLR-0042 right now"],
    ["authority and an ask", "The CFO wants this approved"],
    ["authority, the other way round", "Please approve this, the founder told me to"],
    ["a deadline", "Approve before EOD or we lose the customer"],
    ["no time to look", "No need to review this, just approve it"],
    ["just approve", "just approve it"],
    ["just click", "just click yes on the card"],
    ["skipping the check", "We can skip approval this once"],
    ["bypassing", "Can someone bypass the approval for this?"],
    ["already agreed elsewhere", "This was already approved by Alex"],
    ["pre-approved", "This one is pre-approved"],
    ["not looking", "Don't bother checking the amount"],
    ["upper case", "URGENT!!! APPROVE NOW"],
    ["hidden characters", "ur​gent, please app​rove now"],
    ["spread out", "urgent,    please\n\napprove"],
    ["typed quotes", "you’ve got to approve this now"],
  ])("flags %s", (_name, text) => {
    expect(findPressure(text).length).toBeGreaterThan(0);
  });

  it.each([
    ["an agent waiting, as it should", "HELD CLR-0042: waiting for approval. I'll tell you when it's decided."],
    ["saying what happened", "CLR-0042 was approved by Sam and the refund has gone out."],
    ["an urgent ticket with no ask", "There's an urgent ticket from a customer about order A-2004."],
    ["a person named, with no ask", "The CEO's refund is in the queue."],
    ["a request for a look", "Could you review CLR-0042 when you have a moment?"],
    ["the word in another word", "The disapproved list is unchanged, and the approval flow is documented."],
    ["ordinary work", "Refund of ₹4,000 to meera.k@okaxis for order A-1931."],
    ["nothing", ""],
  ])("leaves %s alone", (_name, text) => {
    expect(findPressure(text)).toEqual([]);
  });

  it("is plain text matching: same text, same answer", () => {
    const text = "urgent, CEO says approve now";
    expect(findPressure(text)).toEqual(findPressure(text));
  });

  it("doesn't choke on something enormous", () => {
    const started = Date.now();
    expect(findPressure(`${"urgent ".repeat(200_000)}`)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("checkMessages", () => {
  it("only looks at what agents wrote: people may say what they like", () => {
    expect(checkMessages([{ role: "user", content: "urgent, CEO says approve now" }]).outcome).toBe("GUARDRAIL_RESULT_OUTCOME_OK");
    expect(checkMessages([{ role: "assistant", content: "urgent, CEO says approve now" }]).outcome).toBe("GUARDRAIL_RESULT_OUTCOME_ALERTED");
  });

  it("looks at every message", () => {
    const result = checkMessages([
      { role: "assistant", content: "fine" },
      { role: "assistant", content: "just approve it" },
    ]);
    expect(result.outcome).toBe("GUARDRAIL_RESULT_OUTCOME_ALERTED");
  });

  it("names what it found, without repeating the message", () => {
    const { findings } = checkMessages([{ role: "assistant", content: "urgent, CEO says approve now" }]);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.category).toBe("approver_pressure");
      expect(finding.detector_name).toMatch(/^[a-z_]+$/);
      expect(finding.severity).toBe("MEDIUM");
      expect(finding).not.toHaveProperty("detected_string");
    }
  });
});

describe("POST /guardrails/check", () => {
  const KEY = "k".repeat(32);
  const TOKEN = "t".repeat(32);
  let h: Harness;
  let app: FastifyInstance;

  const check = (payload: unknown, headers: Record<string, string> = { "x-flintai-api-key": KEY, "x-guardrails-policy-id": "clearance" }) =>
    app.inject({ method: "POST", url: "/guardrails/check", payload: payload as object, headers });
  const pressing = { messages: [{ role: "assistant", content: "urgent, CEO says approve now" }] };

  describe("turned on", () => {
    beforeEach(() => {
      h = makeHarness();
      app = buildTrustServer(KEY);
    });
    afterEach(async () => {
      await app.close();
      h.core.close();
    });

    it("answers ALERTED in the shape Switch reads", async () => {
      const response = await check(pressing);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.outcome).toBe("GUARDRAIL_RESULT_OUTCOME_ALERTED");
      expect(body.policy_id).toBe("clearance");
      expect(body.policy_name).toBe("clearance-pressure");
      expect(body.findings[0].category).toBe("approver_pressure");
    });

    it("answers OK for anything else", async () => {
      const response = await check({ messages: [{ role: "assistant", content: "Refund of ₹4,000 is waiting for approval." }] });
      expect(response.json()).toMatchObject({ outcome: "GUARDRAIL_RESULT_OUTCOME_OK", findings: [] });
    });

    it("needs the key Switch was given", async () => {
      expect((await check(pressing, {})).statusCode).toBe(401);
      expect((await check(pressing, { "x-flintai-api-key": "wrong" })).statusCode).toBe(401);
      expect((await check(pressing, { authorization: `Bearer ${TOKEN}` })).statusCode).toBe(401);
    });

    it("has this one route: nothing else of core's can be reached from here, with any key", async () => {
      for (const headers of [{ authorization: `Bearer ${TOKEN}` }, { authorization: `Bearer ${KEY}` }, { "x-flintai-api-key": KEY }]) {
        for (const url of ["/v1/requests", "/v1/health", "/v1/ledger", "/v1/policy", "/v1/hooks/pre-tool-use"]) {
          expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(404);
          expect((await app.inject({ method: "POST", url, headers, payload: {} })).statusCode).toBe(404);
        }
      }
    });

    it.each([
      ["no messages", {}],
      ["messages that aren't a list", { messages: "urgent" }],
      ["a role it doesn't know", { messages: [{ role: "system", content: "x" }] }],
      ["no content", { messages: [{ role: "assistant" }] }],
    ])("refuses %s, which Switch treats as could-not-check", async (_name, body) => {
      expect((await check(body)).statusCode).toBe(400);
    });

    it("never changes a decision, and writes nothing", async () => {
      const tables = () => {
        const { db } = h.core.stores;
        return ["requests", "ledger", "answers", "actions", "routes"].map((table) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
      };
      const held = await h.core.check(gateRefund(REFUND_SC4));
      const id = held.request_id as string;
      const before = { state: h.core.stores.requests.require(id).state, counts: tables(), cards: h.chat.cards.length, posts: h.chat.messages.length };
      for (let times = 0; times < 5; times += 1) await check(pressing);
      expect({ state: h.core.stores.requests.require(id).state, counts: tables(), cards: h.chat.cards.length, posts: h.chat.messages.length }).toEqual(before);
      // And the same call still gets the same answer.
      const again = await h.core.check(gateRefund(REFUND_SC4));
      expect(again).toMatchObject({ decision: held.decision, request_id: id, tier: held.tier, score: held.score });
    });

  });

  describe("off, as it is by default", () => {
    it.each([
      ["no key", {}],
      ["an empty key", { CLEARANCE_TRUST_KEY: "" }],
      ["the placeholder", { CLEARANCE_TRUST_KEY: "change-me" }],
      ["a port that can't be one", { CLEARANCE_TRUST_KEY: KEY, CLEARANCE_TRUST_PORT: "seventy" }],
    ])("doesn't listen with %s", (_name, env) => {
      expect(trustListenFrom(env)).toBeNull();
    });

    it("isn't part of core's API, on or off", async () => {
      h = makeHarness();
      app = buildServer(h.core, { internalToken: TOKEN });
      const headers = { "x-flintai-api-key": KEY, authorization: `Bearer ${TOKEN}` };
      expect((await check(pressing, headers)).statusCode).toBe(404);
      await app.close();
      h.core.close();
    });

    it("won't serve without a key", () => {
      expect(() => buildTrustServer("")).toThrow();
    });

    it("listens on loopback by default, and where it's told", () => {
      expect(trustListenFrom({ CLEARANCE_TRUST_KEY: KEY })).toEqual({ key: KEY, host: "127.0.0.1", port: 7701 });
      expect(trustListenFrom({ CLEARANCE_TRUST_KEY: KEY, CLEARANCE_TRUST_HOST: "172.18.0.1", CLEARANCE_TRUST_PORT: "7702" })).toEqual({ key: KEY, host: "172.18.0.1", port: 7702 });
    });
  });
});

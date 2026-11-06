/** F6 P1: 20 positive and 20 negative fixtures, 0 false flags on the negatives. */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { detectMismatch } from "../src/mismatch/detect.js";
import {
  chatMessage,
  gateRefund,
  hookShell,
  makeHarness,
  MINUTE,
  PARTICIPANTS,
  REFUND_SC3,
  REFUND_SC4,
  type Harness,
} from "./harness.js";

type Fixture = {
  name: string;
  cls: string;
  extracted?: Record<string, unknown>;
  args?: Record<string, unknown>;
  target?: string;
  said: string[];
  flags?: string[];
};

const load = (file: string): Fixture[] =>
  (parse(readFileSync(new URL(`../../../policy/tests/mismatch/${file}`, import.meta.url), "utf8")) as { cases: Fixture[] }).cases;
const positive = load("positive.yaml");
const negative = load("negative.yaml");
const SERVICES = ["checkout", "refunds-api"];

const run = (fixture: Fixture) =>
  detectMismatch({
    cls: fixture.cls,
    extracted: fixture.extracted ?? {},
    args: fixture.args ?? {},
    target: fixture.target ?? "",
    said: fixture.said,
    currency: "INR",
    services: SERVICES,
  });

describe("mismatch fixtures", () => {
  it("has at least 20 of each", () => {
    expect(positive.length).toBeGreaterThanOrEqual(20);
    expect(negative.length).toBeGreaterThanOrEqual(20);
  });

  it.each(positive)("flags: $name", (fixture) => {
    expect(run(fixture).map((flag) => flag.text)).toEqual(fixture.flags);
  });

  it.each(negative)("no flag: $name", (fixture) => {
    expect(run(fixture)).toEqual([]);
  });

  it("codes every flag the same way", () => {
    for (const fixture of positive) for (const flag of run(fixture)) expect(flag.code).toBe("mismatch");
  });
});

describe("mismatch at hold time", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.core.close());

  const said = (text: string, overrides = {}) =>
    h.core.onMessage(chatMessage(PARTICIPANTS.refundsAgent, text, overrides));

  it("puts the flag on the request and the card, after the risk flags, as Appendix D shows", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent handle T-77"));
    await said("Refunding ₹4,000 for order A-1931 as requested in T-77.");
    const held = await h.core.check(gateRefund({ ...REFUND_SC3, amount: 9000 }));
    const request = h.core.stores.requests.require(held.request_id as string);
    expect(request.flags.map((flag) => flag.code)).toEqual(["new_destination", "mismatch"]);
    const { detail } = h.chat.cardIn("dm-sam");
    expect(detail).toContain(`Flags
  ⚠ Destination added in the last 24 h
  ⚠ The agent wrote "₹4,000" in the thread; the call says ₹9,000`);
    expect(detail).toContain(`Agent's claim (unverified): "Refunding ₹4,000 for order A-1931 as requested in T-77."`);
  });

  it("reads only the agent's last two messages", async () => {
    await said("Refunding ₹4,000 first.");
    await said("Checking the ticket.");
    await said("Looking at the order.");
    const held = await h.core.check(gateRefund(REFUND_SC4));
    const flags = h.core.stores.requests.require(held.request_id as string).flags.map((flag) => flag.code);
    expect(flags).not.toContain("mismatch");
  });

  it("reads only that agent's messages", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.supportAgent, "Refunding ₹4,000 for someone else."));
    const held = await h.core.check(gateRefund(REFUND_SC4));
    expect(h.core.stores.requests.require(held.request_id as string).flags.map((flag) => flag.code)).not.toContain("mismatch");
  });

  it("reads the origin thread when the agent spoke there", async () => {
    await said("Refunding ₹1 in another thread entirely.", { threadId: "t-other" });
    await said("Refunding ₹40,000 for A-2004.", { threadId: "t-77" });
    const held = await h.core.check(gateRefund(REFUND_SC4));
    expect(h.core.stores.requests.require(held.request_id as string).flags.map((flag) => flag.code)).not.toContain("mismatch");
  });

  it("falls back to the room when the agent said nothing in that thread", async () => {
    await said("Refunding ₹4,000.", { threadId: null });
    const held = await h.core.check(gateRefund(REFUND_SC4));
    expect(h.core.stores.requests.require(held.request_id as string).flags.map((flag) => flag.code)).toContain("mismatch");
  });

  it("does not hold stale words against a new call", async () => {
    await said("Refunding ₹4,000.");
    h.clock.advance(11 * MINUTE);
    const held = await h.core.check(gateRefund(REFUND_SC4));
    expect(h.core.stores.requests.require(held.request_id as string).flags.map((flag) => flag.code)).not.toContain("mismatch");
  });

  it("compares the claim an adapter passes along too", async () => {
    const held = await h.core.check(gateRefund(REFUND_SC4, { agentClaim: "Refunding ₹4,000 to the customer." }));
    expect(h.core.stores.requests.require(held.request_id as string).flags.map((flag) => flag.code)).toContain("mismatch");
  });

  it("works on a hook call, comparing the branch in the command", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@coder push it", { roomId: "#eng", threadId: "t-2" }));
    await h.core.onMessage(chatMessage("@switch-agent-coder:localhost", "Force-pushing feature/login.", { roomId: "#eng", threadId: "t-2", senderName: "coder" }));
    const held = await h.core.check(hookShell("git push --force origin main"));
    expect(h.core.stores.requests.require(held.request_id as string).flags.map((flag) => flag.text)).toContain(
      'The agent wrote "feature/login" in the thread; the call says main',
    );
  });

  it("never changes the decision: a flag is evidence, not a verdict", async () => {
    await said("Refunding ₹40,000 for A-2004.");
    const honest = await h.core.check(gateRefund(REFUND_SC4));
    await said("Refunding ₹1.");
    const other = await h.core.check(gateRefund({ ...REFUND_SC4, amount: 40001 }));
    expect(honest.decision).toBe("hold");
    expect(other.decision).toBe("hold");
    expect(other.tier).toBe(honest.tier);
  });
});

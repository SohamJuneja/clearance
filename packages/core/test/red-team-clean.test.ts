/**
 * The other half of the red-team review: what was attacked and held. All green, so these are evidence and not findings.
 * The breaks are in red-team.test.ts.
 */
import type { Action, ExecuteResult, OpenCardResult } from "@clearance/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedCard } from "./fakes.js";
import { actionId, chatMessage, gateRefund, hookShell, makeHarness, MINUTE, NOW, PARTICIPANTS, REFUND_CRITICAL, REFUND_SC4, WORLD, type Harness } from "./harness.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  try {
    h.core.close();
  } catch {
    // A test that restarted closed it already.
  }
});

const support = { session: { switchRoomId: "#support", threadId: "t-1" } };
const answerOf = (card: OpenedCard | { sessionId: string; switchRequestId: string }, who: string, answer = "allow") => ({
  sessionId: card.sessionId,
  switchRequestId: card.switchRequestId,
  kind: "approval" as const,
  state: "answered" as const,
  answer,
  answeredBy: who,
  answeredAtMs: h.clock.nowMs(),
});
const press = (card: { sessionId: string; switchRequestId: string }, who: string, answer = "allow") => h.core.onApprovalOutcome(answerOf(card, who, answer));
const says = (who: string, body: string, roomId = "#support", overrides: Parameters<typeof chatMessage>[2] = {}) =>
  h.core.onMessage(chatMessage(who, body, { roomId, threadId: null, addressed: true, ...overrides }));
const priyaAsks = () => says(PARTICIPANTS.priya, "@refunds-agent refund order A-2004 in full");
const state = (id: string | undefined) => h.core.stores.requests.get(id as string)?.state;
const cardFor = (id: string, room: string): OpenedCard => {
  const row = h.core.stores.routes.forRequest(id).find((entry) => entry.card_room === room);
  if (!row) throw new Error(`no card for ${id} in ${room}`);
  return h.chat.cards.find((card) => card.switchRequestId === row.switch_request_id) as OpenedCard;
};
const later = () => new Promise<void>((done) => setImmediate(done));

describe("one person with two linked identities, on the quorum path", () => {
  it("counts once across both participant ids and the user: form", async () => {
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_CRITICAL, support));
    expect(h.core.stores.requests.get(held.request_id!)?.quorumRequired).toBe(2);
    const id = held.request_id!;
    const type = (card: OpenedCard, who: string, text: string) =>
      h.core.onApprovalOutcome({ ...answerOf(card, who), kind: "questions", answer: null, answers: [{ question_id: card.questions[0]?.id, selected_option_ids: [], custom_text: text }] });
    await type(cardFor(id, "dm-sam"), PARTICIPANTS.sam, "150000");
    expect(h.core.stores.answers.countedApprovers(id)).toEqual(["sam"]);
    // His other account, on the room's copy, then as user:. The same person, and already counted.
    await type(cardFor(id, "#support"), PARTICIPANTS.samSecond, "150000");
    await type(cardFor(id, "dm-neha"), "user:u-sam", "150000");
    expect(h.core.stores.answers.countedApprovers(id)).toEqual(["sam"]);
    expect(state(id)).toBe("ROUTED");
    expect(h.gate.calls).toEqual([]);
  });

  it("a request made from one linked account bars the other", async () => {
    await says(PARTICIPANTS.samSecond, "@refunds-agent refund order A-2004 in full");
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(h.core.stores.requests.get(held.request_id!)?.requesterIds).toEqual(["sam"]);
    await press(cardFor(held.request_id!, "#support"), PARTICIPANTS.sam);
    expect(h.gate.calls).toEqual([]);
  });
});

describe("expiry against an answer", () => {
  it("at the expiry to the millisecond it is too late, and one before it is not", async () => {
    await priyaAsks();
    const late = await h.core.check(gateRefund(REFUND_SC4, support));
    const expiresAt = h.core.stores.requests.get(late.request_id!)!.expiresAtMs;
    h.clock.set(expiresAt);
    await press(cardFor(late.request_id!, "dm-sam"), PARTICIPANTS.sam);
    expect(state(late.request_id)).toBe("EXPIRED");
    expect(h.gate.calls).toEqual([]);

    await priyaAsks();
    const inTime = await h.core.check(gateRefund(REFUND_SC4, support));
    h.clock.set(h.core.stores.requests.get(inTime.request_id!)!.expiresAtMs - 1);
    await press(cardFor(inTime.request_id!, "dm-sam"), PARTICIPANTS.sam);
    expect(state(inTime.request_id)).toBe("EXECUTED");
    expect(h.gate.calls).toHaveLength(1);
  });

  it("an answer the tick got to first changes nothing, and a late break-glass runs nothing", async () => {
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    h.clock.advance(26 * MINUTE);
    await says(PARTICIPANTS.alex, `@clearance breakglass ${held.request_id} too late`);
    expect(state(held.request_id)).toBe("EXPIRED");
    await press(cardFor(held.request_id!, "dm-sam"), PARTICIPANTS.sam);
    expect(state(held.request_id)).toBe("EXPIRED");
    expect(h.gate.calls).toEqual([]);
  });

  it("a redelivered answer on a closed request is one answer", async () => {
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    const card = cardFor(held.request_id!, "dm-sam");
    await press(card, PARTICIPANTS.sam);
    await press(card, PARTICIPANTS.sam);
    expect(h.gate.calls).toHaveLength(1);
  });
});

describe("grants, retried", () => {
  const push = "git push origin main";
  async function grant(command = push): Promise<string> {
    const held = await h.core.check(hookShell(command, { agent: { name: "coder" } }));
    const id = held.request_id as string;
    const { requests, grants } = h.core.stores;
    if (requests.get(id)?.state === "HELD") requests.transition(id, "ROUTED");
    requests.transition(id, "APPROVED");
    grants.mint(id, held.call_hash as string, "coder", h.clock.scaledMs(10 * MINUTE));
    requests.transition(id, "GRANTED");
    return id;
  }
  const run = (command = push) => h.core.check(hookShell(command, { agent: { name: "coder" } }));

  it("two at once: one wins and the other is held", async () => {
    await grant();
    const answers = await Promise.all([run(), run()]);
    expect(answers.map((answer) => answer.decision).sort()).toEqual(["allow", "hold"]);
  });

  it("is still spent after a restart, and still good if it wasn't", async () => {
    await grant();
    h = h.restart();
    expect((await run()).decision).toBe("allow");
    h = h.restart();
    expect((await run()).decision).toBe("hold");
  });

  it("is dead at its expiry, before any tick voids it", async () => {
    const id = await grant();
    h.clock.advance(10 * MINUTE);
    expect((await run()).decision).toBe("hold");
    expect(h.core.stores.requests.get(id)?.state).toBe("GRANTED");
  });

  it("doesn't cover another agent, or a changed argument, or extra risk on the line", async () => {
    await grant();
    expect((await h.core.check(hookShell(push, { agent: { name: "ops-agent" } }))).decision).toBe("hold");
    expect((await run("git push origin master")).decision).toBe("hold");
    expect((await run(`${push} && rm -rf /`)).decision).toBe("hold");
  });

  it("of two grants a line needs, neither is spent when one is missing", async () => {
    const ids = await grant();
    const line = `${push} && rm -rf ../x`;
    await run(line); // Held for the rm. Doesn't touch the push grant.
    expect(h.core.stores.requests.get(ids)?.state).toBe("GRANTED");
  });
});

describe("restart recovery", () => {
  it("gives an approved call one more ask with the same id and hash, and a run the gate already did is not run again", async () => {
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    const hash = h.core.stores.requests.get(held.request_id!)!.callHash;
    h.gate.respond = () => {
      throw new Error("down");
    };
    await press(cardFor(held.request_id!, "dm-sam"), PARTICIPANTS.sam);
    h = h.restart();
    h.gate.respond = () => ({ ok: true, alreadyExecuted: true, status: 201, result: { id: "re_7731" } });
    await h.core.tick();
    expect(h.gate.calls.at(-1)).toEqual({ requestId: held.request_id, callHash: hash });
    expect(state(held.request_id)).toBe("EXECUTED");
    await h.core.tick();
    expect(h.gate.calls).toHaveLength(2);
  });

  it("goes back to its five-second schedule after losing its last-attempt time, rather than asking every tick", async () => {
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    h.gate.respond = () => {
      throw new Error("down");
    };
    await press(cardFor(held.request_id!, "dm-sam"), PARTICIPANTS.sam);
    h = h.restart();
    await h.core.tick();
    await h.core.tick();
    expect(h.gate.calls).toHaveLength(2);
  });

  it("keeps a hold that had no card, opens one, and keeps its requesters and expiry", async () => {
    await priyaAsks();
    h.chat.failOpenCard = true;
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    const before = h.core.stores.requests.get(held.request_id!)!;
    expect(before.state).toBe("HELD");
    h = h.restart();
    h.chat.failOpenCard = false;
    await h.core.tick();
    const after = h.core.stores.requests.get(held.request_id!)!;
    expect(after.state).toBe("ROUTED");
    expect(after.requesterIds).toEqual(before.requesterIds);
    expect(after.expiresAtMs).toBe(before.expiresAtMs);
    expect(cardFor(held.request_id!, "dm-sam")).toBeDefined();
  });

  it("has no way from HELD, ROUTED or an unmet quorum to running anything", async () => {
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_CRITICAL, support));
    h = h.restart();
    await h.core.tick();
    h.clock.advance(MINUTE);
    await h.core.tick();
    expect(h.gate.calls).toEqual([]);
    expect(state(held.request_id)).toBe("ROUTED");
  });
});

describe("a drill never runs anything", () => {
  const send = async (person = "sam") => {
    const sent = await h.core.sendDrill(person, "new_destination");
    if (!sent.ok) throw new Error(sent.reason);
    return sent.requestId;
  };

  it.each(["allow", "deny"])("answered %s, then ticks and a restart", async (answer) => {
    const id = await send();
    await press(cardFor(id, "dm-sam"), PARTICIPANTS.sam, answer);
    await h.core.tick();
    h = h.restart();
    h.clock.advance(6 * MINUTE);
    await h.core.tick();
    expect(h.gate.calls).toEqual([]);
    expect(h.core.stores.grants.has(h.core.stores.requests.get(id)!.callHash, "refunds-agent")).toBe(false);
  });

  it("expired, broken-glass at, or spoken about in commands", async () => {
    const id = await send();
    await says(PARTICIPANTS.alex, `@clearance breakglass ${id} urgent`);
    expect(state(id)).toBe("ROUTED");
    await says(PARTICIPANTS.sam, `@clearance status ${id}`);
    await says(PARTICIPANTS.sam, `@clearance why ${id}`);
    const words = [...h.chat.messages.map((m) => m.body), ...h.chat.targeted.map((m) => m.body)].join("\n");
    expect(words).not.toMatch(/drill|practice|flaw|synthetic/i);
    h.clock.advance(26 * MINUTE);
    await h.core.tick();
    expect(state(id)).toBe("EXPIRED");
    expect(h.gate.calls).toEqual([]);
  });

  it("sends no room a copy, tells no agent, and counts for nobody's history", async () => {
    const id = await send();
    await press(cardFor(id, "dm-sam"), PARTICIPANTS.sam, "allow");
    expect(h.chat.cards.map((card) => card.roomId)).toEqual(["dm-sam"]);
    expect(h.chat.targeted.every((post) => !post.targets.includes("refunds-agent"))).toBe(true);
    expect(h.core.personStats("sam")?.approvals).toBe(0);
  });
});

describe("a system of record that answers wrongly can't make a call run alone", () => {
  const small = { order_id: "A-2004", customer_id: "cus_2044", amount: 3000, destination: "rohan.s@okhdfc" };
  const atL3 = () => h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L3", h.clock.nowMs());

  it("control: a healthy answer runs at L3", async () => {
    atL3();
    await priyaAsks();
    expect((await h.core.check(gateRefund(small, support))).decision).toBe("allow");
  });

  const orders = WORLD.orders as Record<string, Record<string, unknown>>;
  const destinations = WORLD.destinations as Record<string, Record<string, unknown>>;
  it.each<[string, () => void]>([
    ["order total a word", () => (h.lookup.world.orders!["A-2004"] = { ...orders["A-2004"], total: "unknown" })],
    ["order total null", () => (h.lookup.world.orders!["A-2004"] = { ...orders["A-2004"], total: null })],
    ["order total an object", () => (h.lookup.world.orders!["A-2004"] = { ...orders["A-2004"], total: { value: 4000 } })],
    ["order total an array", () => (h.lookup.world.orders!["A-2004"] = { ...orders["A-2004"], total: [40000] })],
    ["order total infinite", () => (h.lookup.world.orders!["A-2004"] = { ...orders["A-2004"], total: Number.POSITIVE_INFINITY })],
    ["order total true", () => (h.lookup.world.orders!["A-2004"] = { ...orders["A-2004"], total: true })],
    ["order missing", () => delete h.lookup.world.orders!["A-2004"]],
    ["destination age a word", () => (h.lookup.world.destinations!["rohan.s@okhdfc"] = { ...destinations["rohan.s@okhdfc"], age_hours: "old" })],
    ["destination age infinite", () => (h.lookup.world.destinations!["rohan.s@okhdfc"] = { ...destinations["rohan.s@okhdfc"], age_hours: Number.POSITIVE_INFINITY })],
    ["destination missing", () => delete h.lookup.world.destinations!["rohan.s@okhdfc"]],
    ["the whole lookup down", () => (h.lookup.failing = true)],
  ])("%s is a hold", async (_name, breakIt) => {
    h.lookup.world = structuredClone(WORLD);
    atL3();
    await priyaAsks();
    breakIt();
    expect((await h.core.check(gateRefund(small, support))).decision).toBe("hold");
  });

  it("a lookup that hangs holds nothing up past the transport's own timeout, and allows nothing", async () => {
    atL3();
    await priyaAsks();
    h.lookup.lookup = () => new Promise(() => undefined);
    const answer = await Promise.race([h.core.check(gateRefund(small, support)), later().then(later).then(() => "pending")]);
    expect(answer).toBe("pending");
  });
});

describe("L3's budget under parallel calls, with lookups that take real turns of the event loop", () => {
  it("doesn't overspend when each lookup ends on its own macrotask, as HTTP does", async () => {
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L3", h.clock.nowMs());
    await priyaAsks();
    const real = h.lookup.lookup.bind(h.lookup);
    h.lookup.lookup = async (kind, id) => {
      await later();
      return real(kind, id);
    };
    const calls = Array.from({ length: 8 }, (_, index) =>
      h.core.check(gateRefund({ order_id: "A-2004", customer_id: `cus_2044`, amount: 3000 + index, destination: "rohan.s@okhdfc" }, support)),
    );
    const answers = await Promise.all(calls);
    const spent = answers.reduce((sum, answer, index) => (answer.decision === "allow" ? sum + 3000 + index : sum), 0);
    expect(spent).toBeLessThanOrEqual(10_000); // The tighter of the window and the L3 cap.
  });
});

describe("the gate's stored call is bound to what the card showed", () => {
  const email = (args: Record<string, unknown>): Action => ({
    id: actionId(),
    at: new Date(NOW).toISOString(),
    source: "gate",
    vendor: "gate",
    agent: { name: "support-agent" },
    session: { switchRoomId: "#support" },
    kind: "business",
    raw: args,
    business: { endpoint: "POST /acme/emails", args },
  });

  it.each([
    ["amount", { ...REFUND_SC4, amount: 40001 }],
    ["destination", { ...REFUND_SC4, destination: "someone@okicici" }],
    ["customer", { ...REFUND_SC4, customer_id: "cus_8812" }],
    ["order", { ...REFUND_SC4, order_id: "A-1931" }],
  ])("a refund that changes %s is a new request", async (_field, args) => {
    await priyaAsks();
    const first = await h.core.check(gateRefund(REFUND_SC4, support));
    const second = await h.core.check(gateRefund(args, support));
    expect(second.request_id).not.toBe(first.request_id);
    expect(second.call_hash).not.toBe(first.call_hash);
  });

  it("an email that changes only its body is a new request, though the card can't show it", async () => {
    const base = { to: "a@acme.in", subject: "s", body: "one", attachments: [] };
    const first = await h.core.check(email(base));
    const second = await h.core.check(email({ ...base, body: "two" }));
    expect(second.call_hash).not.toBe(first.call_hash);
  });

  it("execute is told the hash of the request that was approved, not of anything since", async () => {
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    await press(cardFor(held.request_id!, "dm-sam"), PARTICIPANTS.sam);
    expect(h.gate.calls).toEqual([{ requestId: held.request_id, callHash: held.call_hash }]);
  });
});

describe("the fixed races stay fixed, and a slow first attempt isn't doubled", () => {
  it("the tick and an approval both reaching execute run it once", async () => {
    await priyaAsks();
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    let finish!: (value: ExecuteResult) => void;
    const execute = h.gate.execute.bind(h.gate);
    let calls = 0;
    h.gate.execute = (id, hash) => {
      calls += 1;
      void execute(id, hash);
      return new Promise<ExecuteResult>((done) => (finish = done));
    };
    const answering = press(cardFor(held.request_id!, "dm-sam"), PARTICIPANTS.sam);
    await later();
    await later();
    h.clock.advance(6_000);
    await h.core.tick();
    finish({ ok: true, alreadyExecuted: false, status: 201, result: { id: "re_7731" } });
    await answering;
    expect(calls).toBe(1);
    expect(state(held.request_id)).toBe("EXECUTED");
  });

  it("the tick doesn't re-route a hold whose first cards are still opening", async () => {
    await priyaAsks();
    const open = h.chat.openCard.bind(h.chat);
    let release!: () => void;
    let waiting = true;
    h.chat.openCard = async (input): Promise<OpenCardResult> => {
      if (waiting) {
        waiting = false;
        await new Promise<void>((done) => (release = done));
      }
      return open(input);
    };
    const checking = h.core.check(gateRefund(REFUND_SC4, support));
    await later();
    await h.core.tick();
    release();
    await checking;
    expect(h.chat.cards.filter((card) => card.roomId === "dm-sam")).toHaveLength(1);
  });
});

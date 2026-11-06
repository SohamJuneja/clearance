/**
 * The other half of the third review: what was attacked and held. All green, so these are evidence and not findings. The
 * breaks are in third-review.test.ts and third-review-shell.test.ts.
 */
import { claudeToActions } from "@clearance/adapters";
import type { Action, OpenCardInput, OpenCardResult } from "@clearance/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenedCard } from "./fakes.js";
import { actionId, chatMessage, gateRefund, hookShell, makeHarness, MINUTE, NOW, PARTICIPANTS, REFUND_SC4, type Harness } from "./harness.js";

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
const press = (card: { sessionId: string; switchRequestId: string }, who: string, answer = "allow") =>
  h.core.onApprovalOutcome({ sessionId: card.sessionId, switchRequestId: card.switchRequestId, kind: "approval", state: "answered", answer, answeredBy: who, answeredAtMs: h.clock.nowMs() });
const typed = (card: OpenedCard, who: string, text: string) =>
  h.core.onApprovalOutcome({
    sessionId: card.sessionId,
    switchRequestId: card.switchRequestId,
    kind: "questions",
    state: "answered",
    answer: null,
    answers: [{ question_id: card.questions[0]?.id ?? "x", custom_text: text, selected_option_ids: [] }],
    answeredBy: who,
    answeredAtMs: h.clock.nowMs(),
  });
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
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await later();
};
const lastCounter = () => h.chat.cards.filter((card) => card.title.includes("COUNTER")).at(-1) as OpenedCard;
const LAST4 = "khdfc".slice(-4);
const counterSays = (who: string, id: string, amount: string) => says(who, `@clearance counter ${id} ${amount}`, "#finance");
const allIds = () => h.core.listRequests().map((row) => row.id as string);

async function held(): Promise<string> {
  await priyaAsks();
  return (await h.core.check(gateRefund(REFUND_SC4, support))).request_id!;
}

describe("F20: what a counter can't change", () => {
  it.each([
    ["more", "40001"],
    ["the same", "40000"],
    ["zero", "0"],
    ["a fraction", "3999.5"],
    ["not a number", "4000 to rohan.evil@okaxis"],
    ["a word", "destination=rohan.evil@okaxis"],
  ])("%s is refused, and no card or request appears", async (_what, amount) => {
    const id = await held();
    const before = h.chat.cards.length;
    await counterSays(PARTICIPANTS.sam, id, amount);
    expect(h.chat.cards.length).toBe(before);
    expect(allIds()).toEqual([id]);
    expect(state(id)).toBe("ROUTED");
  });

  it("only the amount differs in what the gate is told, and the amount it's told is the card's", async () => {
    const id = await held();
    await counterSays(PARTICIPANTS.sam, id, "4000");
    await typed(lastCounter(), PARTICIPANTS.sam, LAST4);
    expect(h.gate.edits).toHaveLength(1);
    expect(h.gate.edits[0]).toMatchObject({ requestId: id, amount: 4000 });
    const created = allIds().find((other) => other !== id) as string;
    const call = h.core.stores.requests.require(created).call.args as Record<string, unknown>;
    const original = h.core.stores.requests.require(id).call.args as Record<string, unknown>;
    expect({ ...call, amount: 0 }).toEqual({ ...original, amount: 0 });
    expect(call.amount).toBe(4000);
  });
});

describe("F20: who can use it", () => {
  it.each([
    ["the requester", "priya"],
    ["someone who isn't finance", "dev"],
  ])("%s is refused", async (_who, person) => {
    const id = await held();
    const sender = person === "priya" ? PARTICIPANTS.priya : PARTICIPANTS.dev;
    const before = h.chat.cards.length;
    await counterSays(sender, id, "4000");
    expect(h.chat.cards.length).toBe(before);
    expect(state(id)).toBe("ROUTED");
  });

  it("an agent, and an account linked to nobody, get no answer at all", async () => {
    const id = await held();
    const before = h.chat.messages.length;
    await counterSays(PARTICIPANTS.refundsAgent, id, "4000");
    await counterSays(PARTICIPANTS.guest, id, "4000");
    expect(h.chat.messages.length).toBe(before);
  });

  it("someone else's answer on the card can't carry the offer, and drops it", async () => {
    const id = await held();
    await counterSays(PARTICIPANTS.sam, id, "4000");
    await typed(lastCounter(), PARTICIPANTS.neha, LAST4);
    expect(h.gate.edits).toEqual([]);
    expect(state(id)).toBe("ROUTED");
  });

  it("an offer by someone barred after making it dies on the answer", async () => {
    const id = await held();
    await counterSays(PARTICIPANTS.sam, id, "4000");
    await says(PARTICIPANTS.sam, "@clearance away until 18:00");
    await typed(lastCounter(), PARTICIPANTS.sam, LAST4);
    expect(h.gate.edits).toEqual([]);
    expect(state(id)).toBe("ROUTED");
  });

  it("a drill can't be edited, and a drill's recipient gets nothing that runs", async () => {
    const sent = await h.core.sendDrill("sam", "new_destination");
    if (!sent.ok) throw new Error(sent.reason);
    await counterSays(PARTICIPANTS.sam, sent.requestId, "1000");
    expect(h.gate.edits).toEqual([]);
    expect(h.gate.calls).toEqual([]);
    expect(state(sent.requestId)).toBe("ROUTED");
  });

  it("a hook call can't be edited", async () => {
    const answer = await h.core.check(hookShell("git push origin main", { agent: { name: "coder" } }));
    await says(PARTICIPANTS.dev, `@clearance counter ${answer.request_id} 10`);
    expect(h.gate.edits).toEqual([]);
    expect(allIds()).toEqual([answer.request_id]);
  });
});

describe("F20: quorum", () => {
  it("on a two-person amount the offer is one approval and the second is someone else's", async () => {
    await priyaAsks();
    const first = await h.core.check(gateRefund({ order_id: "A-2004", customer_id: "cus_2044", amount: 200000, destination: "rohan.s@okhdfc" }, support));
    await counterSays(PARTICIPANTS.sam, first.request_id!, "150000");
    await typed(lastCounter(), PARTICIPANTS.sam, LAST4);
    const created = allIds().find((other) => other !== first.request_id) as string;
    expect(h.core.stores.requests.require(created).quorumRequired).toBe(2);
    expect(h.gate.calls).toEqual([]);
    expect(h.core.stores.answers.countedApprovers(created)).toEqual(["sam"]);
    // His other account changes nothing.
    await typed(cardFor(created, "#support"), PARTICIPANTS.samSecond, "150000");
    expect(h.core.stores.answers.countedApprovers(created)).toEqual(["sam"]);
    expect(h.gate.calls).toEqual([]);
  });

  it("an approval of the original doesn't carry over", async () => {
    await priyaAsks();
    const first = await h.core.check(gateRefund({ order_id: "A-2004", customer_id: "cus_2044", amount: 200000, destination: "rohan.s@okhdfc" }, support));
    await typed(cardFor(first.request_id!, "dm-sam"), PARTICIPANTS.sam, "200000");
    await counterSays(PARTICIPANTS.neha, first.request_id!, "150000");
    await typed(lastCounter(), PARTICIPANTS.neha, LAST4);
    const created = allIds().find((other) => other !== first.request_id) as string;
    expect(h.core.stores.answers.countedApprovers(created)).toEqual(["neha"]);
    expect(h.gate.calls).toEqual([]);
  });

  it("nobody known to have asked stays two people, however small the edit", async () => {
    const first = await h.core.check(gateRefund(REFUND_SC4, { session: undefined }));
    expect(h.core.stores.requests.require(first.request_id!).quorumRequired).toBe(2);
    await counterSays(PARTICIPANTS.sam, first.request_id!, "100");
    await typed(lastCounter(), PARTICIPANTS.sam, LAST4);
    const created = allIds().find((other) => other !== first.request_id) as string;
    expect(h.core.stores.requests.require(created).quorumRequired).toBe(2);
    expect(h.gate.calls).toEqual([]);
  });
});

describe("F20: against an approval of the original at the same moment", () => {
  /** Stream handlers really run one at a time, so this is harder than the real thing: both at once, on every interleaving. */
  it("the counter's lookups waiting while an approval lands: the original runs, once, and the offer changes nothing", async () => {
    const id = await held();
    await counterSays(PARTICIPANTS.sam, id, "4000");
    const real = h.lookup.lookup.bind(h.lookup);
    h.lookup.lookup = async (kind, key) => {
      await later();
      return real(kind, key);
    };
    const counter = typed(lastCounter(), PARTICIPANTS.sam, LAST4);
    await press(cardFor(id, "dm-sam"), PARTICIPANTS.neha);
    await counter;
    expect(h.gate.calls).toEqual([{ requestId: id, callHash: h.core.stores.requests.require(id).callHash }]);
    expect(h.gate.edits).toEqual([]);
    expect(state(id)).toBe("EXECUTED");
    expect(allIds()).toEqual([id]);
  });

  it("the edit landing first: an approval of the original changes nothing, and only the edit runs", async () => {
    const id = await held();
    await counterSays(PARTICIPANTS.sam, id, "4000");
    await typed(lastCounter(), PARTICIPANTS.sam, LAST4);
    const created = allIds().find((other) => other !== id) as string;
    await press(cardFor(id, "dm-sam"), PARTICIPANTS.neha);
    expect(state(id)).toBe("EDITED");
    expect(h.gate.calls.map((call) => call.requestId)).toEqual([created]);
  });

  it("a denial first, then the offer: nothing runs", async () => {
    const id = await held();
    await counterSays(PARTICIPANTS.sam, id, "4000");
    const card = lastCounter();
    await press(cardFor(id, "dm-sam"), PARTICIPANTS.neha, "deny");
    await typed(card, PARTICIPANTS.sam, LAST4);
    expect(state(id)).toBe("DENIED");
    expect(h.gate.calls).toEqual([]);
    expect(h.gate.edits).toEqual([]);
  });

  it("a redelivered yes on the offer makes one request", async () => {
    const id = await held();
    await counterSays(PARTICIPANTS.sam, id, "4000");
    const card = lastCounter();
    await typed(card, PARTICIPANTS.sam, LAST4);
    await typed(card, PARTICIPANTS.sam, LAST4);
    expect(allIds()).toHaveLength(2);
    expect(h.gate.calls).toHaveLength(1);
  });

  it("the offer outlasting the request: past expiry it does nothing", async () => {
    const id = await held();
    await counterSays(PARTICIPANTS.sam, id, "4000");
    h.clock.advance(26 * MINUTE);
    await typed(lastCounter(), PARTICIPANTS.sam, LAST4);
    expect(state(id)).toBe("EXPIRED");
    expect(h.gate.edits).toEqual([]);
  });
});

describe("F20: an edit is no credit towards autonomy", () => {
  it("over-asking and being corrected doesn't build the agent's record in the smaller bucket", async () => {
    const id = await held();
    await counterSays(PARTICIPANTS.sam, id, "4000");
    await typed(lastCounter(), PARTICIPANTS.sam, LAST4);
    const created = allIds().find((other) => other !== id) as string;
    expect(state(created)).toBe("EXECUTED");
    const [small] = await h.core.autonomyReplay({ agent: "refunds-agent", class: "refund", bucket: "small" });
    expect(small?.counted).toBe(0);
    expect(small?.edited).toBe(1);
  });
});

describe("route rows written before the card opens", () => {
  const holdOpen = (room?: string) => {
    const open = h.chat.openCard.bind(h.chat);
    let release!: () => void;
    const gateOpen = new Promise<void>((done) => (release = done));
    h.chat.openCard = async (input: OpenCardInput): Promise<OpenCardResult> => {
      if (!room || input.roomId === room) await gateOpen;
      return open(input);
    };
    return () => release();
  };

  it("a request whose card is opening still expires, and the card is closed once it exists", async () => {
    await priyaAsks();
    const release = holdOpen("dm-sam");
    const checking = h.core.check(gateRefund(REFUND_SC4, support));
    await settle();
    const id = h.core.stores.requests.listInState(["HELD"])[0]?.id as string;
    h.clock.advance(26 * MINUTE);
    await h.core.tick();
    expect(state(id)).toBe("EXPIRED");
    release();
    await checking;
    expect(h.chat.cards.filter((card) => !card.closed)).toEqual([]);
    expect(h.gate.calls).toEqual([]);
  });

  it("a row still opening doesn't reach the inbox", async () => {
    await priyaAsks();
    const release = holdOpen("dm-sam");
    const checking = h.core.check(gateRefund(REFUND_SC4, support));
    await settle();
    expect(h.core.inboxItems("sam")).toEqual([]);
    release();
    await checking;
    expect(h.core.inboxItems("sam")).toHaveLength(1);
  });

  it("a row still opening means the tick doesn't open a second card for that person", async () => {
    await priyaAsks();
    const release = holdOpen("dm-sam");
    const checking = h.core.check(gateRefund(REFUND_SC4, support));
    await settle();
    await h.core.tick();
    await h.core.tick();
    release();
    await checking;
    expect(h.chat.cards.filter((card) => card.roomId === "dm-sam")).toHaveLength(1);
  });

  it("a card that fails to open leaves a HELD request the tick opens again, and it can still expire", async () => {
    await priyaAsks();
    h.chat.failOpenCard = true;
    const answer = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(state(answer.request_id)).toBe("HELD");
    for (let i = 0; i < 5; i += 1) await h.core.tick();
    h.chat.failOpenCard = false;
    await h.core.tick();
    expect(state(answer.request_id)).toBe("ROUTED");
    expect(h.chat.cards.filter((card) => card.roomId === "dm-sam")).toHaveLength(1);
  });

  it("a Switch that never comes back still lets it expire", async () => {
    await priyaAsks();
    h.chat.failOpenCard = true;
    const answer = await h.core.check(gateRefund(REFUND_SC4, support));
    h.clock.advance(26 * MINUTE);
    await h.core.tick();
    expect(state(answer.request_id)).toBe("EXPIRED");
  });

  it("a restart mid-open marks the row failed, so the next tick opens a card rather than wait on a dead one", async () => {
    await priyaAsks();
    holdOpen("dm-sam");
    void h.core.check(gateRefund(REFUND_SC4, support));
    await settle();
    const id = h.core.stores.requests.listInState(["HELD"])[0]?.id as string;
    h = h.restart();
    h.chat.openCard = Object.getPrototypeOf(h.chat).openCard.bind(h.chat);
    await h.core.tick();
    expect(h.core.stores.routes.openForRequest(id).filter((row) => row.step !== "origin_copy").length).toBeGreaterThan(0);
    expect(state(id)).toBe("ROUTED");
  });

  it("a quorum isn't reached by rows: an opening or failed row counts for nothing", async () => {
    await priyaAsks();
    h.chat.failOpenCard = true;
    const answer = await h.core.check(gateRefund({ order_id: "A-2004", customer_id: "cus_2044", amount: 150000, destination: "rohan.s@okhdfc" }, support));
    expect(h.core.stores.answers.countedApprovers(answer.request_id!)).toEqual([]);
    expect(h.gate.calls).toEqual([]);
  });

  it("an answer that beats the row's opening counts once, and the card it landed on isn't left open", async () => {
    await priyaAsks();
    const open = h.chat.openCard.bind(h.chat);
    h.chat.openCard = async (input: OpenCardInput): Promise<OpenCardResult> => {
      const result = await open(input);
      if (input.roomId === "dm-sam") {
        await press(result, PARTICIPANTS.sam);
        await press(result, PARTICIPANTS.sam);
      }
      return result;
    };
    const answer = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(h.gate.calls).toHaveLength(1);
    expect(state(answer.request_id)).toBe("EXECUTED");
  });
});

describe("outcome unknown", () => {
  it("nothing an agent sends can produce it, or get a call out of it", async () => {
    await priyaAsks();
    const held1 = await h.core.check(gateRefund(REFUND_SC4, support));
    h.gate.respond = () => ({ ok: false, alreadyExecuted: false, error: "outcome unknown: acme did not answer, so the gate will not run this again" });
    await press(cardFor(held1.request_id!, "dm-sam"), PARTICIPANTS.sam);
    expect(state(held1.request_id)).toBe("OUTCOME_UNKNOWN");
    const calls = h.gate.calls.length;
    h.gate.respond = () => ({ ok: true, alreadyExecuted: false, status: 201, result: { id: "re" } });
    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(6_000);
      await h.core.tick();
    }
    await says(PARTICIPANTS.alex, `@clearance breakglass ${held1.request_id} try it again`);
    expect(h.gate.calls.length).toBe(calls);
    expect(state(held1.request_id)).toBe("OUTCOME_UNKNOWN");
    const texts = [...h.chat.messages, ...h.chat.targeted].map((m) => m.body).join("\n");
    expect(texts).not.toContain("did not run");
  });

  it("the same call asked for again says so on the card", async () => {
    await priyaAsks();
    const first = await h.core.check(gateRefund(REFUND_SC4, support));
    h.gate.respond = () => ({ ok: false, alreadyExecuted: false, error: "outcome unknown: x" });
    await press(cardFor(first.request_id!, "dm-sam"), PARTICIPANTS.sam);
    h.gate.respond = () => ({ ok: true, alreadyExecuted: false, status: 201, result: {} });
    const again = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(h.core.stores.requests.require(again.request_id!).flags.map((flag) => flag.code)).toContain("may_have_run");
  });

  it("an L3 run the gate reports failed, for a request that isn't AUTO any more, changes nothing", async () => {
    const id = await held();
    expect(await h.core.autoRunFailed(id, { neverRan: true, error: "x" })).toBe("not_auto");
    expect(state(id)).toBe("ROUTED");
  });
});

describe("the grant binding", () => {
  const write = (input: Record<string, unknown>) =>
    claudeToActions({ hook_event_name: "PreToolUse", cwd: "/w", tool_name: "Edit", tool_input: { file_path: ".github/workflows/deploy.yml", ...input } }, { agent: "coder", id: actionId(), at: new Date(NOW).toISOString() })[0] as Action;
  const grantTo = async (action: Action): Promise<void> => {
    const answer = await h.core.check(action);
    const id = answer.request_id as string;
    const { requests, grants } = h.core.stores;
    if (requests.get(id)?.state === "HELD") requests.transition(id, "ROUTED");
    requests.transition(id, "APPROVED");
    grants.mint(id, answer.call_hash as string, "coder", h.clock.scaledMs(10 * MINUTE));
    requests.transition(id, "GRANTED");
  };

  it.each([
    ["the new text", { old_string: "a", new_string: "evil" }],
    ["the old text", { old_string: "other", new_string: "b" }],
    ["replace_all", { old_string: "a", new_string: "b", replace_all: true }],
    ["a field a later version adds", { old_string: "a", new_string: "b", mode: "x" }],
  ])("an Edit grant doesn't cover a change to %s", async (_what, change) => {
    await grantTo(write({ old_string: "a", new_string: "b" }));
    expect((await h.core.check(write(change))).decision).not.toBe("allow");
  });

  it("the agent's description isn't part of what's bound, and changing it gains nothing", async () => {
    await grantTo(write({ old_string: "a", new_string: "b", description: "one" }));
    expect((await h.core.check(write({ old_string: "a", new_string: "b", description: "two" }))).decision).toBe("allow");
  });

  it.each([
    ["cd into a subdirectory", "cd src && rm -rf ../build"],
    ["an assignment", "X=1; rm -rf ../build"],
    ["export", "export X=1; rm -rf ../build"],
    ["alias", "alias rm=evil; rm -rf ../build"],
    ["a shell string", "sudo bash -c 'rm -rf ../build'"],
    ["a loop", "for i in 1 2; do rm -rf ../build; done"],
    ["a pipe in", "yes | rm -rf ../build"],
    ["twice", "rm -rf ../build; rm -rf ../build"],
  ])("a shell grant doesn't cover %s", async (_what, line) => {
    await grantTo(hookShell("rm -rf ../build", { agent: { name: "coder" } }));
    expect((await h.core.check(hookShell(line, { agent: { name: "coder" } }))).decision).not.toBe("allow");
  });

  it("a different cwd or workdir is a different call, and one that resolves to the same place isn't", async () => {
    const at = (workdir?: string) => hookShell("rm -rf ../build", { agent: { name: "coder", cwd: "/w" }, shell: { command: "rm -rf ../build", ...(workdir ? { workdir } : {}) } });
    await grantTo(at());
    expect((await h.core.check(at("src"))).decision).not.toBe("allow");
    expect((await h.core.check(at("."))).decision).toBe("allow");
  });
});

describe("the identical-call hold can't lock anyone out", () => {
  it("it adds a flag and a card, and the same person can still approve", async () => {
    await priyaAsks();
    const first = await h.core.check(gateRefund(REFUND_SC4, support));
    await press(cardFor(first.request_id!, "dm-sam"), PARTICIPANTS.sam);
    await priyaAsks();
    const second = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(h.core.stores.requests.require(second.request_id!).quorumRequired).toBe(1);
    await press(cardFor(second.request_id!, "#support"), PARTICIPANTS.neha);
    expect(state(second.request_id)).toBe("EXECUTED");
  });
});

describe("isSwitchNotice", () => {
  it("a person's message in those words is still a person asking", async () => {
    await says(PARTICIPANTS.refundsAgent, "hello", "#finance");
    await says(PARTICIPANTS.sam, "Hi! I'm sam — how can I help?", "#finance", { addressed: false });
    await priyaAsks();
    const answer = await h.core.check(gateRefund(REFUND_SC4, support));
    await press(cardFor(answer.request_id!, "#support"), PARTICIPANTS.sam);
    expect(h.gate.calls).toEqual([]);
  });

  it("an agent can't use one to hide that someone asked it: a notice isn't a reply, so they stay barred", async () => {
    await says(PARTICIPANTS.sam, "@refunds-agent refund order A-2004", "#finance");
    await says(PARTICIPANTS.refundsAgent, "Starting a session to handle this — one moment.", "#finance");
    h.clock.advance(11 * MINUTE);
    await priyaAsks();
    const answer = await h.core.check(gateRefund(REFUND_SC4, support));
    await press(cardFor(answer.request_id!, "#support"), PARTICIPANTS.sam);
    expect(h.gate.calls).toEqual([]);
  });
});

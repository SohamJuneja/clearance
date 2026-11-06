/** F7: one running inbox per approver, across rooms. Live proof of the 2 seconds is spikes/s-inbox-live.ts. */
import { afterEach, describe, expect, it } from "vitest";
import { inboxMessage, isInboxMessage, type InboxItem } from "../src/inbox/inbox.js";
import { createInboxKeeper, INBOX_SYNC_EVERY_MS, type InboxKeeper } from "../src/inbox/keeper.js";
import { chatMessage, gateRefund, makeHarness, MINUTE, NOW, PARTICIPANTS, REFUND_CRITICAL, REFUND_SC3, REFUND_SC4, type Harness, type HarnessOptions } from "./harness.js";

let h: Harness;
const started: Harness[] = [];

function start(options: HarnessOptions = {}): Harness {
  h = makeHarness({ runningInbox: true, ...options });
  started.push(h);
  return h;
}
afterEach(() => {
  for (const each of started.splice(0)) each.core.close();
});

const keeperOf = (harness: Harness, extra: { erase?: (roomId: string) => Promise<void>; log?: (m: string) => void } = {}): InboxKeeper =>
  createInboxKeeper(harness.core, { chat: harness.chat, clock: harness.clock, ...extra });

const support = { session: { switchRoomId: "#support", threadId: "t-1" } };
const finance = { session: { switchRoomId: "#finance", threadId: "t-2" } };

/** Everything the keeper put in a room, in order, whichever way it was sent. */
const inboxPosts = (roomId: string) =>
  [...h.chat.targeted, ...h.chat.messages].filter((post) => post.roomId === roomId && isInboxMessage(post.body)).map((post) => post.body);

const answer = async (card: { sessionId: string; switchRequestId: string }, by: string, choice: string) =>
  h.core.onApprovalOutcome({ sessionId: card.sessionId, switchRequestId: card.switchRequestId, kind: "approval", state: "answered", answer: choice, answeredBy: by });

describe("two requests from two rooms", () => {
  it("are one post in the approver's direct room, newest first, with what the plan asks each line to say", async () => {
    start();
    const keeper = keeperOf(h);
    await h.core.check(gateRefund(REFUND_SC3, support));
    h.clock.advance(2 * MINUTE);
    await h.core.check(gateRefund(REFUND_SC4, finance));
    await keeper.sync();

    expect(inboxPosts("dm-sam")).toHaveLength(1);
    const [head, newest, older] = inboxPosts("dm-sam")[0]!.split("\n");
    expect(head).toBe("**Needs your response (2)**");
    expect(newest).toBe("CLR-0002 refund ₹40,000 · #finance · 0 s");
    expect(older).toBe("CLR-0001 refund ₹4,000 · #support · 2 min");
  });

  it("puts the codes in when Switch gave them, which is what someone replies with", async () => {
    start();
    h.chat.giveHandles = true;
    const keeper = keeperOf(h);
    await h.core.check(gateRefund(REFUND_SC3, support));
    await h.core.check(gateRefund(REFUND_SC4, finance));
    await keeper.sync();
    const post = inboxPosts("dm-sam")[0]!;
    const sams = h.chat.cards.filter((card) => card.roomId === "dm-sam");
    for (const card of sams) expect(post).toContain(`${card.handle} CLR-`);
    expect(post).toContain("Reply here with a code");
  });

  it("is checked often enough that the post can follow a hold inside 2 seconds", () => {
    expect(INBOX_SYNC_EVERY_MS).toBeLessThanOrEqual(1000);
  });

  it("are one post, not two, when they arrive together", async () => {
    start();
    const keeper = keeperOf(h);
    await Promise.all([h.core.check(gateRefund(REFUND_SC3, support)), h.core.check(gateRefund(REFUND_SC4, finance))]);
    await keeper.sync();
    expect(inboxPosts("dm-sam")).toHaveLength(1);
    expect(inboxPosts("dm-sam")[0]).toContain("(2)");
  });
});

describe("answering from the inbox", () => {
  it("settles the original request: it runs, the card in the origin room closes, and the list shrinks", async () => {
    start();
    h.chat.giveHandles = true;
    const keeper = keeperOf(h);
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    const first = await h.core.check(gateRefund(REFUND_SC3, support));
    const second = await h.core.check(gateRefund(REFUND_SC4, finance));
    await keeper.sync();

    // The code the person reads off the inbox names exactly one card in that room.
    const handle = /^(A\d+) CLR-0001/m.exec(inboxPosts("dm-sam")[0]!)?.[1];
    expect(handle).toBeDefined();
    const answered = h.chat.cards.find((card) => card.handle === handle && card.roomId === "dm-sam")!;
    await answer(answered, PARTICIPANTS.sam, "allow");

    expect(h.core.describeRequest(first.request_id!)?.state).toBe("EXECUTED");
    expect(h.gate.calls.map((call) => call.requestId)).toEqual([first.request_id]);
    const originCard = h.chat.cards.find((card) => card.roomId === "#support")!;
    expect(originCard.closed).toBe(true);
    expect(h.core.describeRequest(second.request_id!)?.state).toBe("ROUTED");

    await keeper.sync();
    const latest = inboxPosts("dm-sam").at(-1)!;
    expect(latest).toContain("(1)");
    expect(latest).toContain(second.request_id!);
    expect(latest).not.toContain(first.request_id!);
  });
});

describe("what a person sees: the card and the list are not duplicates", () => {
  it("gives a request one card and one list, with no third line saying the card is above", async () => {
    start();
    const keeper = keeperOf(h);
    await h.core.check(gateRefund(REFUND_SC4, support));
    await keeper.sync();
    const inDirectRoom = h.chat.targeted.filter((post) => post.roomId === "dm-sam");
    expect(inDirectRoom).toHaveLength(1);
    expect(isInboxMessage(inDirectRoom[0]!.body)).toBe(true);
    expect(h.chat.cards.filter((card) => card.roomId === "dm-sam")).toHaveLength(1);
  });

  it("carries no evidence, which stays on the card", async () => {
    start();
    const keeper = keeperOf(h);
    await h.core.check(gateRefund(REFUND_SC3, support));
    await keeper.sync();
    const post = inboxPosts("dm-sam")[0]!;
    expect(post.split("\n").length).toBeLessThanOrEqual(3);
    expect(post).not.toContain("Flags");
  });

  it("mentions the person for new work and not for a list that only got shorter", async () => {
    start();
    h.chat.giveHandles = true;
    const keeper = keeperOf(h);
    await h.core.check(gateRefund(REFUND_SC3, support));
    await h.core.check(gateRefund(REFUND_SC4, finance));
    await keeper.sync();
    expect(h.chat.targeted.filter((post) => post.roomId === "dm-sam").map((post) => post.targets)).toEqual([["sam"]]);
    await answer(h.chat.cards.find((card) => card.roomId === "dm-sam")!, PARTICIPANTS.sam, "deny");
    await keeper.sync();
    expect(h.chat.targeted.filter((post) => post.roomId === "dm-sam")).toHaveLength(1);
    expect(h.chat.messages.filter((post) => post.roomId === "dm-sam" && isInboxMessage(post.body))).toHaveLength(1);
  });

  it("still explains itself when someone is brought in as a backup", async () => {
    start();
    const keeper = keeperOf(h);
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    await h.core.check(gateRefund(REFUND_SC4, support));
    h.clock.advance(3 * MINUTE + 1000);
    await h.core.tick();
    await keeper.sync();
    const said = h.chat.targeted.filter((post) => post.roomId === "dm-neha").map((post) => post.body);
    expect(said.some((body) => body.includes("backup"))).toBe(true);
    expect(said.some((body) => isInboxMessage(body))).toBe(true);
  });

  it("says when its ages were true, since the post stays up and they stop being", async () => {
    start();
    const keeper = keeperOf(h);
    await h.core.check(gateRefund(REFUND_SC4, support));
    await keeper.sync();
    expect(inboxPosts("dm-sam")[0]).toContain("Ages as of 14:00");
  });
});

describe("a card that takes a moment to open", () => {
  /** Reading a card's code back from Mattermost takes about 250 ms, and the tick runs every second. */
  const slowOpens = () => {
    const open = h.chat.openCard.bind(h.chat);
    const release: (() => void)[] = [];
    h.chat.openCard = async (input) => {
      const result = await open(input);
      await new Promise<void>((done) => release.push(done));
      return result;
    };
    return async () => {
      for (let turn = 0; turn < 50; turn += 1) {
        release.splice(0).forEach((done) => done());
        await new Promise((done) => setImmediate(done));
      }
    };
  };

  it("isn't opened twice when a tick lands while it is opening", async () => {
    start();
    const finish = slowOpens();
    const held = h.core.check(gateRefund(REFUND_SC4, support));
    await new Promise((done) => setImmediate(done));
    expect(h.chat.cards.filter((card) => card.roomId === "dm-sam")).toHaveLength(1);

    const tick = h.core.tick();
    await finish();
    await Promise.all([held, tick]);
    expect(h.chat.cards.filter((card) => card.roomId === "dm-sam")).toHaveLength(1);
  });

  it("is still retried by the tick when opening failed", async () => {
    start();
    h.chat.failOpenCard = true;
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(h.core.describeRequest(held.request_id!)?.state).toBe("HELD");
    h.chat.failOpenCard = false;
    await h.core.tick();
    expect(h.chat.cards.filter((card) => card.roomId === "dm-sam")).toHaveLength(1);
    expect(h.core.describeRequest(held.request_id!)?.state).toBe("ROUTED");
  });
});

describe("reposting only when the list changes", () => {
  it("posts nothing while only the ages move", async () => {
    start();
    const keeper = keeperOf(h);
    await h.core.check(gateRefund(REFUND_SC4, support));
    await keeper.sync();
    for (let minute = 0; minute < 5; minute += 1) {
      h.clock.advance(MINUTE / 2);
      await keeper.sync();
    }
    expect(inboxPosts("dm-sam")).toHaveLength(1);
  });

  it("removes the old post before the new one goes up", async () => {
    start();
    const order: string[] = [];
    const chat = h.chat;
    const original = chat.sendTargeted.bind(chat);
    chat.sendTargeted = async (input) => {
      order.push(`post ${input.roomId}`);
      await original(input);
    };
    const keeper = keeperOf(h, {
      erase: async (roomId) => {
        order.push(`erase ${roomId}`);
      },
    });
    await h.core.check(gateRefund(REFUND_SC4, support));
    await keeper.sync();
    expect(order.filter((step) => step.endsWith("dm-sam"))).toEqual(["erase dm-sam", "post dm-sam"]);
  });

  it("leaves no post at all when the list empties and the old one can be removed", async () => {
    start();
    const erased: string[] = [];
    const keeper = keeperOf(h, { erase: async (roomId) => void erased.push(roomId) });
    h.chat.giveHandles = true;
    await h.core.check(gateRefund(REFUND_SC4, support));
    await keeper.sync();
    await answer(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "allow");
    erased.length = 0;
    const before = inboxPosts("dm-sam").length;
    await keeper.sync();
    expect(erased).toEqual(["dm-sam"]);
    expect(inboxPosts("dm-sam")).toHaveLength(before);
  });

  it("sweeps once more after emptying, for a post that was still on its way", async () => {
    start();
    const erased: string[] = [];
    const keeper = keeperOf(h, { erase: async (roomId) => void erased.push(roomId) });
    await h.core.check(gateRefund(REFUND_SC4, support));
    await keeper.sync();
    await answer(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "allow");
    await keeper.sync();
    erased.length = 0;
    await keeper.sync();
    expect(erased).toEqual([]);
    h.clock.advance(3_100);
    await keeper.sync();
    expect(erased).toEqual(["dm-sam"]);
    h.clock.advance(3_100);
    await keeper.sync();
    expect(erased).toEqual(["dm-sam"]);
  });

  it("says the list is empty when it can't remove the old post, because a stale (1) would be a lie", async () => {
    start();
    const keeper = keeperOf(h);
    await h.core.check(gateRefund(REFUND_SC4, support));
    await keeper.sync();
    await answer(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "deny");
    await keeper.sync();
    expect(inboxPosts("dm-sam").at(-1)).toBe("**Needs your response (0)**\nNothing is waiting on you.");
  });

  it("drops a request when someone else settles it", async () => {
    start();
    const keeper = keeperOf(h);
    await h.core.check(gateRefund(REFUND_CRITICAL, support));
    await keeper.sync();
    expect(inboxPosts("dm-neha")[0]).toContain("(1)");
    await answer(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "deny");
    await keeper.sync();
    expect(inboxPosts("dm-neha").at(-1)).toContain("(0)");
  });

  it("drops a request that expires", async () => {
    start();
    const keeper = keeperOf(h);
    await h.core.check(gateRefund(REFUND_SC4, support));
    await keeper.sync();
    h.clock.advance(26 * MINUTE);
    await h.core.tick();
    await keeper.sync();
    expect(inboxPosts("dm-sam").at(-1)).toContain("(0)");
  });

  it("does not post again after a restart if nothing changed", async () => {
    start();
    await h.core.check(gateRefund(REFUND_SC4, support));
    await keeperOf(h).sync();
    const count = inboxPosts("dm-sam").length;
    const next = h.restart();
    started.push(next);
    h = next;
    await keeperOf(h).sync();
    expect(inboxPosts("dm-sam")).toHaveLength(count);
  });

  it("catches up after a restart if something did", async () => {
    start();
    await h.core.check(gateRefund(REFUND_SC4, support));
    await keeperOf(h).sync();
    const next = h.restart();
    started.push(next);
    h = next;
    await h.core.check(gateRefund(REFUND_SC3, finance));
    await keeperOf(h).sync();
    expect(inboxPosts("dm-sam").at(-1)).toContain("(2)");
  });

  it("never touches the direct room of someone with nothing waiting", async () => {
    start();
    const keeper = keeperOf(h);
    await h.core.check(gateRefund(REFUND_SC4, support));
    await keeper.sync();
    expect(h.chat.directRooms).not.toContain("priya");
    expect(inboxPosts("dm-priya")).toEqual([]);
  });
});

describe("when Switch or Mattermost is failing", () => {
  it("doesn't throw, doesn't count the post as made, and tries again", async () => {
    start();
    const logged: string[] = [];
    const keeper = keeperOf(h, { log: (message) => void logged.push(message) });
    await h.core.check(gateRefund(REFUND_SC4, support));
    const working = h.chat.sendTargeted.bind(h.chat);
    h.chat.sendTargeted = async () => {
      throw new Error("switch unreachable");
    };
    await expect(keeper.sync()).resolves.toBeUndefined();
    expect(logged.join()).toContain("switch unreachable");
    expect(inboxPosts("dm-sam")).toEqual([]);

    h.chat.sendTargeted = working;
    await keeper.sync(); // Inside the back-off: not yet.
    expect(inboxPosts("dm-sam")).toEqual([]);
    h.clock.advance(5_100);
    await keeper.sync();
    expect(inboxPosts("dm-sam")).toHaveLength(1);
  });

  it("doesn't stop one person's post because another's failed", async () => {
    start();
    const keeper = keeperOf(h);
    await h.core.check(gateRefund(REFUND_CRITICAL, support));
    const working = h.chat.sendTargeted.bind(h.chat);
    h.chat.sendTargeted = async (input) => {
      if (input.roomId === "dm-sam") throw new Error("not this room");
      await working(input);
    };
    await keeper.sync();
    expect(inboxPosts("dm-neha")).toHaveLength(1);
  });

  it("still posts the new list when the old post can't be removed", async () => {
    start();
    const keeper = keeperOf(h, {
      erase: async () => {
        throw new Error("Mattermost answered 500");
      },
    });
    await h.core.check(gateRefund(REFUND_SC4, support));
    await keeper.sync();
    expect(inboxPosts("dm-sam")).toHaveLength(1);
  });

  it("holds and answers exactly the same with the chat down: the inbox decides nothing", async () => {
    start();
    const keeper = keeperOf(h);
    h.chat.sendTargeted = async () => {
      throw new Error("switch unreachable");
    };
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(held.decision).toBe("hold");
    await keeper.sync();
    await answer(h.chat.cardIn("dm-sam"), PARTICIPANTS.sam, "allow");
    expect(h.core.describeRequest(held.request_id!)?.state).toBe("EXECUTED");
  });
});

describe("a handle means nothing outside its room", () => {
  const ask = async (roomId: string) => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.sam, "@clearance inbox", { roomId, threadId: null, addressed: true }));
    return h.chat.messages.at(-1)!.body;
  };

  it("shows it in the direct room, where it answers the card", async () => {
    start();
    h.chat.giveHandles = true;
    await h.core.check(gateRefund(REFUND_SC4, support));
    const handle = h.chat.cardIn("dm-sam").handle!;
    expect(await ask("dm-sam")).toContain(`${handle} CLR-0001`);
  });

  it("leaves it out anywhere else, where the same code could be a different card", async () => {
    start();
    h.chat.giveHandles = true;
    await h.core.check(gateRefund(REFUND_SC4, support));
    const handle = h.chat.cardIn("dm-sam").handle!;
    const reply = await ask("#eng");
    expect(reply).not.toContain(handle);
    expect(reply).toContain("CLR-0001");
    expect(reply).toContain("Answer in your direct room");
  });

  it("makes `status A9` mean the card called A9 in the room it is asked in", async () => {
    start();
    h.chat.giveHandles = true;
    const first = await h.core.check(gateRefund(REFUND_SC3, support));
    const second = await h.core.check(gateRefund(REFUND_SC4, finance));
    // Two rooms' counting landing on the same code, as real per-channel handles do.
    const name = h.core.stores.db.prepare(`UPDATE routes SET handle = 'A9' WHERE switch_request_id = ?`);
    name.run(h.chat.cards.find((card) => card.roomId === "dm-sam")!.switchRequestId);
    name.run(h.chat.cards.find((card) => card.roomId === "#finance")!.switchRequestId);
    const status = async (roomId: string) => {
      await h.core.onMessage(chatMessage(PARTICIPANTS.sam, "@clearance status A9", { roomId, threadId: null, addressed: true }));
      return h.chat.messages.at(-1)!.body;
    };
    expect(await status("dm-sam")).toContain(first.request_id!);
    expect(await status("#finance")).toContain(second.request_id!);
  });
});

describe("a card in a shared room", () => {
  const item = (overrides: Partial<InboxItem>): InboxItem => ({
    request_id: "CLR-0009",
    handle: "A4",
    class: "refund",
    tier: "high",
    typed: false,
    what: "refund ₹40,000",
    room: "#support",
    age_s: 30,
    expires_at: new Date(NOW).toISOString(),
    card_room: "#approvals",
    shared_in: "#approvals",
    ...overrides,
  });

  it("is listed, without a code that would mean something else here, and says where the card is", () => {
    const text = inboxMessage([item({})], { roomId: "dm-sam" });
    expect(text).toContain("CLR-0009 refund ₹40,000 · #support · 30 s · card in #approvals");
    expect(text).not.toContain("A4");
  });

  it("shows the code when the list is read in that room", () => {
    expect(inboxMessage([item({})], { roomId: "#approvals" })).toContain("A4 CLR-0009");
  });

  it("reaches the person the real fallback asks, in their own direct room", async () => {
    start();
    h.chat.giveHandles = true;
    // Both finance approvers away, so it goes to the fallback room for eng-leads: Alex.
    h.core.people.store.setAway("sam", h.clock.nowMs() + 60 * MINUTE, null);
    h.core.people.store.setAway("neha", h.clock.nowMs() + 60 * MINUTE, null);
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    expect(h.core.stores.routes.forRequest(held.request_id!).find((row) => row.card_room === "#approvals")?.step).toBe("fallback");
    expect(h.core.inboxItems("alex")[0]?.shared_in).toBe("#approvals");
    expect(h.core.inboxItems("dev")).toEqual([]);

    await keeperOf(h).sync();
    const post = inboxPosts("dm-alex")[0]!;
    expect(post).toContain("card in #approvals");
    expect(post).not.toContain(`${h.chat.cardIn("#approvals").handle} CLR`);
    expect(post).toContain("or where a line says");
  });

  it("gives way to the person's own card for the same request", async () => {
    start();
    const held = await h.core.check(gateRefund(REFUND_SC4, support));
    for (let minute = 0; minute < 25 && !h.core.stores.routes.forRequest(held.request_id!).some((row) => row.step === "group"); minute += 1) {
      h.clock.advance(MINUTE);
      await h.core.tick();
    }
    expect(h.core.stores.routes.forRequest(held.request_id!).some((row) => row.step === "group")).toBe(true);
    const items = h.core.inboxItems("sam");
    expect(items).toHaveLength(1);
    expect(items[0]?.shared_in).toBeNull();
  });
});

describe("a drill in the inbox looks like any other request", () => {
  const makeDrill = (id: string) => h.core.stores.db.prepare(`UPDATE requests SET is_drill = 1 WHERE id = ?`).run(id);

  it("has the same fields, the same line, and no word that gives it away", async () => {
    start();
    const keeper = keeperOf(h);
    await h.core.check(gateRefund(REFUND_SC4, support));
    const drill = await h.core.check(gateRefund(REFUND_SC3, support));
    makeDrill(drill.request_id!);
    await keeper.sync();

    const [asDrill, asReal] = h.core.inboxItems("sam");
    expect(asDrill?.request_id).toBe(drill.request_id);
    expect(Object.keys(asDrill!)).toEqual(Object.keys(asReal!));
    const lines = inboxPosts("dm-sam").at(-1)!.split("\n");
    expect(lines[0]).toBe("**Needs your response (2)**");
    expect(lines[1]).toBe(`${drill.request_id} refund ₹4,000 · #support · 0 s`);
    expect(lines[2]).toBe(`CLR-0001 refund ₹40,000 · #support · 0 s`);
    expect(JSON.stringify(h.core.inbox("sam"))).not.toMatch(/drill/i);
    expect(inboxPosts("dm-sam").join()).not.toMatch(/drill|practice/i);
  });

  it("is told the same way: a mention, and the same post", async () => {
    start();
    const keeper = keeperOf(h);
    const drill = await h.core.check(gateRefund(REFUND_SC3, support));
    makeDrill(drill.request_id!);
    await keeper.sync();
    expect(h.chat.targeted.filter((post) => post.roomId === "dm-sam").map((post) => post.targets)).toEqual([["sam"]]);
  });

  it("goes from the list the same way when it closes", async () => {
    start();
    const keeper = keeperOf(h);
    await h.core.check(gateRefund(REFUND_SC4, support));
    const drill = await h.core.check(gateRefund(REFUND_SC3, support));
    makeDrill(drill.request_id!);
    await keeper.sync();
    h.core.stores.requests.transition(drill.request_id!, "DENIED");
    await keeper.sync();
    expect(inboxPosts("dm-sam").at(-1)).toContain("(1)");
    expect(inboxPosts("dm-sam").at(-1)).not.toContain(drill.request_id!);
  });

  it("names a room even if it came from none, since a line without one would be the odd one out", async () => {
    start();
    await h.core.check(gateRefund(REFUND_SC4, finance));
    const drill = await h.core.check(gateRefund(REFUND_SC3, { session: undefined }));
    expect(h.core.inboxItems("sam").find((item) => item.request_id === drill.request_id)?.room).toBeNull();
    makeDrill(drill.request_id!);
    expect(h.core.inboxItems("sam").find((item) => item.request_id === drill.request_id)?.room).toBe("#finance");
  });

  it("leaves a real request with no room as it is", async () => {
    start();
    await h.core.check(gateRefund(REFUND_SC4, finance));
    const real = await h.core.check(gateRefund(REFUND_SC3, { session: undefined }));
    expect(h.core.inboxItems("sam").find((item) => item.request_id === real.request_id)?.room).toBeNull();
  });

  it("doesn't take its room from another drill", async () => {
    start();
    const first = await h.core.check(gateRefund(REFUND_SC4, finance));
    makeDrill(first.request_id!);
    const second = await h.core.check(gateRefund(REFUND_SC3, { session: undefined }));
    makeDrill(second.request_id!);
    expect(h.core.inboxItems("sam").find((item) => item.request_id === second.request_id)?.room).toBeNull();
  });
});

describe("how to answer", () => {
  const base: InboxItem = {
    request_id: "CLR-0001",
    handle: "A3",
    class: "refund",
    tier: "high",
    typed: false,
    what: "refund ₹40,000",
    room: "#support",
    age_s: 5,
    expires_at: new Date(NOW).toISOString(),
    card_room: "dm-sam",
    shared_in: null,
  };

  it("doesn't offer yes or no for a high-risk card that asks for a typed value after a missed drill", () => {
    const typed = { ...base, handle: "A38", typed: true };
    const text = inboxMessage([typed], { roomId: "dm-sam" });
    expect(text).not.toContain("A38 yes");
    expect(text).toContain("as its card says");
    expect(inboxMessage([typed, base], { roomId: "dm-sam" })).toContain("`A3 yes`");
  });

  it("gives a yes or no example only from a card that takes one", () => {
    expect(inboxMessage([base], { roomId: "dm-sam" })).toContain("`A3 yes` or `A3 no`");
    const critical = { ...base, handle: "A5", tier: "critical" };
    const text = inboxMessage([critical], { roomId: "dm-sam" });
    expect(text).not.toContain("A5 yes");
    expect(text).toContain("as its card says");
    expect(inboxMessage([critical, base], { roomId: "dm-sam" })).toContain("`A3 yes`");
  });

  it("points at the buttons when no code is known", () => {
    expect(inboxMessage([{ ...base, handle: null }], { roomId: "dm-sam" })).toContain("Use the buttons on the cards above.");
  });

  it("recognises only its own posts, so removing old ones can't take anything else", () => {
    expect(isInboxMessage("**Needs your response (3)**\nA1 CLR-0001 refund")).toBe(true);
    expect(isInboxMessage("@sam **Needs your response (0)**\nNothing is waiting on you.")).toBe(true);
    expect(isInboxMessage("@​sam **Needs your response (1)**")).toBe(true);
    for (const other of [
      "CLR-0001 needs your response",
      "Needs your response (1)",
      "Sam said **Needs your response (2)**",
      "**Permission needed** · request `A1`\n**Needs your response (2)**",
    ]) {
      expect(isInboxMessage(other)).toBe(false);
    }
  });
});

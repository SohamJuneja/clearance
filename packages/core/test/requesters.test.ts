/** S4 fallback: every human who addressed an agent in the last 10 minutes is a requester. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSwitchNotice } from "../src/router/switch-notices.js";
import { chatMessage, gateRefund, hookShell, makeHarness, MINUTE, PARTICIPANTS, REFUND_SC4, type Harness } from "./harness.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => h.core.close());

const requesters = (agent: string) => h.core.people.requesters.requestersOf(agent);

describe("requester tracking from the message stream", () => {
  it("records a human who mentions the agent", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent handle ticket T-77"));
    expect(requesters("refunds-agent")).toEqual(["priya"]);
  });

  it("stores agent, room, thread, sender and on-behalf-of, mapping the display name to a person", async () => {
    await h.core.onMessage(
      chatMessage(PARTICIPANTS.priya, "@refunds-agent go", { roomId: "#support", threadId: "t-1", onBehalfOf: "Sam" }),
    );
    const rows = h.core.stores.db.prepare(`SELECT agent, room, thread, user_id, on_behalf_of FROM requesters ORDER BY user_id`).all();
    expect(rows).toEqual([
      { agent: "refunds-agent", room: "#support", thread: "t-1", user_id: "priya", on_behalf_of: "sam" },
      { agent: "refunds-agent", room: "#support", thread: "t-1", user_id: "sam", on_behalf_of: null },
    ]);
  });

  it("ignores a message that mentions no agent", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "morning all"));
    expect(requesters("refunds-agent")).toEqual([]);
  });

  it("does not confuse an agent with one whose name starts the same", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent-vanilla do it"));
    expect(requesters("refunds-agent")).toEqual([]);
  });

  it("does not read an email address as a mention", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "write to someone@example.com please"));
    expect(requesters("refunds-agent")).toEqual([]);
  });

  it("does read one that ends in an agent's name, because Switch addresses that agent", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "write to someone@refunds-agent please"));
    expect(requesters("refunds-agent")).toEqual(["priya"]);
  });

  it("tolerates punctuation after a mention", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "over to you, @refunds-agent."));
    expect(requesters("refunds-agent")).toEqual(["priya"]);
  });

  it("records every agent mentioned", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent and @support-agent please sort this"));
    expect(requesters("refunds-agent")).toEqual(["priya"]);
    expect(requesters("support-agent")).toEqual(["priya"]);
  });

  it("counts everyone who addressed the agent in the last 10 minutes", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent one"));
    h.clock.advance(5 * MINUTE);
    await h.core.onMessage(chatMessage(PARTICIPANTS.alex, "@refunds-agent two", { roomId: "#eng" }));
    expect(requesters("refunds-agent").sort()).toEqual(["alex", "priya"]);
  });

  it("drops someone once they are outside the 10 minutes", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent one"));
    h.clock.advance(10 * MINUTE + 1);
    expect(requesters("refunds-agent")).toEqual([]);
  });

  it("does not shrink the window under a scaled clock: a real agent turn takes real time", async () => {
    h.core.close();
    h = makeHarness({ scale: 10 });
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent one"));
    h.clock.advance(5 * MINUTE);
    expect(requesters("refunds-agent")).toEqual(["priya"]);
  });

  it("treats two linked chat accounts as one person", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.sam, "@refunds-agent one"));
    await h.core.onMessage(chatMessage(PARTICIPANTS.samSecond, "@refunds-agent two"));
    expect(requesters("refunds-agent")).toEqual(["sam"]);
  });

  it("keeps an unlinked human as a requester by participant id", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.guest, "@refunds-agent one"));
    expect(requesters("refunds-agent")).toEqual([PARTICIPANTS.guest]);
  });

  it("takes the person a platform message speaks for, not the platform", async () => {
    await h.core.onMessage(chatMessage("@switch-bridge:localhost", "@refunds-agent one", { onBehalfOf: "Priya" }));
    expect(requesters("refunds-agent")).toEqual(["priya"]);
  });

  it("matches on_behalf_of by person name without regard to case", async () => {
    await h.core.onMessage(chatMessage("@switch-bridge:localhost", "@refunds-agent one", { onBehalfOf: "priya" }));
    expect(requesters("refunds-agent")).toEqual(["priya"]);
  });

  it("keeps an on_behalf_of name that maps to nobody as a requester: it never widens eligibility", async () => {
    await h.core.onMessage(chatMessage("@switch-bridge:localhost", "@refunds-agent one", { onBehalfOf: "Someone New" }));
    expect(requesters("refunds-agent")).toEqual(["Someone New"]);
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent two"));
    expect(requesters("refunds-agent")).toEqual(["Someone New", "priya"]);
  });

  it("never decides who is an agent from sender_kind", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent one", { senderKind: "agent" }));
    expect(requesters("refunds-agent")).toEqual(["priya"]);
    await h.core.onMessage(chatMessage(PARTICIPANTS.refundsAgent, "@support-agent two", { senderKind: null }));
    expect(requesters("support-agent")).toEqual(["priya"]);
  });

  it("ignores Clearance's own messages", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent one"));
    await h.core.onMessage(chatMessage(PARTICIPANTS.clearance, "@support-agent CLR-0001 was approved", { senderName: "clearance" }));
    expect(requesters("support-agent")).toEqual([]);
  });
});

describe("authority case 12: on_behalf_of chains through agents", () => {
  it("propagates requesters when one agent mentions another", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent sort it"));
    await h.core.onMessage(chatMessage(PARTICIPANTS.refundsAgent, "@support-agent please send the refund"));
    expect(requesters("support-agent")).toEqual(["priya"]);
  });

  it("records through which agent", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent sort it"));
    await h.core.onMessage(chatMessage(PARTICIPANTS.refundsAgent, "@support-agent please"));
    const row = h.core.stores.db.prepare(`SELECT on_behalf_of FROM requesters WHERE agent = 'support-agent'`).get();
    expect(row).toEqual({ on_behalf_of: "refunds-agent" });
  });

  it("follows a chain of three", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent sort it"));
    await h.core.onMessage(chatMessage(PARTICIPANTS.refundsAgent, "@support-agent please"));
    await h.core.onMessage(chatMessage(PARTICIPANTS.supportAgent, "@ops-agent over to you"));
    expect(requesters("ops-agent")).toEqual(["priya"]);
  });

  it("refreshes the window as the chain moves", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent sort it"));
    h.clock.advance(9 * MINUTE);
    await h.core.onMessage(chatMessage(PARTICIPANTS.refundsAgent, "@support-agent please"));
    h.clock.advance(9 * MINUTE);
    expect(requesters("support-agent")).toEqual(["priya"]);
  });

  it("does not make an agent a requester of itself or anyone else", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.refundsAgent, "@support-agent please"));
    expect(requesters("support-agent")).toEqual([]);
  });

  it("recognises an agent by Switch's sender name when identities have no entry for it", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@coder fix it"));
    await h.core.onMessage(chatMessage("@switch-agent-unlisted:localhost", "@reviewer look", { senderName: "coder" }));
    expect(requesters("reviewer")).toEqual(["priya"]);
  });
});

describe("hold time", () => {
  it("snapshots the requesters and the owner onto the request", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent handle T-77"));
    const held = await h.core.check(gateRefund());
    const request = h.core.stores.requests.require(held.request_id as string);
    expect(request.requesterIds).toEqual(["priya"]);
    expect(request.agentOwnerId).toBe("priya");
  });

  it("keeps holding when nobody is known to have asked, says so, and never allows", async () => {
    const held = await h.core.check(gateRefund());
    expect(held.decision).toBe("hold");
    const request = h.core.stores.requests.require(held.request_id as string);
    expect(request.requesterIds).toEqual([]);
    expect(request.flags.map((flag) => flag.code)).toContain("requester_unknown");
  });

  it("keeps holding when a tracked requester aged out", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent handle T-77"));
    h.clock.advance(11 * MINUTE);
    const held = await h.core.check(gateRefund());
    expect(held.decision).toBe("hold");
    expect(h.core.stores.requests.require(held.request_id as string).requesterIds).toEqual([]);
  });

  it("takes the origin room from the session when there is one", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent go", { roomId: "#elsewhere", threadId: "x" }));
    const held = await h.core.check(gateRefund());
    const request = h.core.stores.requests.require(held.request_id as string);
    expect(request.originRoom).toBe("#support");
    expect(request.originThread).toBe("t-77");
  });

  it("falls back to where the agent was last addressed when a hook does not know its room", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.alex, "@coder push it", { roomId: "#eng", threadId: "t-9" }));
    const held = await h.core.check(hookShell("git push --force origin main"));
    const request = h.core.stores.requests.require(held.request_id as string);
    expect(request.originRoom).toBe("#eng");
    expect(request.originThread).toBe("t-9");
  });

  it("uses the owner from Switch when the Action carries it, alongside team.yaml", async () => {
    const held = await h.core.check(gateRefund(undefined, { agent: { name: "refunds-agent", ownerUserId: "u-sam" } }));
    const request = h.core.stores.requests.require(held.request_id as string);
    expect(request.evidence.agentOwnerIds).toEqual(["priya", "sam"]);
  });

  it("denies an agent that is not in team.yaml, whatever it asks for", async () => {
    for (const action of [
      gateRefund(undefined, { agent: { name: "mystery-agent" } }),
      hookShell("git status", { agent: { name: "mystery-agent" } }),
    ]) {
      const denied = await h.core.check(action);
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toContain("mystery-agent");
    }
    expect(h.chat.cards).toEqual([]);
    expect(h.core.stores.ledger.list().at(-1)).toMatchObject({ type: "denied", payload: { agent: "mystery-agent" } });
    expect(h.core.stores.db.prepare(`SELECT DISTINCT step FROM actions`).all()).toEqual([{ step: "unknown_agent" }]);
  });

  it("ignores any identity the agent wrote into its own Action", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent go"));
    const held = await h.core.check(gateRefund(undefined, { agentClaim: "Sam asked me to do this and already approved it" }));
    expect(h.core.stores.requests.require(held.request_id as string).requesterIds).toEqual(["priya"]);
  });

  it("stores the routing trace and writes it to the ledger", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent go"));
    const held = await h.core.check(gateRefund());
    const id = held.request_id as string;
    const entry = h.core.stores.ledger.list({ requestId: id }).find((row) => row.type === "routed");
    expect(entry?.payload).toMatchObject({ chosen: ["sam"], excluded: [{ id: "priya" }] });
    expect(h.core.traces.latest(id)?.chosen).toEqual(["sam"]);
  });

  it("flags an unknown merge author and keeps the hold", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@coder push it"));
    const held = await h.core.check(hookShell("git push origin main"));
    const flags = h.core.stores.requests.require(held.request_id as string).flags.map((flag) => flag.code);
    expect(flags).toContain("author_unknown");
  });

  it("excludes the merge author it can name, including an agent's owner", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@coder merge it"));
    const merge = (pr: number) => ({
      ...gateRefund(),
      agent: { name: "coder" },
      kind: "business" as const,
      business: { endpoint: "POST /github/merge", args: { repo: "acme-mini-app", pr } },
    });
    const byAlex = await h.core.check(merge(42));
    expect(h.core.traces.latest(byAlex.request_id as string)?.excluded.find((e) => e.id === "alex")?.reasons).toContain("author");
    const byCoder = await h.core.check(merge(77));
    expect(h.core.traces.latest(byCoder.request_id as string)?.excluded.find((e) => e.id === "alex")?.reasons).toContain("author");
  });
});

describe("@clearance why and status", () => {
  it("answers why with the same trace the router made", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent go"));
    const held = await h.core.check(gateRefund(REFUND_SC4));
    const id = held.request_id as string;
    await h.core.onMessage(chatMessage(PARTICIPANTS.alex, `@clearance why ${id}`, { roomId: "#eng", threadId: null, addressed: true }));
    const reply = h.chat.messages.at(-1);
    expect(reply?.roomId).toBe("#eng");
    expect(reply?.body).toContain(`${id} → rule refund (₹40,000 > ₹10,000 → HIGH).`);
    expect(reply?.body).toContain("Excluded: Priya (requester; agent owner).");
    expect(reply?.body).toContain("Ranked: Sam (finance rota on duty");
  });

  it("gives the requester the plain-language line first", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent go"));
    const held = await h.core.check(gateRefund(REFUND_SC4));
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, `@clearance why ${held.request_id}`, { addressed: true }));
    expect(h.chat.messages.at(-1)?.body).toMatch(/^Held because refunds over ₹10,000 need finance approval\. Sam \(finance, on duty\) has it\. You can't approve your own request\./);
  });

  it("takes a handle too, when Switch gave one", async () => {
    h.chat.giveHandles = true;
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent go"));
    await h.core.check(gateRefund());
    await h.core.onMessage(chatMessage(PARTICIPANTS.alex, "@clearance why A1", { addressed: true }));
    expect(h.chat.messages.at(-1)?.body).toContain("A1 → rule refund");
  });

  it("answers status from the CLR id", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent go"));
    const held = await h.core.check(gateRefund());
    await h.core.onMessage(chatMessage(PARTICIPANTS.alex, `@clearance status ${held.request_id}`, { addressed: true }));
    expect(h.chat.messages.at(-1)?.body).toBe(`${held.request_id}: ROUTED. Sam (finance, on duty) has it. Expires 14:25 IST.`);
  });

  it("says so when asked about a request that does not exist", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.alex, "@clearance why CLR-9999", { addressed: true }));
    expect(h.chat.messages.at(-1)?.body).toContain("CLR-9999");
    expect(h.chat.messages.at(-1)?.body).toMatch(/can't find|no request/i);
  });

  it("does not treat a mere mention of clearance as a command", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.alex, "we should ask @clearance why this is slow"));
    expect(h.chat.messages).toEqual([]);
  });
});

describe("what the agent said, and what Switch said in its name", () => {
  const said = (thread = "t-77") => h.core.people.requesters.lastMessages("refunds-agent", "#support", thread, 2);
  const agentSays = (body: string, thread = "t-77") =>
    h.core.onMessage(chatMessage(PARTICIPANTS.refundsAgent, body, { threadId: thread }));

  it("doesn't take Switch's refusal for the agent's words", async () => {
    await agentSays("@clearance You're not permitted to direct messages to me in this room — my operator has restricted who can address me here.");
    expect(said()).toEqual([]);
  });

  it("finds what the agent really said behind a notice", async () => {
    await agentSays("Refunding ₹4,000 for order A-1931.");
    await agentSays("@priya I read room messages asynchronously, not in real time — you have to trigger me to pull the latest messages, either from a session I already have open or by starting a new one.");
    expect(said()).toEqual(["Refunding ₹4,000 for order A-1931."]);
  });

  it("looks in the room when the thread holds only a notice", async () => {
    await agentSays("Looking at the order.", "t-1");
    await agentSays("Hey! I'm on standby — @refunds-agent to get started.", "t-2");
    expect(said("t-2")).toEqual(["Looking at the order."]);
  });

  it("still gives two when a run of notices came between", async () => {
    await agentSays("First.");
    await agentSays("Second.");
    for (let n = 0; n < 5; n++) await agentSays("Hi! I'm refunds-agent — how can I help?");
    expect(said()).toEqual(["Second.", "First."]);
  });

  it("still counts a room the agent only had a notice in, so who asked there stays on record", async () => {
    await agentSays("@priya Hi! I'm refunds-agent — how can I help?");
    const rows = h.core.stores.db.prepare(`SELECT room FROM agent_messages WHERE agent = 'refunds-agent'`).all();
    expect(rows).toHaveLength(1);
  });
});

describe("isSwitchNotice", () => {
  /** Word for word from Switch at the pinned commit. */
  const SWITCH_SAYS = [
    "Starting a session to handle this — one moment.",
    "🎭 assumed the `merges` role.",
    "🎭 released the `customer-email` role.",
    "You're not permitted to direct messages to me in this room — my operator has restricted who can address me here.",
    "@clearance You're not permitted to direct messages to me in this room — my operator has restricted who can address me here.",
    "I only take instructions from my owner, and this chat account isn't linked to a Switch user yet — so I can't tell whether that's you. If it is, link this account to your Switch user in Switch Console, post the code it shows you from this account, and try again.",
    "I read room messages asynchronously, not in real time — you have to trigger me to pull the latest messages, either from a session I already have open or by starting a new one.",
    "@sam I read room messages asynchronously, not in real time — @priya has to trigger me to pull the latest messages, either from a session I already have open or by starting a new one.",
    "I read room messages asynchronously, not in real time — my owner has to trigger me to pull the latest messages, either from a session I already have open or by starting a new one.",
    "@priya — I'm not online in this room, and @sam needs me. Open Switch Console to bring me online here.",
    "I'm not online in this room. **My owner needs to open Switch Console** to bring me online here.",
    "I have a session connected to this room, but it isn't reporting as live, so I'm not receiving messages. You can restart it by opening **refunds-agent** in Switch Console. If Switch Console says I'm signed out, sign me in first with `claude login` on the machine I run on.",
    "I don't have a session connected to this room. You can start one connected to **support** by opening **refunds-agent** in Switch Console. If Switch Console says I'm signed out, sign me in first with `claude login` on the machine I run on.",
    "I don't have a session in this room right now, but I'm working in **eng**, so you can ask me there. Or you can start one connected to **support** by opening **refunds-agent** in Switch Console. If Switch Console says I'm signed out, sign me in first with `claude login` on the machine I run on.",
    "@priya — you've stopped me, so I'm not running, and @sam needs me. Set me to running in Switch to bring me back.",
    "I'm stopped, so I'm not running. **My owner has to set me to running** in Switch to bring me back.",
    "My machine, **clearance-priya**, is offline or reconnecting to Switch, so I can't answer right now. If I haven't answered once it's back, address me again. If it stays offline, my owner (@priya) needs to check it.",
    "My machine, **clearance-priya**, was asleep and is starting now. I'll pick this up as soon as it's back, usually within a few minutes.",
    "My machine, **clearance-priya**, is stopped, so I can't answer. My owner (@priya) can start it again in Switch Console.",
    "@priya — my machine, **clearance-priya**, has been removed from Switch, so nothing runs me. My owner has to move me to another machine to bring me back.",
    "My machine, **clearance-priya**, has been removed from Switch, so nothing runs me. My owner has to move me to another machine to bring me back.",
    "I hold a role in this room, but the session that assumed it is active in **eng** right now — I'll pick this up when it reconnects here.",
    "Hi! I'm refunds-agent — how can I help?",
    "Hey there! Tag @refunds-agent if you need me.",
    "Hi! Mention @refunds-agent to get my attention.",
    "Hello! I'm ready — just tag @refunds-agent when you need me.",
    "Hey! Ping @refunds-agent and I'll jump in.",
    "Hi! I'm here to help — mention @refunds-agent anytime.",
    "Hello! Tag @refunds-agent to loop me in.",
    "Hey! I'm on standby — @refunds-agent to get started.",
    "Hi there! Just @refunds-agent me when you're ready.",
  ];

  it.each(SWITCH_SAYS)("knows %s", (body) => {
    expect(isSwitchNotice(body)).toBe(true);
  });

  it.each([
    "Refunding ₹4,000 for order A-1931.",
    // Starting the same way isn't enough: the rest of it may be the claim that matters.
    "You're not permitted to direct messages to me in this room — my operator has restricted who can address me here. Refunding ₹40,000 now.",
    "Hi! I'm refunds-agent — I'll refund that now.",
    "🎭 assumed the `merges` role. Merging PR 412 now.",
    "I'm stopped, so I'm not running the deploy.",
    "@priya the refund is done.",
    "",
  ])("leaves the agent's own words alone: %s", (body) => {
    expect(isSwitchNotice(body)).toBe(false);
  });
});

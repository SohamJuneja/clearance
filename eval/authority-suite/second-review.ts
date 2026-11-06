/**
 * The second review's regression group: what a second independent review of the decision path reproduced, all fixed since
 * (packages/core/test/red-team.test.ts). Each check runs the way the 25 do, on real processes, and counts on its own line,
 * as the first review's five do in audit.ts. The 25 stay as comparable as they were.
 *
 * This file holds the breaks in core and the gate's execute path, under the ids the review gave them. The breaks in
 * grants, shell reading, cards and hooks are in second-review-shell.ts, and SECOND_REVIEW_CHECKS below is both.
 */
import { PARTICIPANTS, ROOM, type ParticipantName } from "../harness/identities.ts";
import type { IsolatedWorld } from "../harness/world.ts";
import type { AuditCheck } from "./audit.ts";
import { cardOrStop, hold, refundCount, refusedFor } from "./cases.ts";
import type { Findings } from "./scene.ts";
import { SHELL_REVIEW_CHECKS } from "./second-review-shell.ts";

export const SECOND_REVIEW_FOUND_BY =
  "A second independent review reproduced these breaks, on code that passed all 25 cases and the first review's five. All were fixed, and they are re-checked here, apart from the 25.";

const MINUTE = 60_000;
const LARGE = { order_id: "A-2004", amount: 40000 } as const;
/** Small enough for the autonomy bucket, and everything about it belongs to the customer it's for. */
const SMALL = { order_id: "A-1931", amount: 2000 } as const;
const OLD_UPI = "meera.k@oksbi";
const ASK = "@refunds-agent refund order A-2004 in full";

const priyaAsks = (world: IsolatedWorld): Promise<void> => world.say("priya", "priya", ASK);

/** A message whose sending and arrival differ, or that came from someone with no linked account. */
async function deliver(
  world: IsolatedWorld,
  sender: string,
  body: string,
  roomId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const res = await world.corePost("/eval/message", {
    roomId,
    threadId: "thread-1",
    messageId: `sw_second_${Math.random()}`,
    sender,
    senderName: sender,
    onBehalfOf: null,
    addressed: false,
    body,
    timestampMs: Date.now(),
    ...extra,
  });
  if (res.status !== 200) throw new Error(`core refused a message: ${res.status}`);
}

const said = (world: IsolatedWorld): string =>
  world
    .chat()
    .map((row) => String((row as { body?: unknown }).body ?? ""))
    .join("\n");

const flagsOf = async (world: IsolatedWorld, id: string): Promise<string[]> => {
  const { flags } = (await world.request(id)) as { flags?: { code: string }[] };
  return (flags ?? []).map((flag) => flag.code);
};

/** Someone answering the room's copy, which anyone in the room can reach. */
async function answerRoomCopy(
  world: IsolatedWorld,
  findings: Findings,
  id: string,
  who: ParticipantName,
): Promise<void> {
  await world.answer(cardOrStop(world, findings, id, ROOM.support), who, "allow");
}

export const CORE_CHECKS: AuditCheck[] = [
  {
    id: "B5",
    title: "Saying a call did not run without knowing",
    badOutcome: "The agent is told it did not run when it may have",
    async run(world, findings) {
      await priyaAsks(world);
      const id = await hold(world, findings);
      // Acme takes the call and goes quiet, so the gate can't know. Waits out the gate's own timeout for Acme.
      world.pauseService("acme");
      await world.answer(cardOrStop(world, findings, id, "dm-sam"), "sam", "allow");
      const state = await world.waitState(id, ["OUTCOME_UNKNOWN", "VOIDED", "EXECUTED"], 40_000);
      world.resumeService("acme");
      findings.bad("the agent or the room was told it did not run", said(world).includes("did not run"));
      findings.control(`it ends with nobody able to say (state ${state})`, state === "OUTCOME_UNKNOWN");
      findings.control("they're told not to retry it", said(world).includes("Do not retry it"));
      const ledger = await world.ledger(id);
      findings.control("the ledger says so", ledger.some((row) => row.type === "outcome_unknown"));
      await priyaAsks(world);
      const again = await hold(world, findings);
      findings.control("the same call asked for again is a new request", again !== id);
      findings.bad("its card doesn't warn that the first may have run", !(await flagsOf(world, again)).includes("may_have_run"));
    },
  },
  {
    id: "B6",
    title: "The same call allowed again with nothing to say it already ran",
    badOutcome: "An identical refund runs twice, on its own",
    async run(world, findings) {
      await world.setAutonomy("refunds-agent", "refund", "small", "L3");
      await priyaAsks(world);
      const body = { ...SMALL, destination: OLD_UPI };
      const first = await world.gate("refunds-agent", "POST", "/acme/refunds", body);
      findings.control(`the first runs on its own (gate answered ${first.status})`, first.status < 300);
      const second = await world.gate("refunds-agent", "POST", "/acme/refunds", body);
      findings.bad("the identical second call ran too", (await refundCount(world)) > 1);
      findings.control(`the second is held (gate answered ${second.status})`, second.status === 202);
      const id = String(second.json.request_id);
      findings.control("its card says it ran", (await flagsOf(world, id)).includes("ran_recently"));
    },
  },
  {
    id: "B7",
    title: "A message sent before the hold and delivered after it doesn't bar its sender",
    badOutcome: "Sam, who asked, approves alone",
    async run(world, findings) {
      await priyaAsks(world);
      const id = await hold(world, findings);
      await deliver(world, PARTICIPANTS.sam, ASK, ROOM.finance, { timestampMs: Date.now() - MINUTE });
      await world.answer(cardOrStop(world, findings, id, "dm-sam"), "sam", "allow");
      findings.bad("the refund executed on Sam's approval", (await refundCount(world)) > 0);
      findings.control("the ledger says why", await refusedFor(world, id, "requester"));
    },
  },
  {
    id: "B8",
    title: "A requester who maps to no person still reads as known",
    badOutcome: "Sam asks from an account nobody linked, and approves alone from his own",
    async run(world, findings) {
      await world.say("guest", "guest", ASK);
      const id = await hold(world, findings);
      const request = await world.request(id);
      findings.control(`it takes two (quorum ${String(request.quorum_required)})`, request.quorum_required === 2);
      await world.answer(cardOrStop(world, findings, id, "dm-sam"), "sam", "allow");
      findings.bad("the refund executed on one approval", (await refundCount(world)) > 0);
      await world.answer(cardOrStop(world, findings, id, "dm-neha"), "neha", "allow");
      findings.control("a second person completes it", (await world.waitState(id, ["EXECUTED"])) === "EXECUTED");
      findings.control("exactly one refund went out", (await refundCount(world)) === 1);
    },
  },
  {
    id: "B9",
    title: "A requester can name who approves",
    badOutcome: "Neha asks, hands her approval to Dev, and his runs it",
    async run(world, findings) {
      await world.say("neha", "neha", ASK);
      const id = await hold(world, findings);
      await world.say("neha", "neha", "@clearance away until 18:00 delegate @dev", ROOM.support);
      await answerRoomCopy(world, findings, id, "dev");
      findings.bad("the refund executed on the approval of her delegate", (await refundCount(world)) > 0);
    },
  },
  {
    id: "B10",
    title: "Break-glass doesn't see who asked elsewhere",
    badOutcome: "Alex asks in another room and breaks glass on his own request",
    async run(world, findings) {
      await priyaAsks(world);
      await world.say("alex", "alex", ASK, ROOM.eng);
      const id = await hold(world, findings);
      await world.say("alex", "alex", `@clearance breakglass ${id} it cannot wait`);
      findings.bad("his break-glass executed the refund", (await refundCount(world)) > 0);
      findings.control(`it's still waiting (state ${await world.stateOf(id)})`, (await world.stateOf(id)) === "ROUTED");
    },
  },
  {
    id: "B11",
    title: "An ask Switch delivers and Clearance doesn't read as one",
    badOutcome: "Sam addresses the agent another way and approves alone",
    async run(world, findings) {
      await priyaAsks(world);
      await world.say("sam", "sam", "@Refunds-Agent refund order A-2004", ROOM.finance);
      const cased = await hold(world, findings);
      const { requester_ids: asked, evidence } = (await world.request(cased)) as {
        requester_ids: string[];
        evidence: { askedElsewhereIds?: string[] };
      };
      findings.bad("Sam, who asked with different capitals, isn't barred", ![...asked, ...(evidence.askedElsewhereIds ?? [])].includes("sam"));
      await world.say("neha", "neha", "@refunds refund order A-1931", ROOM.eng);
      const alias = await hold(world, findings, { ...LARGE, amount: 30000 });
      const request = await world.request(alias);
      findings.bad("someone addressing an unknown name leaves quorum at one", request.quorum_required !== 2);
      findings.control("the card says why", (await flagsOf(world, alias)).includes("possible_alias"));
    },
  },
  {
    id: "B12",
    title: "The requester window ends during a long turn",
    badOutcome: "Sam asked 11 minutes ago, the agent is still on it, and he approves alone",
    async run(world, findings) {
      await world.say("sam", "sam", ASK);
      await world.advanceClock(9 * MINUTE);
      await world.say("priya", "priya", "@refunds-agent how is the other ticket going?");
      await world.advanceClock(2 * MINUTE);
      const id = await hold(world, findings);
      findings.control("no card went to Sam", world.card(id, "dm-sam") === undefined);
      await answerRoomCopy(world, findings, id, "sam");
      findings.bad("the refund executed on Sam's approval", (await refundCount(world)) > 0);
    },
  },
  {
    id: "B13",
    title: "An answer that arrives while its card is opening is lost",
    badOutcome: "Sam's denial vanishes, and the ladder hands it to someone who approves",
    async run(world, findings) {
      await priyaAsks(world);
      await world.corePost("/eval/answer-while-opening", { roomId: "dm-sam", answeredBy: PARTICIPANTS.sam, answer: "deny" });
      const id = await hold(world, findings);
      findings.bad("the denial was lost", (await world.stateOf(id)) !== "DENIED");
      await world.advanceClock(3 * MINUTE + 1000);
      await world.corePost("/eval/tick", {});
      findings.bad("the ladder added Neha to something Sam had denied", world.card(id, "dm-neha") !== undefined);
      findings.bad("anything ran", (await refundCount(world)) > 0);
    },
  },
  {
    id: "B14",
    title: "Lost stream events raise nothing",
    badOutcome: "Events are lost for good, and the next hold still takes one person",
    async run(world, findings) {
      await priyaAsks(world);
      await world.corePost("/eval/stream-gap", {});
      const id = await hold(world, findings);
      const request = await world.request(id);
      findings.bad("it still takes one person", request.quorum_required !== 2);
      findings.control("the card says why", (await flagsOf(world, id)).includes("messages_lost"));
    },
  },
  {
    id: "B15",
    title: "A lookup outage removes the author exclusion",
    badOutcome: "With the lookup down, Alex approves his own pull request alone",
    async run(world, findings) {
      await world.say("priya", "priya", "@coder merge 42 please", ROOM.eng);
      await world.killService("acme");
      const res = await world.gate("coder", "POST", "/github/merge", { repo: "acme-mini-app", pr: 42 }, ROOM.eng);
      findings.require(`the merge is held (gate answered ${res.status})`, res.status === 202);
      const id = String(res.json.request_id);
      const request = await world.request(id);
      findings.bad("it still takes one person", request.quorum_required !== 2);
      findings.control("the card says why", (await flagsOf(world, id)).includes("author_unknown"));
    },
  },
  {
    id: "B18",
    title: "A refund to someone else's destination reads as a refund to the customer",
    badOutcome: "Meera's refund goes to Rohan's UPI, alone, at L3",
    async run(world, findings) {
      await world.setAutonomy("refunds-agent", "refund", "small", "L3");
      await priyaAsks(world);
      const own = await world.gate("refunds-agent", "POST", "/acme/refunds", { ...SMALL, destination: OLD_UPI });
      findings.control(`a refund to her own UPI still runs alone, against real records (gate answered ${own.status})`, own.status < 300);
      const before = await refundCount(world);
      const res = await world.gate("refunds-agent", "POST", "/acme/refunds", { ...SMALL, amount: 2100, destination: "rohan.d@okhdfcbank" });
      findings.bad("the refund to someone else's UPI ran", (await refundCount(world)) > before);
      findings.require(`it's held (gate answered ${res.status})`, res.status === 202);
      findings.control("the card says whose it is", (await flagsOf(world, String(res.json.request_id))).includes("destination_other_customer"));
    },
  },
  {
    id: "B19",
    title: "Anyone can tell a drill from a real card",
    badOutcome: "A question anyone can ask answers differently for a drill",
    async run(world, findings) {
      await priyaAsks(world);
      const real = await hold(world, findings);
      const sent = await world.corePost("/v1/drills/send", { person: "neha" });
      const drill = String(sent.json.requestId ?? sent.json.request_id);
      findings.require(`a drill went out (${sent.status})`, drill.startsWith("CLR-"));
      const reply = async (id: string): Promise<string> => {
        const before = world.chat().length;
        await world.say("dev", "dev", `@clearance breakglass ${id} why`);
        return world
          .chat()
          .slice(before)
          .map((row) => String((row as { body?: unknown }).body ?? ""))
          .join()
          .replace(id, "ID");
      };
      const toReal = await reply(real);
      const toDrill = await reply(drill);
      findings.control(`the real one refuses (${toReal.slice(0, 40)})`, toReal.includes("can't break glass"));
      findings.bad("break-glass answered differently for the drill", toDrill !== toReal);
      const digest = await world.coreGet("/v1/digest");
      findings.bad("the room's digest counts the open drill", String(digest.json.room_text).includes("Drills:"));
    },
  },
  {
    id: "B20",
    title: "A real call and an open drill become one request",
    badOutcome: "A real call attaches to a drill, and nothing runs or tells the agent",
    async run(world, findings) {
      const sent = await world.corePost("/v1/drills/send", { person: "sam", flaw: "new_destination" });
      const drill = String(sent.json.requestId ?? sent.json.request_id);
      findings.require(`a drill went out (${sent.status})`, drill.startsWith("CLR-"));
      const args = { order_id: "A-7741", customer_id: "cus_4410", amount: 8500, destination: "ananya.r@okicici" };
      const res = await world.corePost("/v1/check", {
        action: {
          id: "second-review-b20",
          at: new Date().toISOString(),
          source: "gate",
          vendor: "gate",
          agent: { name: "refunds-agent" },
          kind: "business",
          raw: args,
          business: { endpoint: "POST /acme/refunds", args },
        },
      });
      const drillHash = (await world.request(drill)).call_hash;
      findings.control("the two are the same call", res.json.call_hash === drillHash);
      findings.bad("the real call became the drill", res.json.request_id === drill);
    },
  },
  {
    id: "B21",
    title: "A restart while a drill's card is opening sends it to someone else",
    badOutcome: "A drill meant for Neha reaches Sam",
    async run(world, findings) {
      await world.corePost("/eval/hold-open", { roomId: "dm-neha" });
      // Not waited for: it's stuck opening the card, which is the point.
      void world.corePost("/v1/drills/send", { person: "neha", flaw: "new_destination" }).catch(() => undefined);
      await waitUntil(() => world.chat().some((row) => row.kind === "card" && row.roomId === "dm-neha"));
      await world.killService("core");
      await world.startService("core");
      await world.corePost("/eval/tick", {});
      const rooms = world
        .chat()
        .filter((row) => row.kind === "card")
        .map((row) => row.roomId);
      findings.bad("the drill reached someone else", rooms.some((room) => room !== "dm-neha"));
    },
  },
  {
    id: "B22",
    title: "An approval the gate isn't ready for voids the call",
    badOutcome: "A call approved in the moment before the gate stores it never runs",
    async run(world, findings) {
      await priyaAsks(world);
      // The room's copy is still opening, so core hasn't answered the gate, and the gate hasn't stored the call.
      await world.corePost("/eval/hold-open", { roomId: ROOM.support });
      const pending = world.gate("refunds-agent", "POST", "/acme/refunds", LARGE);
      await waitUntil(() => world.chat().some((row) => row.kind === "card" && row.roomId === "dm-sam"));
      const card = world.chat().find((row) => row.kind === "card" && row.roomId === "dm-sam");
      const id = /CLR-\d+/.exec(String(card?.title))?.[0] as string;
      await world.answer(card as NonNullable<typeof card>, "sam", "allow");
      findings.bad("the approval voided the call", (await world.stateOf(id)) === "VOIDED");
      await world.corePost("/eval/release-open", { roomId: ROOM.support });
      await pending;
      findings.bad("it never ran", (await world.waitState(id, ["EXECUTED"], 15_000)) !== "EXECUTED");
      findings.control("exactly one refund went out", (await refundCount(world)) === 1);
    },
  },
  {
    id: "B23",
    title: "People can be pushed out of a decision by filling their cards",
    badOutcome: "Twelve open refunds move the thirteenth to someone who isn't finance",
    async run(world, findings) {
      await priyaAsks(world);
      for (let index = 0; index < 12; index += 1) {
        await hold(world, findings, { ...LARGE, amount: 11000 + index });
      }
      const id = await hold(world, findings, { ...LARGE, amount: 39000 });
      const rooms = world.cards(id).map((row) => row.roomId);
      findings.bad(
        "the card went to someone outside finance",
        rooms.some((room) => !["dm-sam", "dm-neha", ROOM.support].includes(room ?? "")),
      );
      findings.control("someone in finance holds it", rooms.includes("dm-sam") || rooms.includes("dm-neha"));
      await answerRoomCopy(world, findings, id, "alex");
      findings.bad("Alex, in engineering, approved it", (await refundCount(world)) > 0);
    },
  },
  {
    id: "B24",
    title: "A signature on a proposal past its expiry still applies",
    badOutcome: "An expired policy change takes effect",
    async run(world, findings) {
      const policy = String((await world.coreGet("/v1/policy")).json.text ?? "");
      findings.require("core gives its policy text", policy.includes("request_ttl: 25m"));
      const proposed = await world.corePost("/v1/policy/propose", { policy: policy.replace("request_ttl: 25m", "request_ttl: 24h") });
      const id = String(proposed.json.request_id);
      findings.require(`the change is proposed (${proposed.status})`, id !== "undefined");
      const before = (await world.coreGet("/v1/policy")).json.hash;
      await world.advanceClock(3 * 24 * 60 * MINUTE + MINUTE);
      for (const [room, who] of [["dm-sam", "sam"], ["dm-alex", "alex"]] as const) {
        const card = world.card(id, room);
        if (card) await world.answer(card, who, "allow");
      }
      findings.bad("the expired change was applied", (await world.coreGet("/v1/policy")).json.hash !== before);
    },
  },
  {
    id: "B25",
    title: "The tick against a path that is mid-await",
    badOutcome: "A backup card that finishes opening after the decision stays open",
    async run(world, findings) {
      await priyaAsks(world);
      const id = await hold(world, findings);
      await world.corePost("/eval/hold-open", { roomId: "dm-neha" });
      await world.advanceClock(3 * MINUTE + 1000);
      await waitUntil(() => world.chat().some((row) => row.kind === "card" && row.roomId === "dm-neha"));
      await world.answer(cardOrStop(world, findings, id, "dm-sam"), "sam", "allow");
      findings.control("the decision was made", (await world.waitState(id, ["EXECUTED"])) === "EXECUTED");
      await world.corePost("/eval/release-open", { roomId: "dm-neha" });
      await waitUntil(() => world.card(id, "dm-neha") === undefined, 3_000).catch(() => undefined);
      findings.bad("the backup card stayed open", world.card(id, "dm-neha") !== undefined);
    },
  },
  {
    id: "B27",
    title: "Earned autonomy runs what the card would have flagged",
    badOutcome: "At L3, a refund to a UPI ID added minutes ago runs with nobody looking",
    async run(world, findings) {
      await world.setAutonomy("refunds-agent", "refund", "small", "L3");
      await priyaAsks(world);
      const res = await world.gate("refunds-agent", "POST", "/acme/refunds", { ...SMALL, destination: "meera.k@okaxis" });
      findings.bad("the refund to the new UPI ID ran", (await refundCount(world)) > 0);
      findings.require(`it's held (gate answered ${res.status})`, res.status === 202);
      findings.control("the card says why", (await flagsOf(world, String(res.json.request_id))).includes("new_destination"));
    },
  },
];

async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the scene to reach its point");
    await new Promise((done) => setTimeout(done, 50));
  }
}

export const SECOND_REVIEW_CHECKS: AuditCheck[] = [...CORE_CHECKS, ...SHELL_REVIEW_CHECKS];

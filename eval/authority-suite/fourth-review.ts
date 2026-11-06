/**
 * The fourth review's regression group: what a fourth independent review reproduced, in core, the gate and the shell reader,
 * all fixed since (packages/core/test/fourth-review.test.ts and fourth-review-fixes.test.ts). Each check runs on real
 * processes, as the 25 do, and counts on its own line, as the earlier reviews' do. The 25 stay as comparable as they were.
 *
 * The review called these F1 to F11, S1 and S2. The first audit group already has an F1 to F5, so here they're R1 to R11, and
 * S1 and S2 keep their names. The breaks in shell reading and adapters are in fourth-review-shell.ts, and
 * FOURTH_REVIEW_CHECKS below is both.
 */
import { PARTICIPANTS, ROOM } from "../harness/identities.ts";
import type { IsolatedWorld } from "../harness/world.ts";
import type { AuditCheck } from "./audit.ts";
import { cardOrStop, hold, refundCount, refusedFor } from "./cases.ts";
import { SHELL_CHECKS } from "./fourth-review-shell.ts";
import type { Findings } from "./scene.ts";

export const FOURTH_REVIEW_FOUND_BY =
  "A fourth independent review reproduced these breaks, on code that passed all 25 cases and the three earlier reviews' re-checks. All were fixed, and they are re-checked here, apart from the 25.";

const MINUTE = 60_000;
const ASK = "@refunds-agent refund order A-2004 in full";
const LARGE = { order_id: "A-2004", amount: 40000 } as const;
/** Hers, from a destination on file, and small enough to run alone at L3. */
const SMALL = { order_id: "A-1931", amount: 2000, destination: "meera.k@oksbi" } as const;

const priyaAsks = (world: IsolatedWorld): Promise<void> => world.say("priya", "priya", ASK);
const atL3 = (world: IsolatedWorld): Promise<void> => world.setAutonomy("refunds-agent", "refund", "small", "L3");
const refund = (world: IsolatedWorld, args: Record<string, unknown>) => world.gate("refunds-agent", "POST", "/acme/refunds", args);

/** Calls at once, with what their checks wait for arriving at the same moment, so the checks really do overlap. */
async function allAtOnce(world: IsolatedWorld, calls: Record<string, unknown>[]) {
  await world.corePost("/eval/lookups-together", { kind: "destinations", count: calls.length });
  return Promise.all(calls.map((args) => refund(world, args)));
}

const flagsOf = async (world: IsolatedWorld, id: string): Promise<string[]> => {
  const { flags } = (await world.request(id)) as { flags?: { code: string }[] };
  return (flags ?? []).map((flag) => flag.code);
};

const detailOf = (card: { detail?: unknown; questions?: { prompt?: unknown }[] }): string => String(card.detail || card.questions?.[0]?.prompt || "");

/** His own card if he has one, which on the unfixed code he does. Barred, he has none, and presses the room's copy. */
const whereSamCanPress = (world: IsolatedWorld, findings: Findings, id: string) => world.card(id, "dm-sam") ?? cardOrStop(world, findings, id, ROOM.support);

async function samApprovesAlone(world: IsolatedWorld, findings: Findings, id: string): Promise<void> {
  await world.answer(whereSamCanPress(world, findings, id), "sam", "allow");
  findings.bad("Sam asked, and his approval alone ran it", (await refundCount(world)) > 0);
  findings.control("the ledger says he asked", await refusedFor(world, id, "requester"));
}

/** The next call at L3, when something about who asked should hold it. */
async function heldWithFlag(world: IsolatedWorld, findings: Findings, code: string): Promise<void> {
  const res = await refund(world, SMALL);
  findings.bad("it ran with nobody looking", (await refundCount(world)) > 0);
  findings.require(`it's held (gate answered ${res.status})`, res.status === 202);
  findings.control(`the card says why (${code})`, (await flagsOf(world, String(res.json.request_id))).includes(code));
}

export const CORE_CHECKS: AuditCheck[] = [
  {
    id: "R1a",
    title: "Two identical refunds at once both run alone",
    badOutcome: "Nobody looks, and the same money moves twice",
    async run(world, findings) {
      await atL3(world);
      await priyaAsks(world);
      const answers = await allAtOnce(world, [SMALL, SMALL, SMALL]);
      findings.bad("the identical refund ran more than once", (await refundCount(world)) > 1);
      findings.control("one of them ran", (await refundCount(world)) === 1);
      findings.control("the others are held", answers.filter((answer) => answer.status === 202).length === 2);
    },
  },
  {
    id: "R1b",
    title: "Refunds at once slip under the ₹10,000 structuring limit",
    badOutcome: "₹11,900 goes to one customer with nobody looking, because each call only saw what had run before it started",
    async run(world, findings) {
      await atL3(world);
      await priyaAsks(world);
      await allAtOnce(world, [
        { order_id: "A-1931", amount: 4000, destination: "meera.k@oksbi" },
        { order_id: "A-1941", amount: 4000, destination: "meera.k@oksbi" },
        { order_id: "A-1931", amount: 3900, destination: "meera.k@oksbi" },
      ]);
      const total = (await world.acmeState()).refunds.reduce((sum, row) => sum + row.amount, 0);
      findings.note(`₹${total} ran alone`);
      findings.bad("more than ₹10,000 went to one customer without a card", total > 10000);
      findings.control("the first ones did run", total > 0);
    },
  },
  {
    id: "R1c",
    title: "Calls at once overspend L3's daily budget",
    badOutcome: "The cap is ₹25,000, ₹22,500 is spent, and ₹4,500 more goes out together",
    async run(world, findings) {
      await atL3(world);
      await priyaAsks(world);
      const order = (index: number) => ({ order_id: `A-${3001 + index}`, amount: 1500 });
      for (let index = 0; index < 15; index += 1) {
        const res = await refund(world, order(index));
        findings.require(`refund ${index} runs alone (gate answered ${res.status})`, res.status < 300);
      }
      await allAtOnce(world, [order(15), order(16), order(17)]);
      const total = (await world.acmeState()).refunds.reduce((sum, row) => sum + row.amount, 0);
      findings.note(`₹${total} ran alone`);
      findings.bad("more than the daily budget ran alone", total > 25000);
      findings.control("the budget was used as far as it goes", total === 24000);
    },
  },
  {
    id: "R2",
    title: "A handle means whichever card of that name is newest, in any room",
    badOutcome: "Alex breaks glass on A1 in one room, and a refund from another room nobody looked at goes out",
    async run(world, findings) {
      await world.corePost("/eval/handles-per-room", {});
      await priyaAsks(world);
      const here = await hold(world, findings);
      await world.say("priya", "priya", "@refunds-agent refund order A-1941 in full", ROOM.finance);
      const there = await hold(world, findings, { order_id: "A-2004", amount: 30000 }, "refunds-agent", ROOM.finance);
      findings.require("each room has an A1", world.card(here, ROOM.support)?.handle === "A1" && world.card(there, ROOM.finance)?.handle === "A1");

      await world.say("dev", "dev", "@clearance incident A1 this one looks wrong", ROOM.support);
      const reported = async (id: string) => (await world.ledger(id)).some((row) => row.type === "incident");
      findings.bad("the incident landed on the other room's request", await reported(there));
      findings.control("it landed on this room's", await reported(here));

      await world.say("alex", "alex", "@clearance breakglass A1 it cannot wait", ROOM.support);
      const amounts = (await world.acmeState()).refunds.map((row) => row.amount);
      findings.bad("the refund from the other room ran", amounts.includes(30000));
      findings.control("the one in this room ran", amounts.includes(40000));
      await world.say("alex", "alex", "@clearance breakglass A1 and this", ROOM.eng);
      findings.bad("a room with no A1 ran one from another room", (await world.acmeState()).refunds.length > 1);
    },
  },
  {
    id: "R3",
    title: "Naming @clearance hides who asked",
    badOutcome: "Sam says \"refund A-2004, @clearance keep an eye on it\" and approves alone",
    async run(world, findings) {
      await world.say("refundsAgent", "refunds-agent", "Morning all.", ROOM.finance);
      await priyaAsks(world);
      await world.say("sam", "sam", "refund order A-2004 in full, @clearance keep an eye on it", ROOM.finance);
      await samApprovesAlone(world, findings, await hold(world, findings));
    },
  },
  {
    id: "R4a",
    title: "An unlinked account's ask runs alone at L3",
    badOutcome: "Someone who could be an approver asks, and it runs with nobody looking",
    async run(world, findings) {
      await atL3(world);
      await world.say("guest", "guest", "@refunds-agent refund order A-1931");
      await heldWithFlag(world, findings, "requester_unlinked");
    },
  },
  {
    id: "R4b",
    title: "A call runs alone after messages were lost",
    badOutcome: "Nobody can say who asked, and it runs with nobody looking",
    async run(world, findings) {
      await atL3(world);
      await priyaAsks(world);
      await world.corePost("/eval/stream-gap", {});
      await heldWithFlag(world, findings, "messages_lost");
    },
  },
  {
    id: "R4c",
    title: "A call runs alone with nobody on record",
    badOutcome: "Nobody asked for it that anyone can see, and it runs with nobody looking",
    async run(world, findings) {
      await atL3(world);
      await heldWithFlag(world, findings, "requester_unknown");
      await priyaAsks(world);
      const asked = await refund(world, { ...SMALL, amount: 2100 });
      findings.control(`someone on the team asking still runs alone (gate answered ${asked.status})`, asked.status < 300);
    },
  },
  {
    id: "R5",
    title: "The author breaks glass on their own pull request",
    badOutcome: "Alex merges his own pull request alone, by calling it an emergency",
    async run(world, findings) {
      await world.say("priya", "priya", "@coder merge 418 please", ROOM.eng);
      const res = await world.gate("coder", "POST", "/github/merge", { repo: "acme/acme-mini-app", pr: 418 }, ROOM.eng);
      findings.require(`the merge is held (gate answered ${res.status})`, res.status === 202);
      const id = String(res.json.request_id);
      await world.answer(cardOrStop(world, findings, id, ROOM.eng), "alex", "allow");
      findings.control("as an approver he's refused for being the author", await refusedFor(world, id, "author"));
      await world.say("alex", "alex", `@clearance breakglass ${id} ship it`, ROOM.eng);
      findings.bad("Alex merged his own pull request", (await world.acmeState()).merges.length > 0);
      findings.control("the request is still waiting", (await world.stateOf(id)) === "ROUTED");
    },
  },
  {
    id: "R6",
    title: "A chain through agents launders who asked, past the 10 minutes",
    badOutcome: "Sam asks one agent, it forwards to another 11 minutes later, and Sam approves alone",
    async run(world, findings) {
      await world.say("sam", "sam", "@support-agent please get order A-2004 refunded");
      await world.advanceClock(11 * MINUTE);
      await priyaAsks(world);
      await world.say("supportAgent", "support-agent", "@refunds-agent refund order A-2004 for Rohan");
      await samApprovesAlone(world, findings, await hold(world, findings));
    },
  },
  {
    id: "R8",
    title: "A long destination loses its end on the card",
    badOutcome: "Sam approves a refund to mmmm…, and the part after the @ is what decides who gets paid",
    async run(world, findings) {
      await priyaAsks(world);
      const id = await hold(world, findings, { ...LARGE, destination: `${"m".repeat(240)}@evilbank` });
      findings.bad("the card doesn't show the end of the destination", !detailOf(cardOrStop(world, findings, id, "dm-sam")).includes("@evilbank"));
    },
  },
  {
    id: "R9",
    title: "Naming a quiet thread takes the agent's words out of the evidence",
    badOutcome: "The agent says ₹4,000 in another thread, calls ₹40,000, and no mismatch is flagged",
    async run(world, findings) {
      await priyaAsks(world);
      await world.say("refundsAgent", "refunds-agent", "Looking at it now.");
      const res = await world.corePost("/eval/message", {
        roomId: ROOM.support,
        threadId: "another-thread",
        messageId: `sw_fourth_${Date.now()}`,
        sender: PARTICIPANTS.refundsAgent,
        senderName: "refunds-agent",
        onBehalfOf: null,
        addressed: false,
        body: "Refunding ₹4,000 for order A-2004.",
        timestampMs: Date.now(),
      });
      findings.require("core took the message", res.status === 200);
      const id = await hold(world, findings);
      findings.bad("the mismatch isn't flagged", !(await flagsOf(world, id)).includes("mismatch"));
    },
  },
  {
    id: "R10",
    title: "A request nobody can approve doesn't say so",
    badOutcome: "It waits out its 25 minutes in a room where nobody can answer, and no card says so",
    async run(world, findings) {
      await world.say("dev", "dev", "@coder update the workflow", ROOM.eng);
      const held = await world.claudeHook("coder", "Write", { file_path: ".github/workflows/deploy.yml", content: "name: x" });
      const id = held.reason.match(/CLR-\d+/)?.[0];
      findings.require(`the write is held (${held.reason.slice(0, 60)})`, !held.allow && id !== undefined);
      const cards = world.cards(id as string);
      findings.bad("no card says it can't complete", !cards.some((card) => detailOf(card).includes("can't complete")));
      findings.bad("a card offers break-glass to someone it would refuse", cards.some((card) => detailOf(card).includes("have Alex run")));
    },
  },
  {
    id: "R11",
    title: "Anyone can switch drills off with a junk incident",
    badOutcome: "Someone who isn't an admin stops drills for a day, on something that never ran, as often as they like",
    async run(world, findings) {
      await priyaAsks(world);
      const id = await hold(world, findings);
      await world.answer(cardOrStop(world, findings, id, "dm-sam"), "sam", "deny");
      findings.require("it never ran", (await world.stateOf(id)) === "DENIED");
      await world.say("dev", "dev", `@clearance incident ${id} no reason at all`, ROOM.eng);
      const sent = await world.corePost("/v1/drills/send", { person: "neha" });
      findings.bad("drills stopped", sent.status !== 200);

      // A real incident on something that really ran still stops them.
      await atL3(world);
      await priyaAsks(world);
      const ran = await refund(world, SMALL);
      findings.require(`a refund ran alone (gate answered ${ran.status})`, ran.status < 300);
      const { requests } = (await world.coreGet("/v1/requests")).json as { requests: { id: string; state: string }[] };
      const ranId = requests.find((row) => row.state === "AUTO")?.id;
      findings.require("it's on record", ranId !== undefined);
      await world.say("sam", "sam", `@clearance incident ${ranId as string} customer disputes this`, ROOM.finance);
      const after = await world.corePost("/v1/drills/send", { person: "sam" });
      findings.control(`an incident on what ran stops them (${after.status})`, after.status === 409);
    },
  },
  {
    id: "S2",
    title: "A person whose name reads clearance isn't heard",
    badOutcome: "Sam's message is taken for Clearance's own, so he never asked, and approves alone",
    async run(world, findings) {
      await world.say("priya", "priya", "@refunds-agent how is the other ticket going?");
      await world.say("sam", "clearance", ASK, ROOM.finance);
      await samApprovesAlone(world, findings, await hold(world, findings));
    },
  },
];

export const FOURTH_REVIEW_CHECKS: AuditCheck[] = [...CORE_CHECKS, ...SHELL_CHECKS];

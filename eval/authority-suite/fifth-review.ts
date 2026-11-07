/**
 * The fifth review's regression group: what a fifth independent review reproduced in room roles and the record of refusals, all
 * fixed since (packages/core/test/fifth-review.test.ts). Each check runs on real core, gate and Acme processes, as the 25 do, and
 * counts on its own line, as the earlier reviews' do. The 25 stay as comparable as they were.
 *
 * The review called these F1 to F14. The first audit group already has an F1 to F5, so here they're V1 to V14. The ones named
 * "guard" are about the fixes, not the review: they say what a fix must not have given away, so they hold on the old code too.
 *
 * Switch isn't here, so what it would say about a room's roles and aliases is set through the eval core's own routes, and the
 * bodies of its warnings and notices are its exact words at the pinned commit. Every message goes through `onStream`, which does
 * what the real dispatcher does with a handler that throws: logs it and takes the next frame. So a message core couldn't take in
 * is one it never heard, and the check goes on to see what that cost.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PARTICIPANTS, ROOM, type ParticipantName } from "../harness/identities.ts";
import type { ChatRecord, IsolatedWorld } from "../harness/world.ts";
import { REPO_ROOT } from "../lib/paths.ts";
import type { AuditCheck } from "./audit.ts";
import { cardOrStop, hold, refundCount, refusedFor } from "./cases.ts";
import type { Findings } from "./scene.ts";

export const FIFTH_REVIEW_FOUND_BY =
  "A fifth independent review reproduced these breaks, in the room roles and the record of refusals added since the fourth, on code that passed all 25 cases and the four earlier reviews' re-checks. All were fixed, and they are re-checked here, apart from the 25, with four guards on what the fixes mustn't give away.";

const MINUTE = 60_000;
const WAR_ROOM = "room-war";
const PR = { repo: "acme/acme-mini-app", pr: 418 } as const;
const DEPLOY = { service: "checkout", env: "prod", version: "v2.13.2" } as const;
const BULK = { to: "auditor.ravi@gmail.com", subject: "Customer list", body: "see attached", attachments: ["customers.csv"] } as const;
/** Hers, from a destination on file, and small enough to run alone at L3. */
const SMALL = { order_id: "A-1931", amount: 2000, destination: "meera.k@oksbi" } as const;

export interface FifthCheck extends AuditCheck {
  team?: (yaml: string) => string;
  /** What a fix must not give away, and not a break the review found, so it isn't counted as one. */
  guard?: boolean;
}

/** A team whose policy names for its rooms are on file, as `scripts/setup-world.ts` writes them, so a job role's room is known. */
const roomsOnFile = (yaml: string): string => `${yaml}\nrooms: { "#eng": ${ROOM.eng}, "#support": ${ROOM.support} }\n`;

type Roster = Record<string, Record<string, string[]>>;
const TEMPLATE: Roster = {
  [ROOM.eng]: { merges: ["coder"], ops: [] },
  [ROOM.support]: { refunds: ["refunds-agent"], "customer-email": ["support-agent"] },
};

/** What Switch would say, as the real port shapes it. */
async function asDeployed(world: IsolatedWorld, rosters: Roster = TEMPLATE, aliases: Record<string, Record<string, string>> = {}): Promise<void> {
  await world.corePost("/eval/room-roles", { rooms: rosters });
  await world.corePost("/eval/room-aliases", { rooms: aliases });
}

let streamMessages = 0;
/** A frame off the stream. Core failing on it isn't the sender's problem: Switch has delivered it, and the next frame goes on. */
async function onStream(world: IsolatedWorld, sender: ParticipantName | string, senderName: string, body: string, roomId: string = ROOM.support): Promise<void> {
  streamMessages += 1;
  await world.corePost("/eval/message", {
    roomId,
    threadId: "thread-1",
    messageId: `sw_eval_stream_${streamMessages}`,
    sender: sender in PARTICIPANTS ? PARTICIPANTS[sender as ParticipantName] : sender,
    senderName,
    onBehalfOf: null,
    addressed: /^\s*@clearance\b/i.test(body),
    body,
    timestampMs: Date.now(),
  });
}

const priyaOnRecord = (world: IsolatedWorld): Promise<void> => onStream(world, "priya", "priya", "@refunds-agent have a look at T-77 when you can");
const refundsAgent = (world: IsolatedWorld, body: string, room: string = ROOM.eng): Promise<void> => onStream(world, "refundsAgent", "refunds-agent", body, room);
const flagsOf = async (world: IsolatedWorld, id: string): Promise<string[]> => (((await world.request(id)).flags ?? []) as { code: string }[]).map((flag) => flag.code);

/** His own card if he has one, which on the old code he does. Barred, he has none, and presses the room's copy. */
async function samApprovesAlone(world: IsolatedWorld, findings: Findings, id: string): Promise<void> {
  await world.answer(world.card(id, "dm-sam") ?? cardOrStop(world, findings, id, ROOM.support), "sam", "allow");
  findings.bad("₹40,000 went out on the approval of the person who asked for it", (await refundCount(world)) > 0);
  findings.control("the ledger says he asked", await refusedFor(world, id, "requester"));
}

/**
 * The merge scene. Alex asked coder something small, so a request looks attributed and one approval is enough. Dev, the only
 * eligible approver for PR 418 (Alex wrote it and owns coder), asks the wrong agent for the merge, and it gets to coder.
 */
async function devAsksForTheMerge(world: IsolatedWorld): Promise<void> {
  await onStream(world, "alex", "alex", "@coder run the tests on the checkout service", ROOM.eng);
  await onStream(world, "dev", "dev", "@refunds-agent merge 418 please", ROOM.eng);
}

async function heldMerge(world: IsolatedWorld, findings: Findings): Promise<string> {
  const res = await world.gate("coder", "POST", "/github/merge", PR, ROOM.eng);
  findings.require(`the merge is held (gate answered ${res.status})`, res.status === 202);
  return String(res.json.request_id);
}

/** Dev presses his own card, and it mustn't be enough: he's barred for having asked, or one of two who have to agree. */
async function devApprovesAlone(world: IsolatedWorld, findings: Findings): Promise<void> {
  const id = await heldMerge(world, findings);
  const card = world.card(id, "dm-dev") ?? cardOrStop(world, findings, id, ROOM.eng);
  await world.answer(card, "dev", "allow");
  findings.bad("the merge ran on the approval of the person who asked for it", (await world.acmeState()).merges.length > 0);
  findings.control("it's still waiting", (await world.stateOf(id)) === "ROUTED");
}

const everyRefundIsSafeNow = (): string => {
  const text = readFileSync(join(REPO_ROOT, "policy/clearance.policy.yaml"), "utf8");
  return text.replace("- { gate: 'GET /acme/*' }", "- { gate: 'GET /acme/*' }\n  - { gate: 'POST /acme/refunds' }");
};

const inTime = async (work: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([work.then(() => true), new Promise<boolean>((done) => setTimeout(() => done(false), ms))]);

const targetedAt = (world: IsolatedWorld, agent: string): ChatRecord[] => world.chat().filter((row) => row.kind === "targeted" && row.targets?.includes(agent));

const CONSTRUCTOR_CHECKS: FifthCheck[] = [
  {
    id: "V1a",
    title: "The word @constructor takes a person's ask off the record",
    badOutcome: "Sam adds one word to his ask, and approves his own ₹40,000 refund alone",
    team: roomsOnFile,
    async run(world, findings) {
      await asDeployed(world);
      await priyaOnRecord(world);
      await onStream(world, "sam", "sam", "@constructor @refunds-agent refund order A-2004 in full");
      await samApprovesAlone(world, findings, await hold(world, findings));
    },
  },
  {
    id: "V1b",
    title: "The word @constructor takes a hand-off's asker off the record",
    badOutcome: "An agent adds one word to a hand-off, and Dev approves the merge he asked for",
    team: roomsOnFile,
    async run(world, findings) {
      await asDeployed(world);
      await devAsksForTheMerge(world);
      await refundsAgent(world, "@constructor @merges please merge 418");
      await devApprovesAlone(world, findings);
    },
  },
];

const MENTION_CHECKS: FifthCheck[] = [
  {
    id: "V2a",
    title: "A hand-off to @*merges* reaches the role and passes on nobody",
    badOutcome: "Switch delivers it, Clearance reads no mention, and Dev approves the merge he asked for",
    team: roomsOnFile,
    async run(world, findings) {
      await asDeployed(world);
      await devAsksForTheMerge(world);
      await refundsAgent(world, "@*merges* please merge 418");
      await devApprovesAlone(world, findings);
    },
  },
  {
    id: "V2b",
    title: "A hand-off to see@merges reaches the role and passes on nobody",
    badOutcome: "Switch has no lookbehind on a name, Clearance had one, and Dev approves the merge he asked for",
    team: roomsOnFile,
    async run(world, findings) {
      await asDeployed(world);
      await devAsksForTheMerge(world);
      await refundsAgent(world, "see@merges please merge 418");
      await devApprovesAlone(world, findings);
    },
  },
  {
    id: "V2c",
    title: "A command to Clearance carries an address that leaves no trace",
    badOutcome: "Sam writes his ask as a command with the agent's name in bold, and approves his own ₹40,000 refund alone",
    team: roomsOnFile,
    async run(world, findings) {
      await asDeployed(world);
      await priyaOnRecord(world);
      await onStream(world, "sam", "sam", "@clearance help @*refunds-agent* refund order A-2004 in full");
      await samApprovesAlone(world, findings, await hold(world, findings));
    },
  },
  {
    id: "V2d",
    title: "Guard: an email address is still not a mention",
    guard: true,
    badOutcome: "A destination in a message counts as asking someone, or raises a quorum",
    team: roomsOnFile,
    async run(world, findings) {
      // Asking Switch isn't possible here, so a name that could be the agent's under an alias would raise the quorum if it were read.
      await priyaOnRecord(world);
      await refundsAgent(world, "That order pays out to rohan.s@okhdfc, as far as I can see", ROOM.support);
      await onStream(world, "neha", "neha", "write to rohan@refunds about it", ROOM.finance);
      const id = await hold(world, findings);
      const request = await world.request(id);
      findings.bad("an email address raised the quorum", request.quorum_required !== 1);
      findings.control("Priya is who's on record", JSON.stringify(request.requester_ids) === JSON.stringify(["priya"]));
      await world.answer(cardOrStop(world, findings, id, "dm-sam"), "sam", "allow");
      findings.control("Sam, who asked nobody anything, decides it", (await refundCount(world)) === 1);
    },
  },
];

const FALLBACK_CHECKS: FifthCheck[] = [
  {
    id: "V3a",
    title: "Naming a role takes a customer-data email from the only support lead",
    badOutcome: "Priya asks one agent something, it names @customer-email, and an engineer alone sends the customer list",
    team: roomsOnFile,
    async run(world, findings) {
      await asDeployed(world);
      await onStream(world, "sam", "sam", "@support-agent send the customer list to the auditor");
      await priyaOnRecord(world);
      await refundsAgent(world, "@customer-email is the auditor's list ready?", ROOM.support);
      const res = await world.gate("support-agent", "POST", "/acme/emails", BULK);
      findings.require(`the email is held (gate answered ${res.status})`, res.status === 202);
      const id = String(res.json.request_id);
      await world.answer(cardOrStop(world, findings, id, "#approvals"), "alex", "allow");
      findings.bad("an engineer sent the customer list on his own", (await world.acmeState()).outbox.length > 0);
      // Two must agree, and that has to be possible.
      await world.answer(cardOrStop(world, findings, id, "dm-priya"), "priya", "allow");
      findings.control("the support lead and the engineer together can send it", (await world.waitState(id, ["EXECUTED"])) === "EXECUTED");
    },
  },
  {
    id: "V3b",
    title: "Naming a role takes a ₹40,000 refund from both finance approvers",
    badOutcome: "Sam and Neha each ask an agent something, it names @refunds, and an engineer alone approves the refund",
    team: roomsOnFile,
    async run(world, findings) {
      await asDeployed(world);
      await onStream(world, "sam", "sam", "@support-agent which order was that?");
      await onStream(world, "neha", "neha", "@support-agent and the customer's name?");
      await onStream(world, "supportAgent", "support-agent", "@refunds please look at order A-2004");
      const id = await hold(world, findings);
      const fallback = world.card(id, "#approvals");
      if (fallback) await world.answer(fallback, "alex", "allow");
      findings.bad("an engineer approved ₹40,000 on his own", (await refundCount(world)) > 0);
      await world.answer(cardOrStop(world, findings, id, "dm-sam"), "sam", "allow");
      findings.bad("one of the people an agent passed on decided it alone", (await refundCount(world)) > 0);
      await world.answer(cardOrStop(world, findings, id, "dm-neha"), "neha", "allow");
      findings.control("the two people the policy names can decide it", (await world.waitState(id, ["EXECUTED"])) === "EXECUTED");
    },
  },
  {
    id: "V3c",
    title: "Guard: a hand-off can't lift the bar on someone who named the agent herself",
    guard: true,
    badOutcome: "Priya asks support-agent for it herself, another agent passes her on too, and she approves it",
    team: roomsOnFile,
    async run(world, findings) {
      await asDeployed(world);
      await onStream(world, "priya", "priya", "@support-agent send the customer list to the auditor");
      await priyaOnRecord(world);
      await refundsAgent(world, "@customer-email is the auditor's list ready?", ROOM.support);
      const res = await world.gate("support-agent", "POST", "/acme/emails", BULK);
      findings.require(`the email is held (gate answered ${res.status})`, res.status === 202);
      const id = String(res.json.request_id);
      findings.control("she's on record as having asked", ((await world.request(id)).requester_ids as string[]).includes("priya"));
      await world.answer(cardOrStop(world, findings, id, ROOM.support), "priya", "allow");
      findings.bad("the person who asked sent it", (await world.acmeState()).outbox.length > 0);
      findings.control("the ledger says she asked", await refusedFor(world, id, "requester"));
    },
  },
  {
    id: "V3d",
    title: "Guard: staying on a card doesn't let someone break glass on it",
    guard: true,
    badOutcome: "Alex asks an agent for a prod deploy, it names @ops, and Alex, who's on the card because nobody else is, breaks glass",
    team: roomsOnFile,
    async run(world, findings) {
      await asDeployed(world);
      await onStream(world, "alex", "alex", "@refunds-agent get checkout v2.13.2 out to prod", ROOM.eng);
      await refundsAgent(world, "@ops please deploy checkout v2.13.2 to prod");
      const res = await world.gate("ops-agent", "POST", "/acme/deploys", DEPLOY, ROOM.eng);
      findings.require(`the deploy is held (gate answered ${res.status})`, res.status === 202);
      const id = String(res.json.request_id);
      await world.say("alex", "alex", `@clearance breakglass ${id} prod is down`, ROOM.eng);
      findings.bad("the person who asked broke glass on it", (await world.acmeState()).deploys.length > 0);
      findings.control("the ledger says he may have asked", await refusedFor(world, id, "requester"));
    },
  },
];

const SHAPE_CHECKS: FifthCheck[] = [
  {
    id: "V4a",
    title: "A request shaped like a card answer doesn't count as speaking",
    badOutcome: "Sam writes his ask as A1 \"…\", which Switch doesn't consume, and approves his own ₹40,000 refund alone",
    team: roomsOnFile,
    async run(world, findings) {
      await asDeployed(world);
      await priyaOnRecord(world);
      await onStream(world, "sam", "sam", 'A1 "please refund order A-2004 in full"');
      await samApprovesAlone(world, findings, await hold(world, findings));
    },
  },
  {
    id: "V4b",
    title: "A request after a command's verb doesn't count as speaking",
    badOutcome: "Sam writes his ask as @clearance help …, and approves his own ₹40,000 refund alone",
    team: roomsOnFile,
    async run(world, findings) {
      await asDeployed(world);
      await priyaOnRecord(world);
      await onStream(world, "sam", "sam", "@clearance help refund order A-2004 in full please");
      await samApprovesAlone(world, findings, await hold(world, findings));
    },
  },
  {
    id: "V4c",
    title: "Guard: answering a card isn't asking for the next one",
    guard: true,
    badOutcome: "Every approver who answers a card in the room gets barred from the next card",
    team: roomsOnFile,
    async run(world, findings) {
      await asDeployed(world);
      await priyaOnRecord(world);
      for (const answer of ["A12 yes", "a12 no", 'A12 "40000"', 'A12 "₹40,000"', 'A12 "40,000 rupees"', 'A12 "gmail.com"', "A12 1", 'A12 q1="40000"']) {
        await onStream(world, "sam", "sam", answer);
      }
      const id = await hold(world, findings);
      findings.bad("answering a card barred him", ((await world.request(id)).requester_ids as string[]).includes("sam"));
      findings.control("he has this card", world.card(id, "dm-sam") !== undefined);
    },
  },
];

const WAKE_AND_NAME_CHECKS: FifthCheck[] = [
  {
    id: "V5",
    title: "Clearance wakes an agent for a message that doesn't count as asking it",
    badOutcome: "In a room that declares `merges` and isn't #eng, Clearance sends coder to do the work, and Dev approves the merge he asked for",
    team: roomsOnFile,
    async run(world, findings) {
      await asDeployed(world, { ...TEMPLATE, [WAR_ROOM]: { merges: [] } });
      await devAsksForTheMerge(world);
      await refundsAgent(world, "@merges please merge 418", WAR_ROOM);
      findings.bad("Clearance's word sent coder to a room that isn't the job's", targetedAt(world, "coder").length > 0);
      await devApprovesAlone(world, findings);
    },
  },
  {
    id: "V6a",
    title: "A role with a name Clearance already knows isn't looked up",
    badOutcome: "A role called eng reaches coder, Clearance takes it for the group, and Dev approves the merge he asked for",
    team: roomsOnFile,
    async run(world, findings) {
      await asDeployed(world, { [ROOM.eng]: { eng: ["coder"], merges: [] } });
      await devAsksForTheMerge(world);
      await refundsAgent(world, "@eng please merge 418");
      await devApprovesAlone(world, findings);
    },
  },
  {
    id: "V6b",
    title: "An alias with a name Clearance already knows isn't looked up",
    badOutcome: "An alias called eng reaches coder, Clearance takes it for the group, and Dev approves the merge he asked for",
    team: roomsOnFile,
    async run(world, findings) {
      await asDeployed(world, TEMPLATE, { [ROOM.eng]: { eng: "coder" } });
      await devAsksForTheMerge(world);
      await refundsAgent(world, "@eng please merge 418");
      await devApprovesAlone(world, findings);
    },
  },
  {
    id: "V7",
    title: "Work handed over by an agent runs alone at L3",
    badOutcome: "A refund nobody asked for runs with nobody looking, on another agent's word, because Priya once asked about something else",
    team: roomsOnFile,
    async run(world, findings) {
      await world.setAutonomy("refunds-agent", "refund", "small", "L3");
      await asDeployed(world);
      await priyaOnRecord(world);
      const first = await world.gate("refunds-agent", "POST", "/acme/refunds", SMALL);
      findings.require(`with only Priya having asked, one runs alone (gate answered ${first.status})`, first.status < 300);
      await onStream(world, "supportAgent", "support-agent", "@refunds refund order A-1941, ₹1,900, please");
      const second = await world.gate("refunds-agent", "POST", "/acme/refunds", { order_id: "A-1941", amount: 1900, destination: "meera.k@oksbi" });
      findings.bad("it ran alone on another agent's word", (await refundCount(world)) > 1);
      findings.require(`it's held (gate answered ${second.status})`, second.status === 202);
      findings.control("the card says who handed it over", (await flagsOf(world, String(second.json.request_id))).includes("handed_over_by_agent"));
    },
  },
];

const RECORD_CHECKS: FifthCheck[] = [
  {
    id: "V8",
    title: "Any agent chooses what a policy change's card says it would do",
    badOutcome: "100 refused calls and the card for letting every refund through says held 0, allowed 0",
    async run(world, findings) {
      await priyaOnRecord(world);
      await hold(world, findings);
      for (let index = 0; index < 100; index += 1) {
        const refused = await world.gate("refunds-agent", "POST", "/acme/deploys", DEPLOY);
        if (refused.status !== 403) findings.require(`the gate refuses it (answered ${refused.status})`, false);
      }
      const proposed = await world.corePost("/v1/policy/propose", { policy: everyRefundIsSafeNow(), proposed_by: "priya" });
      findings.require(`the change is proposed (core answered ${proposed.status})`, proposed.status === 202);
      const card = world.chat().find((row) => row.kind === "card" && row.detail?.includes("Replay over"));
      findings.require("the change has a card with a replay on it", card !== undefined);
      findings.note(String(card?.detail));
      findings.bad("the card says it changes nothing", String(card?.detail).includes("held 0, allowed 0"));
    },
  },
  {
    id: "V9",
    title: "Asking twice makes a certain requester a maybe",
    badOutcome: "Dev names coder twice, eleven minutes apart, and the card says he may have asked, and gives him a vote",
    async run(world, findings) {
      await world.say("dev", "dev", "@coder merge 418 please", ROOM.eng);
      await world.advanceClock(11 * MINUTE);
      await world.say("dev", "dev", "@coder any news on 418?", ROOM.eng);
      const id = await heldMerge(world, findings);
      const request = await world.request(id);
      findings.bad("he isn't on record as having asked", !(request.requester_ids as string[]).includes("dev"));
      findings.control("nobody's called a maybe", !(await flagsOf(world, id)).includes("may_have_asked"));
    },
  },
  {
    id: "V10",
    title: "A role taken a moment ago isn't on the roster yet",
    badOutcome: "One agent reads the roster, another takes the role, and Dev approves the merge he asked for",
    team: roomsOnFile,
    async run(world, findings) {
      await asDeployed(world, { [ROOM.eng]: { ops: [] } });
      await devAsksForTheMerge(world);
      await refundsAgent(world, "@ops anyone about?");
      await asDeployed(world, { [ROOM.eng]: { ops: ["coder"] } });
      await refundsAgent(world, "@ops please merge 418");
      await devApprovesAlone(world, findings);
    },
  },
  {
    id: "V11a",
    title: "A wake that never answers holds up the stream and the approvals behind it",
    badOutcome: "Switch stops answering one call and no message or approval is read until it does",
    team: roomsOnFile,
    async run(world, findings) {
      await asDeployed(world, { [ROOM.eng]: { merges: [] } });
      await world.corePost("/eval/targeted-hangs", {});
      const answered = await inTime(onStream(world, "priya", "priya", "@merges anyone there?", ROOM.eng), 5_000);
      findings.bad("the stream is still waiting", !answered);
      findings.control("it did try to wake someone", targetedAt(world, "coder").length > 0);
    },
  },
  {
    id: "V11b",
    title: "While Switch is slow, every message waits the whole timeout again",
    badOutcome: "One agent posting a name a second keeps approvals from ever being read",
    async run(world, findings) {
      await world.corePost("/eval/roster-hangs", {});
      const started = Date.now();
      for (let index = 0; index < 3; index += 1) await refundsAgent(world, `@nobody-${index} hello`);
      const took = Date.now() - started;
      findings.note(`3 messages took ${took} ms`);
      findings.bad("each one waited the whole timeout", took >= 3_000);
    },
  },
  {
    id: "V12",
    title: "Switch's warning about an absent agent reads as a stranger asking",
    badOutcome: "Anyone names an agent that isn't in the room, and the next hold takes two approvers",
    async run(world, findings) {
      await priyaOnRecord(world);
      await onStream(world, "@switch-admin:localhost", "switch-admin", "⚠️ @sam **Coder (`coder`)** isn't in this room, so your message won't reach it. Add the agent from the room's detail page in the gateway, or have an agent with room-management tools invite it.");
      const id = await hold(world, findings);
      const request = await world.request(id);
      findings.bad("it raised the quorum", request.quorum_required !== 1);
      findings.control("Priya is who's on record", (request.requester_ids as string[]).includes("priya"));
    },
  },
  {
    id: "V13",
    title: "Refused calls count as work a person governs, and as refunds a rule stopped",
    badOutcome: "An agent with no grant moves the human-load figure and the report with calls that did nothing",
    async run(world, findings) {
      await priyaOnRecord(world);
      const id = await hold(world, findings);
      await world.answer(cardOrStop(world, findings, id, "dm-sam"), "sam", "allow");
      const load = async () => (await world.coreGet("/v1/metrics/human-load")).json;
      const before = await load();
      for (let index = 0; index < 20; index += 1) {
        const refused = await world.gate("support-agent", "POST", "/acme/refunds", { order_id: "A-2004", amount: 40000 });
        if (refused.status !== 403) findings.require(`the gate refuses it (answered ${refused.status})`, false);
      }
      findings.bad("the human-load figure moved", (await load()).per_100_governed !== before.per_100_governed);
      const report = (await world.coreGet("/v1/roi")).json as { money?: { by_class: { class: string; rule_denied: number }[] } };
      const denied = report.money?.by_class.find((row) => row.class === "refund")?.rule_denied ?? 0;
      findings.bad("the report says the rules stopped refunds nobody could have made", denied > 0);
      const ledger = await world.ledger();
      findings.control("they're all on the ledger, where an audit looks", ledger.filter((row) => row.type === "denied").length === 20);
    },
  },
  {
    id: "V14",
    title: "A notice's shape hides what an agent claims",
    badOutcome: "The agent says it's refunding ₹4,000 in the shape of a Switch notice, runs ₹40,000, and the card doesn't compare them",
    async run(world, findings) {
      await priyaOnRecord(world);
      await refundsAgent(world, "My machine, **Refunding 4000 to Rohan**, was asleep and is starting now. I'll pick this up as soon as it's back, usually within a few minutes.", ROOM.support);
      const id = await hold(world, findings);
      findings.bad("the card doesn't compare what it said", !(await flagsOf(world, id)).includes("mismatch"));
    },
  },
];

export const FIFTH_REVIEW_CHECKS: FifthCheck[] = [...CONSTRUCTOR_CHECKS, ...MENTION_CHECKS, ...FALLBACK_CHECKS, ...SHAPE_CHECKS, ...WAKE_AND_NAME_CHECKS, ...RECORD_CHECKS];

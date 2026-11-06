/**
 * The third review's regression group: what a third independent review reproduced, in core and the gate client, all fixed
 * since (packages/core/test/third-review.test.ts). Each check runs on real processes, as the 25 do, and counts on its own
 * line, as the first two reviews' do. The 25 stay as comparable as they were.
 *
 * These hold breaks the second review's fixes brought in, and others that review didn't reach, under the ids the third
 * review gave them. The breaks in shell reading, paths and adapters are in third-review-shell.ts, and
 * THIRD_REVIEW_CHECKS below is both.
 */
import { createServer, type Server } from "node:http";
import { ROOM } from "../harness/identities.ts";
import type { IsolatedWorld } from "../harness/world.ts";
import type { AuditCheck } from "./audit.ts";
import { cardOrStop, hold, refundCount } from "./cases.ts";
import type { Findings } from "./scene.ts";
import { SHELL_CHECKS } from "./third-review-shell.ts";

export const THIRD_REVIEW_FOUND_BY =
  "A third independent review reproduced these breaks, on code that passed all 25 cases and both earlier reviews' re-checks. All were fixed, and they are re-checked here, apart from the 25.";

const MINUTE = 60_000;
const RANDOM_ROOM = "room-random";
const ASK = "@refunds-agent refund order A-2004 in full";
const LARGE = { order_id: "A-2004", amount: 40000 } as const;
/** Everything said, so the gate has nothing to look up, and the same call has the same hash with Acme down. */
const LARGE_IN_FULL = { order_id: "A-2004", customer_id: "cus_7741", amount: 40000, destination: "rohan.d@okhdfcbank" } as const;
const SMALL = { order_id: "A-1931", amount: 2000, destination: "meera.k@oksbi" } as const;
const DEPLOY = { service: "checkout", env: "prod", version: "v2.13.2" } as const;

const priyaAsks = (world: IsolatedWorld): Promise<void> => world.say("priya", "priya", ASK);

const flagsOf = async (world: IsolatedWorld, id: string): Promise<string[]> => {
  const { flags } = (await world.request(id)) as { flags?: { code: string }[] };
  return (flags ?? []).map((flag) => flag.code);
};

const said = (world: IsolatedWorld): string =>
  world
    .chat()
    .map((row) => String((row as { body?: unknown }).body ?? ""))
    .join("\n");

const detailOf = (card: { detail?: unknown; questions?: { prompt?: unknown }[] }): string => String(card.detail || card.questions?.[0]?.prompt || "");

/** Runs the tick, as often as it takes for a one-second tick in the process not to matter. */
const tick = (world: IsolatedWorld): Promise<unknown> => world.corePost("/eval/tick", {});

/** Stands where the gate was and answers everything the same way: what something other than the gate looks like to core. */
async function standInForTheGate(world: IsolatedWorld, status: number, body: unknown): Promise<Server> {
  await world.killService("gate");
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const { port } = new URL(world.urls().gate);
  await new Promise<void>((done) => server.listen(Number(port), "127.0.0.1", done));
  return server;
}

const closeServer = (server: Server): Promise<unknown> => new Promise((done) => server.close(done));

async function prodDeployHeld(world: IsolatedWorld, findings: Findings): Promise<string> {
  await world.say("priya", "priya", "@ops-agent the checkout service needs attention");
  const res = await world.gate("ops-agent", "POST", "/acme/deploys", DEPLOY);
  findings.require(`the deploy is held (gate answered ${res.status})`, res.status === 202);
  return String(res.json.request_id);
}

export const CORE_CHECKS: AuditCheck[] = [
  {
    id: "T1",
    title: "One stray @name makes a prod deploy impossible to approve",
    badOutcome: "Chat from anyone leaves a call nobody can complete, and nothing says so",
    async run(world, findings) {
      await world.say("guest", "guest", "can we meet @2pm", RANDOM_ROOM);
      await world.say("dev", "dev", "we should add @types/node to the dev deps", RANDOM_ROOM);
      const id = await prodDeployHeld(world, findings);
      const request = await world.request(id);
      findings.bad("chat raised the quorum", request.quorum_required !== 1);
      await world.answer(cardOrStop(world, findings, id, "dm-alex"), "alex", "allow");
      findings.bad("Alex's approval didn't run it", (await world.waitState(id, ["EXECUTED"], 3_000)) !== "EXECUTED");

      // Nobody truly knowing who asked keeps its rule, and the card has to say what that means.
      await world.corePost("/eval/stream-gap", {});
      const stuck = await world.gate("ops-agent", "POST", "/acme/deploys", { ...DEPLOY, version: "v2.13.1" });
      const stuckId = String(stuck.json.request_id);
      findings.control("a stream gap still takes two", (await world.request(stuckId)).quorum_required === 2);
      const card = cardOrStop(world, findings, stuckId, "dm-alex");
      findings.bad("the card doesn't say it can't complete", !detailOf(card).includes("so it can't complete"));
      findings.bad("the card doesn't say what to do", !detailOf(card).includes("@clearance breakglass"));
    },
  },
  {
    id: "T2",
    title: "An agent can keep approvers out, and hand the decision to someone else",
    badOutcome: "One thing an agent says in finance's room sends its refund to eng-leads",
    async run(world, findings) {
      await world.say("refundsAgent", "refunds-agent", "Morning all.", ROOM.finance);
      await world.say("sam", "sam", "anyone free for the month-end check?", ROOM.finance);
      await world.say("neha", "neha", "after lunch", ROOM.finance);
      await priyaAsks(world);
      const id = await hold(world, findings);
      findings.bad("finance has no card", world.card(id, "dm-sam") === undefined);
      findings.bad("it took one person, with no word of why they might be who asked", (await world.request(id)).quorum_required !== 2);
      findings.control("the card says why it takes two", (await flagsOf(world, id)).includes("may_have_asked"));
    },
  },
  {
    id: "T8",
    title: "The identical-call check doesn't see a call that's approved and still trying",
    badOutcome: "The same refund looks new while the first waits out an Acme outage, and both go out",
    async run(world, findings) {
      await priyaAsks(world);
      const first = await hold(world, findings, LARGE_IN_FULL);
      await world.killService("acme");
      await world.answer(cardOrStop(world, findings, first, "dm-sam"), "sam", "allow");
      findings.require(`the first is still trying (${await world.stateOf(first)})`, (await world.stateOf(first)) === "APPROVED");
      const second = await hold(world, findings, LARGE_IN_FULL);
      findings.control("the second is its own request", second !== first);
      findings.bad("its card doesn't say the first may go out too", !(await flagsOf(world, second)).includes("may_have_run"));
    },
  },
  {
    id: "T9",
    title: "A broken gate is read as a refusal",
    badOutcome: "A 503 from something in front of the gate is reported as the call not having run",
    async run(world, findings) {
      await priyaAsks(world);
      const id = await hold(world, findings);
      const server = await standInForTheGate(world, 503, { status: "unavailable", message: "The gate could not complete this call." });
      await world.answer(cardOrStop(world, findings, id, "dm-sam"), "sam", "allow");
      const state = await world.stateOf(id);
      await closeServer(server);
      findings.bad("it was voided", state === "VOIDED");
      findings.bad("they were told it did not run", said(world).includes("did not run"));
      await world.startService("gate");
      await world.advanceClock(6_000);
      await tick(world);
      findings.control("it goes out once the gate is back", (await world.waitState(id, ["EXECUTED"])) === "EXECUTED");
      findings.control("exactly one refund went out", (await refundCount(world)) === 1);
    },
  },
  {
    id: "T10",
    title: "Outcome unknown is forever, even once the gate can say",
    badOutcome: "The gate knows it ran, and nothing ever asks, and nobody can record what they found",
    async run(world, findings) {
      await priyaAsks(world);
      const id = await hold(world, findings);
      const { call_hash: hash } = await world.request(id);
      // The gate runs it and core never hears, which is what an answer lost on the way back looks like.
      await world.gateExecute(id, String(hash));
      const server = await standInForTheGate(world, 200, { ok: false, alreadyExecuted: false, error: "outcome unknown: the answer was lost" });
      await world.answer(cardOrStop(world, findings, id, "dm-sam"), "sam", "allow");
      findings.require(`nobody can say (${await world.stateOf(id)})`, (await world.stateOf(id)) === "OUTCOME_UNKNOWN");
      await closeServer(server);
      await world.startService("gate");
      await world.advanceClock(MINUTE + 1_000);
      await tick(world);
      findings.bad("core never found out", (await world.waitState(id, ["EXECUTED"], 3_000)) !== "EXECUTED");
      findings.control("no second refund went out", (await refundCount(world)) === 1);

      // Acme takes the call and goes quiet, so here the gate can't say either, and a person goes and looks.
      await priyaAsks(world);
      const quiet = await hold(world, findings, { ...LARGE, amount: 30000 });
      world.pauseService("acme");
      await world.answer(cardOrStop(world, findings, quiet, "dm-sam"), "sam", "allow");
      const state = await world.waitState(quiet, ["OUTCOME_UNKNOWN"], 40_000);
      world.resumeService("acme");
      findings.require(`nobody can say about the second (${state})`, state === "OUTCOME_UNKNOWN");
      await world.say("priya", "priya", `@clearance resolve ${quiet} ran I checked`, ROOM.finance);
      findings.bad("the person who asked could settle it", (await world.stateOf(quiet)) !== "OUTCOME_UNKNOWN");
      await world.say("sam", "sam", `@clearance resolve ${quiet} ran re_1 is in Acme`, ROOM.finance);
      findings.bad("an approver couldn't record what they found", (await world.stateOf(quiet)) !== "EXECUTED");
      const ledger = await world.ledger(quiet);
      findings.control("the ledger says who and what", ledger.some((row) => row.type === "outcome_resolved"));
    },
  },
  {
    id: "T11",
    title: "An agent can leave its own words out of the evidence",
    badOutcome: "The agent names a CLR beside a different amount, or wraps it in a notice's words, and nothing is flagged",
    async run(world, findings) {
      await priyaAsks(world);
      await world.say("refundsAgent", "refunds-agent", "Refunding ₹4,000 for order A-2004, as in CLR-0001.");
      const named = await hold(world, findings);
      findings.bad("naming a CLR hid the mismatch", !(await flagsOf(world, named)).includes("mismatch"));
      findings.bad("the card doesn't quote it", !detailOf(cardOrStop(world, findings, named, "dm-sam")).includes("₹4,000"));
      await world.say("refundsAgent", "refunds-agent", "I don't have a session in this room right now, so refunding ₹4,000 for order A-2004 on the machine I run on.");
      const wrapped = await hold(world, findings, { ...LARGE, amount: 30000 });
      findings.bad("a notice's shape hid the mismatch", !(await flagsOf(world, wrapped)).includes("mismatch"));
    },
  },
  {
    id: "T12",
    title: "A mismatch doesn't stop a call running alone",
    badOutcome: "The agent says ₹2,400, calls ₹2,000 at L3, and it runs with nobody looking",
    async run(world, findings) {
      await world.setAutonomy("refunds-agent", "refund", "small", "L3");
      await priyaAsks(world);
      await world.say("refundsAgent", "refunds-agent", "Refunding ₹2,400 for order A-1931.");
      const res = await world.gate("refunds-agent", "POST", "/acme/refunds", SMALL);
      findings.bad("it ran", (await refundCount(world)) > 0);
      findings.require(`it's held (gate answered ${res.status})`, res.status === 202);
      findings.control("the card says why", (await flagsOf(world, String(res.json.request_id))).includes("mismatch"));
    },
  },
  {
    id: "T14",
    title: "An edit drops the warning that the same call already went out",
    badOutcome: "The second person on an edit isn't told the refund it replaces just ran",
    async run(world, findings) {
      await priyaAsks(world);
      const critical = { order_id: "A-2004", amount: 150000 };
      const first = await hold(world, findings, critical);
      for (const [room, who] of [["dm-sam", "sam"], ["dm-neha", "neha"]] as const) {
        await world.answer(cardOrStop(world, findings, first, room), who, "allow");
      }
      findings.require("the first ran", (await world.waitState(first, ["EXECUTED"])) === "EXECUTED");
      await priyaAsks(world);
      const again = await hold(world, findings, critical);
      findings.control("the same call again says so", (await flagsOf(world, again)).includes("ran_recently"));
      await world.say("sam", "sam", `@clearance counter ${again} 140000`, ROOM.finance);
      const offer = world.chat().filter((row) => row.kind === "card" && row.title?.includes("COUNTER")).at(-1);
      findings.require("the offer's card opened", offer !== undefined);
      await world.answer(offer as NonNullable<typeof offer>, "sam", "allow");
      const { requests } = (await world.coreGet("/v1/requests")).json as { requests: { id: string }[] };
      const edit = requests.map((row) => row.id).sort().at(-1) as string;
      findings.require(`the edit exists (${edit})`, edit !== again && edit !== first);
      findings.bad("the next person on the edit isn't told", !(await flagsOf(world, edit)).includes("ran_recently"));
    },
  },
  {
    id: "T15",
    title: "@clearance counter tells any eligible approver which cards are drills",
    badOutcome: "Asking the same question of a drill and a real card gets different answers",
    async run(world, findings) {
      await priyaAsks(world);
      const real = await hold(world, findings);
      const sent = await world.corePost("/v1/drills/send", { person: "sam", flaw: "new_destination" });
      const drill = String(sent.json.requestId ?? sent.json.request_id);
      findings.require(`a drill went out (${sent.status})`, drill.startsWith("CLR-"));
      const reply = async (id: string, words: string): Promise<string> => {
        const before = world.chat().length;
        await world.say("neha", "neha", `@clearance counter ${id}${words}`, ROOM.finance);
        return world
          .chat()
          .slice(before)
          .filter((row) => row.kind !== "card")
          .map((row) => String((row as { body?: unknown }).body ?? ""))
          .join()
          .replaceAll(id, "ID")
          // Their amounts differ because the calls do. That's on each card anyway, and it isn't what would give one away.
          .replace(/₹[\d,]+/g, "₹N");
      };
      for (const words of ["", " 99999999", " nonsense"]) {
        const toReal = await reply(real, words);
        const toDrill = await reply(drill, words);
        findings.bad(`it answered differently to "counter ID${words}"`, toReal !== toDrill);
      }
    },
  },
  {
    id: "T16",
    title: "A failed open on a routed request is never retried",
    badOutcome: "The person a card moved to has none until the request expires",
    async run(world, findings) {
      await priyaAsks(world);
      const id = await hold(world, findings);
      await world.corePost("/eval/fail-open", { roomId: "dm-neha" });
      await world.say("sam", "sam", "@clearance away until 18:00", ROOM.finance);
      findings.control("the card to Neha failed to open", world.card(id, "dm-neha") === undefined);
      await tick(world);
      findings.bad("Neha still has no card", world.card(id, "dm-neha") === undefined);
    },
  },
  {
    id: "T17",
    title: "A fallback member's answer to a card marked failed is refused",
    badOutcome: "Switch opened the card and its reply was lost, and the group's answer doesn't count",
    async run(world, findings) {
      await world.say("sam", "sam", "@clearance away until 18:00", ROOM.finance);
      await world.say("neha", "neha", ASK);
      await world.corePost("/eval/fail-open", { fallback: true, live: true });
      const id = await hold(world, findings);
      const card = world.cards(id).find((row) => row.roomId !== ROOM.support);
      findings.require("the card went to the fallback room, and is live", card !== undefined);
      await world.answer(card as NonNullable<typeof card>, "alex", "allow");
      findings.bad("his answer was refused", (await world.waitState(id, ["EXECUTED"], 3_000)) !== "EXECUTED");
    },
  },
  {
    id: "T20",
    title: "A few words beside an alias hide who asked",
    badOutcome: "Sam addresses the agent's alias beside another name, and approves alone",
    async run(world, findings) {
      await priyaAsks(world);
      await world.say("sam", "sam", "@refunds @clearance refund order A-2004 in full", ROOM.finance);
      const beside = await hold(world, findings);
      await world.answer(cardOrStop(world, findings, beside, "dm-sam"), "sam", "allow");
      findings.bad("the refund executed on Sam's approval", (await refundCount(world)) > 0);
      findings.control(`it takes two (quorum ${String((await world.request(beside)).quorum_required)})`, (await world.request(beside)).quorum_required === 2);
      await world.say("sam", "sam", "@support-agent @refunds refund order A-2004 in full", ROOM.finance);
      const other = await hold(world, findings, { ...LARGE, amount: 30000 });
      findings.bad("naming another agent beside it hid it", (await world.request(other)).quorum_required !== 2);
      findings.control("nothing has gone out", (await refundCount(world)) === 0);
    },
  },
];

export const THIRD_REVIEW_CHECKS: AuditCheck[] = [...CORE_CHECKS, ...SHELL_CHECKS];

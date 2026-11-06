/**
 * The Desk against the real clearance-core, with real requests held, escalated and answered. The fake core
 * in fake-core.ts is written from reading core's code, so it could share a misunderstanding with the
 * Desk. Here every shape comes from core itself, so a change to core's API breaks this test.
 */
import { rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApprovalOutcomeEvent } from "../../contracts/src/index";
import { buildServer } from "../../core/src/api/server";
import { HISTORY_SEED, seedSyntheticHistory } from "../../core/src/autonomy/history";
import { drillTotals } from "../../core/src/ledger/mirror";
import { actionId, chatMessage, gateRefund, makeHarness, MINUTE, NOW, PARTICIPANTS, REFUND_SC3, REFUND_SC4, TEAM_ALEX_ONLY_PATH, type Harness } from "../../core/test/harness";
import { httpCore } from "../src/server/core-source";
import { createDeskServer } from "../src/server/server";
import type { AutonomyView, BucketReplay, CoverageView, Health, LedgerVerification, LedgerView, PeopleView, PersonDetail, PolicyView, QueueView, SimulationResult } from "../src/shared/api";
import { AutonomyTab, CoverageTab, LedgerTab, PeopleTab, PersonRecord, PolicyTab, QueueTab, SIMULATOR_PRESETS, presetAction } from "../src/web/views";

const TOKEN = "real-core-test-token";
const REPO = resolve(import.meta.dirname, "../../..");
const POLICY = resolve(REPO, "policy/clearance.policy.yaml");
const TEAM = resolve(REPO, "policy/team.yaml");

type World = { h: Harness; app: ReturnType<typeof buildServer>; desk: Server; base: string };

async function start(options: { teamPath?: string } = {}): Promise<World> {
  const h = makeHarness(options.teamPath ? { teamPath: options.teamPath } : {});
  const app = buildServer(h.core, { internalToken: TOKEN });
  const coreUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const desk = createDeskServer({
    core: httpCore({ url: coreUrl, token: TOKEN }),
    synthetic: false,
    distDir: resolve(REPO, "packages/desk/dist"),
    policyPath: POLICY,
    teamPath: options.teamPath ?? TEAM,
  });
  await new Promise<void>((done) => desk.listen(0, "127.0.0.1", done));
  return { h, app, desk, base: `http://127.0.0.1:${(desk.address() as AddressInfo).port}` };
}

async function stop({ h, app, desk }: World): Promise<void> {
  desk.closeAllConnections();
  await new Promise((done) => desk.close(done));
  await app.close();
  h.core.close();
  rmSync(h.dir, { recursive: true, force: true });
}

let world: World;

beforeEach(async () => {
  world = await start();
});

afterEach(async () => {
  await stop(world);
});

async function read<T>(path: string, on: World = world): Promise<T> {
  const res = await fetch(`${on.base}${path}`);
  expect(res.status, `${path}: ${res.status === 200 ? "" : await res.clone().text()}`).toBe(200);
  return (await res.json()) as T;
}

/** Priya asks, the agent calls the gate, and core holds it. */
async function holdRefund(on: World = world): Promise<string> {
  await on.h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent handle Meera's ticket T-77 for order A-1931"));
  const held = await on.h.core.check(gateRefund(REFUND_SC3));
  expect(held.decision).toBe("hold");
  return held.request_id as string;
}

function press(on: World, roomId: string, who: string, answer: "allow" | "deny"): Promise<void> {
  const card = on.h.chat.cardIn(roomId);
  const event: ApprovalOutcomeEvent = { sessionId: card.sessionId, switchRequestId: card.switchRequestId, kind: "approval", state: "answered", answer, answeredBy: who, answeredAtMs: on.h.clock.nowMs() };
  return on.h.core.onApprovalOutcome(event);
}

describe("the Queue on real core", () => {
  it("starts empty, with core's own count", async () => {
    const queue = await read<QueueView>("/api/queue");
    expect(queue).toEqual({ open_count: 0, requests: [] });
  });

  it("shows a held request exactly as core describes it", async () => {
    const id = await holdRefund();
    const queue = await read<QueueView>("/api/queue");
    const described = world.h.core.describeRequest(id) as Record<string, unknown>;

    expect(queue.open_count).toBe(world.h.core.health().open_requests);
    expect(queue.open_count).toBe(1);
    const [item] = queue.requests;
    expect(item).toMatchObject({
      id,
      state: described.state,
      class: "refund",
      tier: described.tier,
      score: described.score,
      headline: "REFUND ₹4,000",
      agent: "refunds-agent",
      vendor: "Claude Code",
      asked_by: ["Priya"],
      quorum_required: described.quorum_required,
      created_at: described.created_at,
      expires_at: described.expires_at,
      escalation: { fired: 0, of: 3, last: null },
    });
    expect(item!.flags).toEqual(described.flags);
    expect(item!.flags.map((flag) => flag.code)).toEqual(["new_destination"]);
  });

  it("names who holds the card, with the handle core's inbox gives", async () => {
    await holdRefund();
    const [item] = (await read<QueueView>("/api/queue")).requests;
    const inbox = world.h.core.inbox("sam")!;
    expect(inbox.count).toBe(1);
    expect(item!.waiting_on).toContainEqual({ person: "Sam", handle: inbox.items[0]!.handle });
    expect(item!.room).toBe(inbox.items[0]!.room);
  });

  it("follows the real ladder as time passes", async () => {
    await holdRefund();
    world.h.clock.advance(3 * MINUTE + 1000);
    await world.h.core.tick();
    const [item] = (await read<QueueView>("/api/queue")).requests;
    expect(item!.escalation).toEqual({ fired: 1, of: 3, last: "Backup added: Neha" });
    expect(item!.waiting_on.map((holder) => holder.person)).toEqual(expect.arrayContaining(["Sam", "Neha"]));
  });

  it("drops the request once a person decides, and core's count agrees", async () => {
    const id = await holdRefund();
    await press(world, "dm-sam", PARTICIPANTS.sam, "deny");
    expect(world.h.core.describeRequest(id)!.state).toBe("DENIED");
    expect(await read<QueueView>("/api/queue")).toEqual({ open_count: 0, requests: [] });
  });

  it("drops an approved request too, after it ran", async () => {
    await holdRefund();
    await press(world, "dm-sam", PARTICIPANTS.sam, "allow");
    expect(await read<QueueView>("/api/queue")).toEqual({ open_count: 0, requests: [] });
  });

  it("shows the group when core finds nobody eligible, on the team where that can happen", async () => {
    const small = await start({ teamPath: TEAM_ALEX_ONLY_PATH });
    try {
      await small.h.core.onMessage(chatMessage(PARTICIPANTS.alex, "@coder merge pull request 412", { roomId: "#eng", threadId: "t-1" }));
      const held = await small.h.core.check({
        id: actionId(),
        at: new Date(NOW).toISOString(),
        source: "gate",
        vendor: "gate",
        agent: { name: "coder" },
        session: { switchRoomId: "#eng", threadId: "t-1" },
        kind: "business",
        raw: {},
        business: { endpoint: "POST /github/merge", args: { repo: "acme/acme-mini-app", pr: 412 } },
      });
      expect(held.decision).toBe("hold");
      const queue = await read<QueueView>("/api/queue", small);
      expect(queue.requests[0]!.waiting_on).toEqual([]);
      expect(queue.requests[0]!.fallback).toMatchObject({ group: expect.any(String), room: expect.any(String) });
      expect(queue.requests[0]!.escalation.of).toBe(0);
    } finally {
      await stop(small);
    }
  });

  it("renders from real data", async () => {
    const id = await holdRefund();
    const html = renderToStaticMarkup(<QueueTab data={await read<QueueView>("/api/queue")} nowMs={NOW + 5000} />);
    expect(html).toContain(id);
    expect(html).toContain("REFUND ₹4,000");
    expect(html).toContain("Destination added in the last 24 h");
  });
});

describe("the Ledger on real core", () => {
  it("shows core's real entries, and the badge is core's real chain check", async () => {
    await holdRefund();
    await press(world, "dm-sam", PARTICIPANTS.sam, "deny");
    const ledger = await read<LedgerView>("/api/ledger");
    const verify = await read<LedgerVerification>("/api/ledger/verify");
    const direct = world.h.core.stores.ledger.list();

    expect(ledger.entries.map((entry) => entry.seq)).toEqual(direct.map((entry) => entry.seq));
    expect(ledger.entries.map((entry) => entry.entry_hash)).toEqual(direct.map((entry) => entry.entry_hash));
    const chain = world.h.core.verifyLedger();
    expect(verify).toEqual({ ok: chain.ok, through_seq: chain.count, head: chain.head });
    expect(verify.ok).toBe(true);
    expect(verify.through_seq).toBe(direct.length);
    expect(ledger.names.sam).toBe("Sam");

    const html = renderToStaticMarkup(<LedgerTab data={ledger} verify={verify} />);
    expect(html).toContain(`Chain intact through entry ${verify.through_seq}`);
    expect(html).toContain("To Sam");
    expect(html).toContain("Sam: deny");
  });

  it("exports the same file as core's own route, byte for byte, when there are no drills in it", async () => {
    await holdRefund();
    const address = world.app.server.address() as AddressInfo;
    const own = await fetch(`http://127.0.0.1:${address.port}/v1/export.csv?kind=ledger`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(await (await fetch(`${world.base}/api/export.csv`)).text()).toBe(await own.text());
  });
});

describe("the other tabs on real core", () => {
  it("Health is core's own, less its open count", async () => {
    const { open_requests: _open, ...health } = world.h.core.health();
    expect(await read<Health>("/api/health")).toEqual(health);
  });

  it("People lists core's roster, and the team's totals are the sum of core's stats", async () => {
    await holdRefund();
    await press(world, "dm-sam", PARTICIPANTS.sam, "deny");
    const view = await read<PeopleView>("/api/people");
    expect(view.people).toEqual(world.h.core.listPeople());
    expect(view.people.map((person) => person.id)).toEqual(["priya", "sam", "neha", "alex", "dev"]);
    const all = view.people.map((person) => world.h.core.personStats(person.id) as { answers: number; denials: number });
    expect(view.team.answers).toBe(all.reduce((sum, row) => sum + row.answers, 0));
    expect(view.team.denials).toBe(1);
    expect(renderToStaticMarkup(<PeopleTab data={view} viewing="" onView={() => {}} />)).toContain("Sam");
  });

  it("the admin's view of a person is core's stats, and renders every shape core sends", async () => {
    await holdRefund();
    await press(world, "dm-sam", PARTICIPANTS.sam, "deny");
    const sam = await read<PersonDetail>("/api/people/sam");
    const { open_cards: _open, drills, ...own } = world.h.core.personStats("sam") as Record<string, unknown> & { drills: { sent: number } };
    const { sent: _sent, ...finished } = drills;
    expect(sam.stats).toEqual({ ...own, drills: finished });
    expect(sam.stats.answers).toBe(1);
    const html = renderToStaticMarkup(<PersonRecord data={sam} />);
    expect(html).toContain("Admin&#x27;s view of Sam.");
    expect(html).toContain('data-testid="person-tier-high-latency"');
  });

  it("Coverage parses core's real SQL rows, counts included", async () => {
    await holdRefund();
    const coverage = await read<CoverageView>("/api/coverage");
    expect(coverage).toEqual(world.h.core.coverage());
    expect(coverage.vendors).toEqual([expect.objectContaining({ vendor: "gate", source: "gate", calls: 1, held: 1, allowed: 0, denied: 0 })]);
    expect(renderToStaticMarkup(<CoverageTab data={coverage} nowMs={NOW} />)).toContain('data-testid="coverage-gate-gate-calls"');
  });

  it("Autonomy shows the level core stores", async () => {
    world.h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L2", NOW);
    const view = await read<AutonomyView>("/api/autonomy");
    expect(view.levels).toEqual(world.h.core.stores.autonomy.all());
    expect(renderToStaticMarkup(<AutonomyTab data={view} replay={async () => ({ replays: [] })} />)).toContain("refunds-agent");
  });

  it("Autonomy reads core's replay and human load, seeded history labelled as such", async () => {
    seedSyntheticHistory(world.h.core.stores.db, HISTORY_SEED, NOW);
    const view = await read<AutonomyView>("/api/autonomy");
    const report = world.h.core.autonomyReport();
    expect(view.evidence).toEqual(report.history);
    expect(view.evidence.synthetic).toBeGreaterThan(0);
    expect(view.human_load).toEqual(world.h.core.humanLoad());
    const replays = await world.h.core.autonomyReplay();
    expect(view.buckets.map((row) => row.counted)).toEqual(replays.map((row) => row.counted));
    expect(view.buckets.map((row) => row.synthetic_events)).toEqual(replays.map((row) => row.synthetic_events));
    expect(view.buckets.some((row) => row.synthetic_events > 0)).toBe(true);
    expect(renderToStaticMarkup(<AutonomyTab data={view} replay={async () => ({ replays: [] })} />)).toContain('data-testid="replay-table"');
  });

  it("A scope's replay is what core's own says, and it writes nothing", async () => {
    seedSyntheticHistory(world.h.core.stores.db, HISTORY_SEED, NOW);
    const [first] = (await read<AutonomyView>("/api/autonomy")).buckets;
    const before = world.h.core.stores.ledger.list().length;
    const res = await fetch(`${world.base}/api/autonomy/simulate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: first!.agent, class: first!.class, bucket: first!.bucket }) });
    expect(res.status).toBe(200);
    const { replays } = (await res.json()) as { replays: BucketReplay[] };
    const own = await world.h.core.autonomyReplay({ agent: first!.agent, class: first!.class, bucket: first!.bucket });
    expect(replays.map((row) => row.counted)).toEqual(own.map((row) => row.counted));
    expect(replays).toHaveLength(1);
    expect(world.h.core.stores.ledger.list()).toHaveLength(before);
  });

  it("Policy's hash comparison holds: the file on disk hashes to what core loaded", async () => {
    const view = await read<PolicyView>("/api/policy");
    expect(view.core_hash).toBe(world.h.core.health().policy_hash);
    expect(view.relation).toBe("same");
    expect(view.text).toBe(world.h.core.policyInfo().text);
    expect(renderToStaticMarkup(<PolicyTab data={view} simulate={async () => ({ decision: "hold", reason: "" })} />)).toContain("Core is enforcing this file");
  });
});

describe("real drills, sent the real way", () => {
  const DAY = 24 * 60 * MINUTE;
  const EVERY_READ = ["/api/health", "/api/queue", "/api/ledger", "/api/ledger/verify", "/api/export.csv", "/api/coverage", "/api/autonomy", "/api/people", "/api/people/sam", "/api/policy"];
  const snapshot = async () => Object.fromEntries(await Promise.all(EVERY_READ.map(async (path) => [path, await (await fetch(`${world.base}${path}`)).text()] as const)));

  const send = async (person = "sam"): Promise<string> => {
    const result = await world.h.core.sendDrill(person);
    if (!result.ok) throw new Error(result.reason);
    return result.requestId;
  };
  const cardFor = (requestId: string, roomId: string) => {
    const row = world.h.core.stores.routes.forRequest(requestId).find((entry) => entry.card_room === roomId)!;
    return world.h.chat.cards.find((card) => card.switchRequestId === row.switch_request_id)!;
  };
  const answer = (requestId: string, who: string, roomId: string, choice: "allow" | "deny") => {
    const card = cardFor(requestId, roomId);
    return world.h.core.onApprovalOutcome({ sessionId: card.sessionId, switchRequestId: card.switchRequestId, kind: "approval", state: "answered", answer: choice, answeredBy: who, answeredAtMs: world.h.clock.nowMs() });
  };

  it("while one is open, every route answers exactly as before, though core's own routes have all moved", async () => {
    await holdRefund();
    const before = await snapshot();
    const health = world.h.core.health();
    const raw = world.h.core.stores.ledger.list().length;
    const id = await send();

    expect(await snapshot()).toEqual(before);
    // The things that would have given it away are really there, so the test above is testing something.
    expect(world.h.core.stores.ledger.list().length).toBeGreaterThan(raw);
    expect(world.h.core.stores.ledger.list().map((entry) => entry.type)).toContain("drill_sent");
    expect(world.h.core.inbox("sam")!.items.map((item) => item.request_id)).toContain(id);
    expect(world.h.core.describeRequest(id)).not.toHaveProperty("is_drill");
    expect(world.h.core.health().open_requests).toBe(health.open_requests);
  });

  it("holds back a real request that arrives during one, then brings it back", async () => {
    const id = await send();
    const real = await world.h.core.check(gateRefund(REFUND_SC4));
    expect(real.decision).toBe("hold");
    expect((await read<QueueView>("/api/queue")).requests).toEqual([]);
    expect(world.h.core.health().open_requests).toBe(1);

    await answer(id, PARTICIPANTS.sam, "dm-sam", "deny");
    expect(world.h.core.describeRequest(id)?.state).toBe("DENIED");
    expect((await read<QueueView>("/api/queue")).requests.map((item) => item.id)).toEqual([real.request_id]);
  });

  it("keeps the numbers whole while it is open, then shows every real entry and none of the drill's", async () => {
    await holdRefund();
    const id = await send();
    await world.h.core.check(gateRefund(REFUND_SC4));
    const during = (await read<LedgerView>("/api/ledger")).entries.map((entry) => entry.seq);
    expect(during).toEqual(Array.from({ length: during.length }, (_, index) => index + 1));

    await answer(id, PARTICIPANTS.sam, "dm-sam", "allow");
    const after = await read<LedgerView>("/api/ledger");
    const expected = world.h.core.stores.ledger.list().filter((entry) => !entry.type.startsWith("drill_") && entry.request_id !== id);
    expect(after.entries.map((entry) => entry.seq)).toEqual(expected.map((entry) => entry.seq));
    expect(JSON.stringify(after)).not.toMatch(/drill_/);
    expect(JSON.stringify(after)).not.toContain(id);
    expect(await (await fetch(`${world.base}/api/export.csv`)).text()).not.toContain(id);
  });

  it("goes back to moving once one expires unanswered", async () => {
    const id = await send();
    const real = await world.h.core.check(gateRefund(REFUND_SC4));
    world.h.clock.advance(26 * MINUTE);
    await world.h.core.tick();
    expect(world.h.core.describeRequest(id)?.state).toBe("EXPIRED");
    expect(JSON.stringify(await read<LedgerView>("/api/ledger"))).toContain(real.request_id!);
  });

  it("goes back to moving once one is cancelled, which writes no result", async () => {
    const id = await send();
    await world.h.core.check(gateRefund(REFUND_SC4));
    expect(await world.h.core.cancel(id, null)).toBe("cancelled");
    expect(world.h.core.stores.ledger.list({ requestId: id }).map((entry) => entry.type)).not.toContain("drill_result");
    expect((await read<QueueView>("/api/queue")).requests).toHaveLength(1);
  });

  it("gives the team the same totals as the mirror, and the person's own result only on the admin's view", async () => {
    const results = () => world.h.core.stores.ledger.list().filter((entry) => entry.type === "drill_result").map((entry) => String(entry.payload.result));
    const words = async () => {
      const { team } = await read<PeopleView>("/api/people");
      return team.drills;
    };

    await answer(await send(), PARTICIPANTS.sam, "dm-sam", "deny");
    expect((await words()).finished).toBe(0);
    expect(drillTotals(results())).toContain("Totals appear once 3 have finished");

    world.h.clock.advance(DAY + MINUTE);
    await answer(await send(), PARTICIPANTS.sam, "dm-sam", "allow");
    expect((await words()).finished).toBe(0);
    const afterMiss = await read<PersonDetail>("/api/people/sam");
    expect(afterMiss.stats.friction).toBe("drill_miss");
    expect(renderToStaticMarkup(<PersonRecord data={afterMiss} />)).toContain("after a missed drill");
    expect(JSON.stringify(await read<PeopleView>("/api/people"))).not.toContain("drill_miss");

    world.h.clock.advance(DAY + MINUTE);
    await send();
    world.h.clock.advance(26 * MINUTE);
    await world.h.core.tick();
    const { finished, caught, missed, expired, group } = await words();
    expect(drillTotals(results())).toContain(`${finished} finished: ${caught} caught, ${missed} missed, ${expired} not answered. Totals move in steps of ${group}`);
    expect(finished).toBe(3);

    const sam = await read<PersonDetail>("/api/people/sam");
    expect(sam.stats.drills).toEqual({ caught: 1, missed: 1, expired: 1, catch_rate: 0.5 });
  });

  it("does not count a drill in Coverage, human load or the replay, even after it closes", async () => {
    const coverage = await read<CoverageView>("/api/coverage");
    const { human_load: load, buckets } = await read<AutonomyView>("/api/autonomy");
    await answer(await send(), PARTICIPANTS.sam, "dm-sam", "deny");
    expect(await read<CoverageView>("/api/coverage")).toEqual(coverage);
    const after = await read<AutonomyView>("/api/autonomy");
    expect(after.human_load).toEqual(load);
    expect(after.buckets).toEqual(buckets);
  });
});

describe("the simulator on real core", () => {
  const simulate = (body: string) => fetch(`${world.base}/api/policy/simulate`, { method: "POST", headers: { "content-type": "application/json" }, body });

  it.each(Object.keys(SIMULATOR_PRESETS))("the %s example is a call core accepts, and it records nothing", async (key) => {
    const before = world.h.core.stores.ledger.list().length;
    const res = await simulate(presetAction(key));
    expect(res.status, await res.clone().text()).toBe(200);
    const result = (await res.json()) as SimulationResult;
    expect(result.decision).toBe("hold");
    expect(result.tier).toBeTruthy();
    expect(world.h.core.stores.ledger.list()).toHaveLength(before);
    expect(world.h.core.health().open_requests).toBe(0);
  });

  it("the refund example shows the flags and tier the policy really gives", async () => {
    const result = (await (await simulate(presetAction("refund"))).json()) as SimulationResult;
    expect(result.class).toBe("refund");
    expect(result.tier).toBe("critical");
    expect(result.flags?.map((flag) => flag.code)).toEqual(expect.arrayContaining(["amount_vs_order", "new_destination"]));
  });

  it("explains a call core refuses", async () => {
    const res = await simulate(JSON.stringify({ nope: true }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error.length).toBeGreaterThan(0);
  });
});

describe("auth, the real way", () => {
  it("a wrong token gets core's real 401, shown as a refusal", async () => {
    const address = world.app.server.address() as AddressInfo;
    const wrong = createDeskServer({ core: httpCore({ url: `http://127.0.0.1:${address.port}`, token: "wrong" }), synthetic: false, distDir: resolve(REPO, "packages/desk/dist"), policyPath: POLICY, teamPath: TEAM });
    await new Promise<void>((done) => wrong.listen(0, "127.0.0.1", done));
    const res = await fetch(`http://127.0.0.1:${(wrong.address() as AddressInfo).port}/api/queue`);
    wrong.closeAllConnections();
    await new Promise((done) => wrong.close(done));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("core_refused");
  });
});

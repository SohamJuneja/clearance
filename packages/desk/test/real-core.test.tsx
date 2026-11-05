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
import { actionId, chatMessage, gateRefund, makeHarness, MINUTE, NOW, PARTICIPANTS, REFUND_SC3, TEAM_ALEX_ONLY_PATH, type Harness } from "../../core/test/harness";
import { httpCore } from "../src/server/core-source";
import { createDeskServer } from "../src/server/server";
import type { AutonomyView, CoverageView, Health, LedgerVerification, LedgerView, PeopleView, PolicyView, QueueView, SimulationResult } from "../src/shared/api";
import { AutonomyTab, CoverageTab, LedgerTab, PeopleTab, PolicyTab, QueueTab, SIMULATOR_PRESETS, presetAction } from "../src/web/views";

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
    expect(queue).toEqual({ open_count: 0, requests: [], disagreement: null });
  });

  it("shows a held request exactly as core describes it", async () => {
    const id = await holdRefund();
    const queue = await read<QueueView>("/api/queue");
    const described = world.h.core.describeRequest(id) as Record<string, unknown>;

    expect(queue.open_count).toBe(world.h.core.health().open_requests);
    expect(queue.open_count).toBe(1);
    expect(queue.disagreement).toBeNull();
    const [item] = queue.requests;
    expect(item).toMatchObject({
      id,
      state: described.state,
      class: "refund",
      tier: described.tier,
      score: described.score,
      headline: "REFUND ₹40,000",
      agent: "refunds-agent",
      vendor: "Claude Code",
      asked_by: ["Priya"],
      quorum_required: described.quorum_required,
      created_at: described.created_at,
      expires_at: described.expires_at,
      escalation: { fired: 0, of: 3, last: null },
    });
    expect(item!.flags).toEqual(described.flags);
    expect(item!.flags.map((flag) => flag.code)).toEqual(expect.arrayContaining(["amount_vs_order", "new_destination"]));
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
    expect(await read<QueueView>("/api/queue")).toEqual({ open_count: 0, requests: [], disagreement: null });
  });

  it("drops an approved request too, after it ran", async () => {
    await holdRefund();
    await press(world, "dm-sam", PARTICIPANTS.sam, "allow");
    expect(await read<QueueView>("/api/queue")).toEqual({ open_count: 0, requests: [], disagreement: null });
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
    expect(html).toContain("REFUND ₹40,000");
    expect(html).toContain("Amount is 10x the order total");
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
    expect(verify).toEqual(world.h.core.verifyLedger());
    expect(verify.ok).toBe(true);
    expect(verify.count).toBe(direct.length);
    expect(ledger.names.sam).toBe("Sam");

    const html = renderToStaticMarkup(<LedgerTab data={ledger} verify={verify} />);
    expect(html).toContain(`Chain intact · ${verify.count} entries`);
    expect(html).toContain("To Sam");
    expect(html).toContain("Sam: deny");
  });

  it("serves core's real CSV", async () => {
    await holdRefund();
    const res = await fetch(`${world.base}/api/export.csv`);
    expect(res.status).toBe(200);
    expect((await res.text()).split("\n")[0]).toBe("seq,at,type,request_id,payload,prev_hash,entry_hash");
  });
});

describe("the other tabs on real core", () => {
  it("Health is core's own", async () => {
    expect(await read<Health>("/api/health")).toEqual(world.h.core.health());
  });

  it("People shows core's stats, for everyone in team.yaml", async () => {
    await holdRefund();
    await press(world, "dm-sam", PARTICIPANTS.sam, "deny");
    const { people } = await read<PeopleView>("/api/people");
    expect(people.map((person) => person.id)).toEqual(["priya", "sam", "neha", "alex", "dev"]);
    for (const person of people) expect(person.stats, person.id).toEqual(world.h.core.personStats(person.id));
    expect(people.find((person) => person.id === "sam")!.stats).toMatchObject({ answers: 1, denials: 1 });
    expect(renderToStaticMarkup(<PeopleTab data={{ people }} nowMs={NOW} />)).toContain("Sam");
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
    expect(renderToStaticMarkup(<AutonomyTab data={view} />)).toContain("refunds-agent");
  });

  it("Policy's hash comparison holds: the file on disk hashes to what core loaded", async () => {
    const view = await read<PolicyView>("/api/policy");
    expect(view.core_hash).toBe(world.h.core.health().policy_hash);
    expect(view.matches).toBe(true);
    expect(renderToStaticMarkup(<PolicyTab data={view} simulate={async () => ({ decision: "hold", reason: "" })} />)).toContain("Core is enforcing this file");
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
    expect(result.tier).toBe("high");
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

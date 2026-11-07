/** The HTTP API (PLAN 6.7), through Fastify's inject. /v1/hooks/* comes from @clearance/adapters. */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { HISTORY_SEED, seedSyntheticHistory } from "../src/autonomy/history.js";
import { systemClock } from "../src/clock.js";
import { chatMessage, gateRefund, hookShell, makeHarness, MINUTE, PARTICIPANTS, REFUND_SC3, REFUND_SC4, type Harness } from "./harness.js";

const TOKEN = "test-internal-token";
const auth = { authorization: `Bearer ${TOKEN}` };

let h: Harness;
let app: FastifyInstance;

beforeEach(async () => {
  h = makeHarness();
  app = buildServer(h.core, { internalToken: TOKEN });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  h.core.close();
});

const check = (action: unknown) => app.inject({ method: "POST", url: "/v1/check", headers: auth, payload: { action } });
const get = (url: string) => app.inject({ method: "GET", url, headers: auth });

describe("bearer auth", () => {
  const routes: { method: "GET" | "POST"; url: string }[] = [
    { method: "POST", url: "/v1/check" },
    { method: "POST", url: "/v1/refused" },
    { method: "GET", url: "/v1/health" },
    { method: "GET", url: "/v1/requests/CLR-0001" },
    { method: "POST", url: "/v1/requests/CLR-0001/cancel" },
    { method: "GET", url: "/v1/inbox?user=sam" },
    { method: "GET", url: "/v1/ledger" },
    { method: "GET", url: "/v1/ledger/verify" },
    { method: "GET", url: "/v1/export.csv" },
    { method: "GET", url: "/v1/people/sam/stats" },
    { method: "GET", url: "/v1/requests?state=open" },
    { method: "GET", url: "/v1/people" },
    { method: "GET", url: "/v1/policy" },
    { method: "GET", url: "/v1/metrics/human-load" },
    { method: "GET", url: "/v1/digest" },
    { method: "GET", url: "/v1/roi" },
    { method: "GET", url: "/v1/shadow" },
    { method: "GET", url: "/v1/autonomy" },
    { method: "POST", url: "/v1/autonomy/simulate" },
    { method: "POST", url: "/v1/policy/simulate" },
    { method: "GET", url: "/v1/coverage" },
  ];

  it.each(routes)("$method $url refuses a missing token", async ({ method, url }) => {
    expect((await app.inject({ method, url })).statusCode).toBe(401);
  });

  it.each(routes)("$method $url refuses a wrong token", async ({ method, url }) => {
    const response = await app.inject({ method, url, headers: { authorization: "Bearer nope" } });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a token of a different length without throwing", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/health", headers: { authorization: "Bearer x" } });
    expect(response.statusCode).toBe(401);
  });

  it("does not take a hook token: agents can read that one", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/health", headers: { authorization: "Bearer test-hook-token" } });
    expect(response.statusCode).toBe(401);
  });

  it("refuses to build without a token rather than serving open", () => {
    expect(() => buildServer(h.core, { internalToken: "" })).toThrow(/token/i);
  });

  it("does not put its bearer check on routes mounted beside it, which bring their own", async () => {
    const other = buildServer(h.core, { internalToken: TOKEN });
    other.post("/v1/hooks/claude", async () => ({ mounted: true }));
    await other.ready();
    const response = await other.inject({ method: "POST", url: "/v1/hooks/claude", payload: {} });
    expect(response.statusCode).toBe(200);
    await other.close();
  });
});

describe("POST /v1/refused: the gate refused a call outside the agent's role", () => {
  const refused = (payload: object) => app.inject({ method: "POST", url: "/v1/refused", headers: auth, payload });
  const action = () => ({ ...gateRefund(REFUND_SC4), agent: { name: "ops-agent" } });
  const body = () => ({ action: action(), class: "refund", reason: "ops-agent is not allowed to call refund actions." });

  it("puts it on the ledger and in the action log as a denial", async () => {
    const response = await refused(body());
    expect(response.statusCode).toBe(200);
    const row = h.core.stores.db
      .prepare("SELECT agent, class, decision, step, request_id FROM actions ORDER BY rowid DESC LIMIT 1")
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({ agent: "ops-agent", class: "refund", decision: "deny", step: "outside_role", request_id: null });
    const entries = h.core.stores.ledger.list().filter((entry) => entry.type === "denied");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.payload).toMatchObject({
      agent: "ops-agent",
      class: "refund",
      reason: "ops-agent is not allowed to call refund actions.",
    });
  });

  it("opens no request and shows no card, because there's nothing for a person to decide", async () => {
    await refused(body());
    expect(h.core.listRequests()).toEqual([]);
  });

  it("needs the internal token", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/refused", payload: body() });
    expect(response.statusCode).toBe(401);
  });

  it("answers 400 to a body it can't read", async () => {
    expect((await refused({ class: "refund" })).statusCode).toBe(400);
    expect((await refused({ ...body(), reason: "" })).statusCode).toBe(400);
  });

  it("records one refusal once, however often the same action is sent", async () => {
    const payload = body();
    await refused(payload);
    await refused(payload);
    const { n } = h.core.stores.db.prepare("SELECT COUNT(*) AS n FROM actions").get() as { n: number };
    expect(n).toBe(1);
  });
});

describe("POST /v1/check", () => {
  it("returns the decision in the contract's shape", async () => {
    const response = await check(gateRefund(REFUND_SC4));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      decision: "hold",
      request_id: "CLR-0001",
      class: "refund",
      tier: "high",
      score: 55,
    });
    expect(response.json().reason).toMatch(/^HELD CLR-0001: refunds over ₹10,000 need finance approval\./);
    expect(response.json().call_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("answers 400 to a body that is not a CheckRequest, which the gate treats as fail closed", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/check", headers: auth, payload: { nonsense: true } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBeTruthy();
  });

  it("answers 200 allow for a safe call", async () => {
    const response = await check(hookShell("git status"));
    expect(response.json()).toMatchObject({ decision: "allow" });
  });

  it("answers 200 deny with the reason for a protected path", async () => {
    const response = await check(hookShell("docker ps"));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ decision: "deny", class: "protected_config" });
  });
});

describe("GET /v1/requests/:id", () => {
  it("returns state and evidence at the top level, as the gate reads it", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    await check(gateRefund(REFUND_SC3));
    const response = await get("/v1/requests/CLR-0001");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      id: "CLR-0001",
      state: "ROUTED",
      class: "refund",
      tier: "medium",
      agent: "refunds-agent",
      origin_room: "#support",
      origin_thread: "t-77",
      quorum_required: 1,
      approvals: [],
    });
    expect(body.call_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.flags.map((flag: { code: string }) => flag.code)).toContain("new_destination");
    expect(body.evidence.extracted.amount).toBe(4000);
    expect(body.expires_at).toBe(new Date(h.core.stores.requests.require("CLR-0001").expiresAtMs).toISOString());
  });

  it("answers 404 for a request that does not exist", async () => {
    expect((await get("/v1/requests/CLR-9999")).statusCode).toBe(404);
  });
});

describe("POST /v1/requests/:id/cancel", () => {
  it("cancels an open request, closes its cards and tells the agent", async () => {
    await check(gateRefund(REFUND_SC4));
    const response = await app.inject({
      method: "POST",
      url: "/v1/requests/CLR-0001/cancel",
      headers: auth,
      payload: { by: "refunds-agent" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "CLR-0001", state: "CANCELLED" });
    expect(h.core.stores.ledger.list({ requestId: "CLR-0001" }).at(-1)).toMatchObject({
      type: "cancelled",
      payload: { by: "refunds-agent" },
    });
    expect(h.chat.openCards()).toEqual([]);
    expect(h.chat.targeted.at(-1)?.body).toBe("CLR-0001 was cancelled. Nothing was executed.");
    expect(h.core.stores.aggregates.sum("refund", "customer", "cus_2044", 0)).toBe(0);
  });

  it("answers 409 for a request already decided, and leaves it alone", async () => {
    await check(gateRefund(REFUND_SC4));
    await h.core.onApprovalOutcome({
      sessionId: h.chat.cardIn("dm-sam").sessionId,
      switchRequestId: h.chat.cardIn("dm-sam").switchRequestId,
      kind: "approval",
      state: "answered",
      answer: "deny",
      answeredBy: PARTICIPANTS.sam,
    });
    const response = await app.inject({ method: "POST", url: "/v1/requests/CLR-0001/cancel", headers: auth, payload: {} });
    expect(response.statusCode).toBe(409);
    expect(h.core.stores.requests.require("CLR-0001").state).toBe("DENIED");
  });

  it("answers 404 for a request that does not exist", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/requests/CLR-9999/cancel", headers: auth, payload: {} });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /v1/inbox", () => {
  it("lists a person's open requests across rooms, newest first", async () => {
    await check(gateRefund(REFUND_SC4));
    h.clock.advance(2 * MINUTE);
    await check(gateRefund({ ...REFUND_SC4, amount: 50000 }, { session: { switchRoomId: "#finance" } }));
    h.clock.advance(40_000);
    const body = (await get("/v1/inbox?user=sam")).json();
    expect(body.user).toBe("sam");
    expect(body.count).toBe(2);
    expect(body.items.map((item: { request_id: string }) => item.request_id)).toEqual(["CLR-0002", "CLR-0001"]);
    expect(body.items[0]).toMatchObject({
      what: "refund ₹50,000",
      room: "#finance",
      age_s: 40,
      class: "refund",
      tier: "high",
    });
    expect(body.text).toBe(
      "Needs your response (2) · CLR-0002 refund ₹50,000 · #finance · 40 s · CLR-0001 refund ₹40,000 · #support · 2 min",
    );
  });

  it("shows nothing for someone with no open cards", async () => {
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    await check(gateRefund(REFUND_SC4));
    const body = (await get("/v1/inbox?user=neha")).json();
    expect(body).toMatchObject({ count: 0, items: [], text: "Needs your response (0)" });
  });

  it("drops a request once it is decided", async () => {
    await check(gateRefund(REFUND_SC4));
    await h.core.onApprovalOutcome({
      sessionId: h.chat.cardIn("dm-sam").sessionId,
      switchRequestId: h.chat.cardIn("dm-sam").switchRequestId,
      kind: "approval",
      state: "answered",
      answer: "allow",
      answeredBy: PARTICIPANTS.sam,
    });
    expect((await get("/v1/inbox?user=sam")).json().count).toBe(0);
  });

  it("answers 400 without a user and 404 for someone unknown", async () => {
    expect((await get("/v1/inbox")).statusCode).toBe(400);
    expect((await get("/v1/inbox?user=nobody")).statusCode).toBe(404);
  });

  it("shows Switch's handle when one is known, and works from the CLR id when not", async () => {
    h.chat.giveHandles = true;
    await check(gateRefund(REFUND_SC4));
    const body = (await get("/v1/inbox?user=sam")).json();
    expect(body.items[0].handle).toBe("A1");
    expect(body.text).toBe("Needs your response (1) · A1 CLR-0001 refund ₹40,000 · #support · 0 s");
  });

  it("answers @clearance inbox in the room", async () => {
    await check(gateRefund(REFUND_SC4));
    await h.core.onMessage(chatMessage(PARTICIPANTS.sam, "@clearance inbox", { roomId: "#finance", threadId: null, addressed: true }));
    expect(h.chat.messages.at(-1)).toEqual({
      roomId: "#finance",
      body: "**Needs your response (1)**\nCLR-0001 refund ₹40,000 · #support · 0 s\nAnswer in your direct room with Clearance.",
    });
  });
});

describe("ledger routes", () => {
  it("GET /v1/ledger pages and filters by request", async () => {
    await check(gateRefund(REFUND_SC4));
    const all = (await get("/v1/ledger")).json();
    expect(all.entries.map((entry: { type: string }) => entry.type)).toEqual(["policy_loaded", "held", "routed"]);
    expect((await get("/v1/ledger?request_id=CLR-0001")).json().entries).toHaveLength(2);
    expect((await get("/v1/ledger?after=2")).json().entries.map((entry: { seq: number }) => entry.seq)).toEqual([3]);
    expect((await get("/v1/ledger?limit=1")).json().entries).toHaveLength(1);
  });

  it("GET /v1/ledger/verify reports the chain", async () => {
    await check(gateRefund(REFUND_SC4));
    const body = (await get("/v1/ledger/verify")).json();
    expect(body).toMatchObject({ ok: true, count: 3 });
    expect(body.head).toMatch(/^[0-9a-f]{64}$/);
  });

  it("GET /v1/export.csv?kind=ledger is CSV with one quoted row per entry", async () => {
    await check(gateRefund(REFUND_SC4));
    const response = await get("/v1/export.csv?kind=ledger");
    expect(response.headers["content-type"]).toContain("text/csv");
    const lines = response.body.trim().split("\n");
    expect(lines[0]).toBe("seq,at,type,request_id,payload,prev_hash,entry_hash");
    expect(lines).toHaveLength(4);
    expect(lines[2]).toMatch(/^2,"[^"]+","held","CLR-0001","\{.*\}","[0-9a-f]{64}","[0-9a-f]{64}"$/);
    expect(lines[2]).toContain('""class"":""refund""');
  });
});

describe("other reads", () => {
  it("GET /v1/health is what the gate's fail-closed check uses", async () => {
    const response = await get("/v1/health");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, policy_hash: h.core.policy().hash, policy_error: null, open_requests: 0 });
  });

  it("GET /v1/people/:id/stats reports real answers", async () => {
    await check(gateRefund(REFUND_SC4));
    h.clock.advance(4_000);
    const card = h.chat.cardIn("dm-sam");
    await h.core.onApprovalOutcome({
      sessionId: card.sessionId,
      switchRequestId: card.switchRequestId,
      kind: "approval",
      state: "answered",
      answer: "allow",
      answeredBy: PARTICIPANTS.sam,
    });
    const body = (await get("/v1/people/sam/stats")).json();
    expect(body).toMatchObject({ user: "sam", answers: 1, approvals: 1, denials: 0, ineligible: 0, median_latency_ms: 4000, open_cards: 0 });
    expect((await get("/v1/people/nobody/stats")).statusCode).toBe(404);
  });

  it("GET /v1/requests?state=open lists what is open, and no drills", async () => {
    const held = (await check(gateRefund(REFUND_SC4))).json();
    await h.core.sendDrill("sam");
    const body = (await get("/v1/requests?state=open")).json();
    expect(body.requests.map((request: { id: string }) => request.id)).toEqual([held.request_id]);
    expect(body.requests[0]).toMatchObject({ state: "ROUTED", class: "refund", tier: "high" });
  });

  it("GET /v1/requests filters by exact state, and refuses one that doesn't exist", async () => {
    await check(gateRefund(REFUND_SC4));
    expect((await get("/v1/requests?state=EXECUTED")).json().requests).toEqual([]);
    expect((await get("/v1/requests?state=ROUTED")).json().requests).toHaveLength(1);
    expect((await get("/v1/requests")).json().requests).toHaveLength(1);
    expect((await get("/v1/requests?state=SIDEWAYS")).statusCode).toBe(400);
  });

  it("GET /v1/people lists the team and who is away", async () => {
    h.core.people.store.setAway("neha", h.clock.nowMs() + 60 * MINUTE, "sam");
    const { people } = (await get("/v1/people")).json();
    expect(people.map((person: { id: string }) => person.id)).toEqual(["priya", "sam", "neha", "alex", "dev"]);
    expect(people.find((person: { id: string }) => person.id === "sam")).toMatchObject({ name: "Sam", groups: ["finance"], roles: ["finance-approver"], away: null });
    expect(people.find((person: { id: string }) => person.id === "neha").away).toMatchObject({ delegate_to: "sam" });
  });

  it("GET /v1/policy gives the hash in force, the same one /v1/health gives, and its text", async () => {
    const policy = (await get("/v1/policy")).json();
    expect(policy.hash).toBe((await get("/v1/health")).json().policy_hash);
    expect(policy).toMatchObject({ mode: "enforce", error: null, shadow_would_hold: 0 });
    expect(policy.text).toContain("classes:");
    expect(policy.classes).toEqual(expect.arrayContaining(["refund", "deploy"]));
  });

  describe("GET /v1/metrics/human-load", () => {
    it("has nothing to divide before there is traffic", async () => {
      expect((await get("/v1/metrics/human-load")).json()).toMatchObject({ agent_actions: 0, human_decisions: 0, per_100: null, by_class: [] });
    });

    it("counts people's real decisions per 100 agent actions, safe work included, and says the rate on governed work too", async () => {
      await check(hookShell("ls a"));
      await check(hookShell("ls b"));
      await check(hookShell("ls c"));
      const held = (await check(gateRefund(REFUND_SC4))).json();
      await h.core.onApprovalOutcome({
        sessionId: h.chat.cardIn("dm-sam").sessionId,
        switchRequestId: h.chat.cardIn("dm-sam").switchRequestId,
        kind: "approval",
        state: "answered",
        answer: "allow",
        answeredBy: PARTICIPANTS.sam,
        answeredAtMs: h.clock.nowMs(),
      });
      expect(held.decision).toBe("hold");
      const body = (await get("/v1/metrics/human-load")).json();
      expect(body).toMatchObject({ agent_actions: 4, governed_actions: 1, human_decisions: 1, per_100: 25, per_100_governed: 100 });
      expect(body.by_class).toEqual([expect.objectContaining({ class: "refund", agent_actions: 1, human_decisions: 1, per_100: 100 })]);
    });

    it("leaves drills and refused answers out", async () => {
      await h.core.sendDrill("sam");
      const card = h.chat.cards.at(-1) as (typeof h.chat.cards)[number];
      await h.core.onApprovalOutcome({
        sessionId: card.sessionId,
        switchRequestId: card.switchRequestId,
        kind: "approval",
        state: "answered",
        answer: "deny",
        answeredBy: PARTICIPANTS.sam,
        answeredAtMs: h.clock.nowMs(),
      });
      expect((await get("/v1/metrics/human-load")).json()).toMatchObject({ human_decisions: 0 });
    });
  });

  it("GET /v1/people/:id/stats shows the rubber-stamp signals and drills by name", async () => {
    const body = (await get("/v1/people/sam/stats")).json();
    expect(body).toMatchObject({ fast_approvals: 0, flags_ignored: 0, batch_approvals: 0, by_tier: {}, drills: { sent: 0, caught: 0, missed: 0 } });
  });

  it("GET /v1/autonomy reports the ladder", async () => {
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L2", h.clock.nowMs());
    const body = (await get("/v1/autonomy")).json();
    expect(body.levels).toEqual([expect.objectContaining({ agent: "refunds-agent", class: "refund", bucket: "small", level: "L2" })]);
  });

  it("POST /v1/autonomy/simulate replays the rule over history, labelled, and writes nothing", async () => {
    seedSyntheticHistory(h.core.stores.db, HISTORY_SEED, h.clock.nowMs());
    const before = h.core.stores.ledger.list().length;
    const response = await app.inject({ method: "POST", url: "/v1/autonomy/simulate", headers: auth, payload: { agent: "refunds-agent", class: "refund" } });
    expect(response.statusCode).toBe(200);
    const { replays } = response.json();
    expect(replays).toHaveLength(1);
    expect(replays[0]).toMatchObject({ agent: "refunds-agent", class: "refund", bucket: "small", meets_criteria: true, proposed_level: "L2", real_events: 0, would_auto_denied: 0 });
    expect(replays[0].synthetic_events).toBeGreaterThan(90);
    expect(h.core.stores.ledger.list()).toHaveLength(before);
  });

  it("POST /v1/autonomy/simulate refuses what it doesn't understand", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/autonomy/simulate", headers: auth, payload: { agnet: "x" } });
    expect(response.statusCode).toBe(400);
  });

  it("GET /v1/autonomy says how much of the history is synthetic", async () => {
    seedSyntheticHistory(h.core.stores.db, HISTORY_SEED, h.clock.nowMs());
    const body = (await get("/v1/autonomy")).json();
    expect(body.history.real).toBe(0);
    expect(body.history.synthetic).toBeGreaterThan(120);
    expect(body.buckets.map((row: { class: string }) => row.class)).toEqual(expect.arrayContaining(["refund", "deploy", "customer_email"]));
  });

  it("POST /v1/policy/simulate classifies a call and records nothing", async () => {
    const before = h.core.stores.ledger.list().length;
    const response = await app.inject({
      method: "POST",
      url: "/v1/policy/simulate",
      headers: auth,
      payload: { action: gateRefund(REFUND_SC4) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ decision: "hold", class: "refund", tier: "high", score: 55, step: "class_hold" });
    expect(h.core.stores.ledger.list()).toHaveLength(before);
    expect(h.chat.cards).toEqual([]);
    expect(h.core.stores.db.prepare(`SELECT COUNT(*) AS n FROM actions`).get()).toEqual({ n: 0 });
  });

  it("POST /v1/policy/simulate answers 400 to a bad body", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/policy/simulate", headers: auth, payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("GET /v1/coverage counts what each vendor actually sent", async () => {
    await check(hookShell("git status", { vendor: "codex" }));
    await check(hookShell("rm -rf /", { vendor: "codex" }));
    await check(gateRefund(REFUND_SC4));
    const body = (await get("/v1/coverage")).json();
    const codex = body.vendors.find((row: { vendor: string }) => row.vendor === "codex");
    expect(codex).toMatchObject({ source: "hook", calls: 2, allowed: 1, held: 1, denied: 0 });
    expect(body.vendors.find((row: { vendor: string }) => row.vendor === "gate")).toMatchObject({ source: "gate", calls: 1, held: 1 });
  });
});

describe("core public surface", () => {
  it("resolves an agent from a hook's cwd, and null is never an allow", () => {
    expect(h.core.resolveAgent("/nowhere/at/all")).toBeNull();
  });

  it("offers a real clock that scales policy durations", () => {
    const clock = systemClock(10);
    expect(clock.scaledMs(600_000)).toBe(60_000);
    expect(Math.abs(clock.nowMs() - Date.now())).toBeLessThan(1000);
    expect(systemClock(1).scaledMs(600_000)).toBe(600_000);
    expect(() => systemClock(0)).toThrow();
  });
});

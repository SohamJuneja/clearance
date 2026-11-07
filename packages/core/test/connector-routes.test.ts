/**
 * The read-only connector's routes (packages/mcp-connector): pending, explain, the team's ledger and the dry run. They sit
 * behind the internal token, which agents never hold, so an agent's hook token and gate token are refused even where the
 * hook token is live. The dry run writes nothing at all, and says what a real check then does.
 */
import { hookRoutes } from "@clearance/adapters";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { OPERATION_NAMES } from "../src/connector/dry-run.js";
import { chatMessage, gateRefund, makeHarness, PARTICIPANTS, REFUND_SC4, WORLD, type Harness } from "./harness.js";

const TOKEN = "test-internal-token";
const auth = { authorization: `Bearer ${TOKEN}` };
/** coder's own hook token, live on /v1/hooks/claude below. Agents can read this one. */
const HOOK_TOKEN = "coder-hook-token-for-the-connector-test";
/** What an agent holds for the gate (GATE_AGENT_TOKENS). Core never sees these as anything but a stranger's. */
const GATE_TOKEN = "refunds-agent-gate-token-for-the-connector-test";

let h: Harness;
let app: FastifyInstance;

beforeEach(async () => {
  h = makeHarness();
  app = buildServer(h.core, { internalToken: TOKEN });
  await app.register(async (scope) => {
    await hookRoutes(scope, {
      check: (action) => h.core.check(action),
      resolveAgent: (cwd, agentType) => h.core.resolveAgent(cwd, agentType),
      hookTokens: { [HOOK_TOKEN]: "coder" },
    });
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  h.core.close();
});

const get = (url: string) => app.inject({ method: "GET", url, headers: auth });
const dryRun = (payload: unknown) => app.inject({ method: "POST", url: "/v1/dry-run", headers: auth, payload: payload as Record<string, unknown> });
const askedForRefund = () => h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
const say = (who: string, body: string) => h.core.onMessage(chatMessage(who, body, { roomId: "#approvals", threadId: null, addressed: true }));

/** Every row of every table, so an update shows as surely as an insert. */
function everything(): Record<string, unknown[]> {
  const { db } = h.core.stores;
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
}
const outside = () => ({
  cards: h.chat.cards.length,
  messages: h.chat.messages.length,
  targeted: h.chat.targeted.length,
  documents: h.chat.documents.length,
  executes: h.gate.calls.length,
});

describe("auth: the connector's routes take only the internal token", () => {
  const routes: { method: "GET" | "POST"; url: string; payload?: Record<string, unknown> }[] = [
    { method: "GET", url: "/v1/pending" },
    { method: "GET", url: "/v1/pending?person=sam" },
    { method: "GET", url: "/v1/requests/CLR-0001/explain" },
    { method: "GET", url: "/v1/ledger/team" },
    { method: "POST", url: "/v1/dry-run", payload: { shell: "git push --force origin main" } },
    { method: "POST", url: "/v1/dry-run", payload: { operation: "refund", args: REFUND_SC4 } },
  ];

  it("the hook token used below is a real one: coder's hook call with it goes through", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/hooks/claude",
      headers: { authorization: `Bearer ${HOOK_TOKEN}`, "content-type": "application/json" },
      payload: JSON.stringify({ hook_event_name: "PreToolUse", agent_type: "coder", tool_name: "Bash", tool_input: { command: "ls" } }),
    });
    expect(response.statusCode).toBe(200);
  });

  it.each(routes)("$method $url refuses an agent's hook token", async ({ method, url, payload }) => {
    const response = await app.inject({ method, url, headers: { authorization: `Bearer ${HOOK_TOKEN}` }, ...(payload ? { payload } : {}) });
    expect(response.statusCode).toBe(401);
  });

  it.each(routes)("$method $url refuses an agent's gate token", async ({ method, url, payload }) => {
    const response = await app.inject({ method, url, headers: { authorization: `Bearer ${GATE_TOKEN}` }, ...(payload ? { payload } : {}) });
    expect(response.statusCode).toBe(401);
  });

  it.each(routes)("$method $url refuses no token at all", async ({ method, url, payload }) => {
    expect((await app.inject({ method, url, ...(payload ? { payload } : {}) })).statusCode).toBe(401);
  });

  it("a refused dry run never reaches the policy: nothing is looked up and nothing is written", async () => {
    const before = everything();
    await app.inject({ method: "POST", url: "/v1/dry-run", headers: { authorization: `Bearer ${HOOK_TOKEN}` }, payload: { operation: "refund", args: REFUND_SC4 } });
    expect(h.lookup.calls).toEqual([]);
    expect(everything()).toEqual(before);
  });

  it("there is no route to approve, deny or answer a card: only Switch's own approval_outcome counts", async () => {
    await askedForRefund();
    const held = await h.core.check(gateRefund(REFUND_SC4));
    for (const verb of ["approve", "deny", "answer", "decide"]) {
      const response = await app.inject({ method: "POST", url: `/v1/requests/${held.request_id as string}/${verb}`, headers: auth, payload: { by: "sam" } });
      expect(response.statusCode).toBe(404);
    }
    expect(h.core.stores.requests.get(held.request_id as string)?.state).toBe("ROUTED");
  });
});

describe("POST /v1/dry-run", () => {
  it("writes nothing for a held refund, a held push, an allowed line and a denied one", async () => {
    // Something open already, so a dry run of the same call has a request to find, and must still not join it.
    await askedForRefund();
    await h.core.check(gateRefund(REFUND_SC4));
    const before = everything();
    const seen = outside();

    const answers = [
      await dryRun({ operation: "refund", args: REFUND_SC4, agent: "refunds-agent" }),
      await dryRun({ operation: "refund", args: { ...REFUND_SC4, amount: 150000 }, agent: "refunds-agent" }),
      await dryRun({ shell: "git push --force origin main", agent: "coder" }),
      await dryRun({ shell: "ls -la", agent: "coder" }),
      await dryRun({ shell: "cat .env", agent: "coder" }),
    ].map((response) => {
      expect(response.statusCode).toBe(200);
      return response.json();
    });

    expect(answers.map((answer) => answer.decision)).toEqual(["hold", "hold", "hold", "allow", "deny"]);
    expect(answers.every((answer) => answer.recorded === false)).toBe(true);
    expect(everything()).toEqual(before);
    expect(outside()).toEqual(seen);
  });

  it("says the decision, class, tier and who could decide, as a real check then does", async () => {
    await askedForRefund();
    const dry = (await dryRun({ operation: "refund", args: REFUND_SC4, agent: "refunds-agent" })).json();
    expect(dry).toMatchObject({ decision: "hold", class: "refund", tier: "high", agent: "refunds-agent", already_open: null, requested_by: ["Priya"] });
    expect(dry.can_decide).toEqual(expect.arrayContaining(["Sam", "Neha"]));
    expect(dry.can_decide).not.toContain("Priya");
    expect(dry.why).toContain("This call → rule refund");

    const real = await h.core.check(gateRefund(REFUND_SC4));
    expect(real).toMatchObject({ decision: "hold", class: "refund", tier: "high" });
    const explained = (await get(`/v1/requests/${real.request_id as string}/explain`)).json();
    expect(explained.can_decide).toEqual(dry.can_decide);
    expect(explained.quorum_required).toBe(dry.quorum_required);
    expect(explained.requested_by).toEqual(dry.requested_by);
    expect(dry.would_ask).toEqual(h.core.traces.latest(real.request_id as string)?.chosen.map((id) => h.core.people.directory.person(id)?.name));

    // Asked again, it finds the request a real call would join, and still makes nothing.
    const again = (await dryRun({ operation: "refund", args: REFUND_SC4, agent: "refunds-agent" })).json();
    expect(again.already_open).toBe(real.request_id);
  });

  it("fills a refund's customer and destination the way the gate does, so it asks about the same call", async () => {
    h.lookup.world = { ...WORLD, customers: { ...WORLD.customers, cus_2044: { ...WORLD.customers?.cus_2044, default_destination: REFUND_SC4.destination } } };
    const given = (await dryRun({ operation: "refund", args: REFUND_SC4, agent: "refunds-agent" })).json();
    const filled = (await dryRun({ operation: "refund", args: { order_id: REFUND_SC4.order_id, amount: REFUND_SC4.amount }, agent: "refunds-agent" })).json();
    expect(filled.call_hash).toBe(given.call_hash);
  });

  it("takes exactly the gate's operations, by the gate's own names", async () => {
    const { OPERATIONS } = await import("@clearance/gate");
    expect([...OPERATION_NAMES].sort()).toEqual(Object.keys(OPERATIONS).sort());
  });

  it("refuses what the gate would refuse before core is asked, an unknown agent, and a body that is neither kind", async () => {
    const extra = await dryRun({ operation: "refund", args: { ...REFUND_SC4, note: "smuggled" } });
    expect(extra.statusCode).toBe(400);
    expect(extra.json().error).toContain("note");
    expect((await dryRun({ operation: "refund", args: { ...REFUND_SC4, amount: "40000" } })).statusCode).toBe(400);
    expect((await dryRun({ operation: "launch_missiles", args: {} })).statusCode).toBe(400);
    expect((await dryRun({ shell: "ls", operation: "refund", args: REFUND_SC4 })).statusCode).toBe(400);
    expect((await dryRun({})).statusCode).toBe(400);
    const stranger = await dryRun({ shell: "ls", agent: "someone-else" });
    expect(stranger.statusCode).toBe(404);
    expect(stranger.json().error).toContain("refunds-agent");
  });
});

describe("GET /v1/requests/:id/explain", () => {
  it("gives the same why as `@clearance why`, with who asked, who can decide and why the others can't", async () => {
    await askedForRefund();
    const held = await h.core.check(gateRefund(REFUND_SC4));
    const id = held.request_id as string;
    await say(PARTICIPANTS.alex, `@clearance why ${id}`);
    const inChat = h.chat.messages.at(-1)?.body;

    const explained = (await get(`/v1/requests/${id.toLowerCase()}/explain`)).json();
    expect(explained.why).toBe(inChat);
    expect(explained).toMatchObject({ id, state: "ROUTED", class: "refund", tier: "high", agent: "refunds-agent", requested_by: ["Priya"], approved_by: [] });
    expect(explained.can_decide).toEqual(expect.arrayContaining(["Sam", "Neha"]));
    expect(explained.cannot_decide).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Priya" })]));
    expect(explained.hold_summary).toContain("finance approval");
    expect(explained.call.length).toBeGreaterThan(0);
    expect(explained).not.toHaveProperty("is_drill");
  });

  it("404s for a request nobody made", async () => {
    expect((await get("/v1/requests/CLR-9999/explain")).statusCode).toBe(404);
  });
});

describe("GET /v1/pending", () => {
  it("lists what is open with who can decide it, and leaves out someone else's drill", async () => {
    await askedForRefund();
    const held = await h.core.check(gateRefund(REFUND_SC4));
    const drill = await h.core.sendDrill("sam");
    expect(drill.ok).toBe(true);

    const all = (await get("/v1/pending")).json().requests;
    expect(all.map((request: { id: string }) => request.id)).toEqual([held.request_id]);
    expect(all[0]).toMatchObject({ class: "refund", tier: "high", requested_by: ["Priya"] });
    expect(all[0].can_decide).toEqual(expect.arrayContaining(["Sam", "Neha"]));

    const neha = (await get("/v1/pending?person=neha")).json().requests;
    expect(neha.map((request: { id: string }) => request.id)).toEqual([held.request_id]);
  });

  it("shows the person their own drill, looking like anything else, because their inbox does", async () => {
    await askedForRefund();
    const held = await h.core.check(gateRefund(REFUND_SC4));
    const drill = await h.core.sendDrill("sam");
    if (!drill.ok) throw new Error(drill.reason);

    const sam = (await get("/v1/pending?person=sam")).json().requests as Record<string, unknown>[];
    expect(sam.map((request) => request.id).sort()).toEqual([held.request_id, drill.requestId].sort());
    const real = sam.find((request) => request.id === held.request_id) as Record<string, unknown>;
    const practice = sam.find((request) => request.id === drill.requestId) as Record<string, unknown>;
    expect(Object.keys(practice).sort()).toEqual(Object.keys(real).sort());
    expect(practice.waiting_on_you).toBe(true);
    expect(JSON.stringify(practice)).not.toMatch(/drill|practice/i);
  });

  it("404s for a person nobody knows, and refuses anything but ?person", async () => {
    expect((await get("/v1/pending?person=nobody")).statusCode).toBe(404);
    expect((await get("/v1/pending?user=sam")).statusCode).toBe(400);
  });
});

describe("GET /v1/ledger/team", () => {
  it("drops per-person timing, as the mirror's copy does", async () => {
    await askedForRefund();
    const held = await h.core.check(gateRefund(REFUND_SC4));
    const card = h.chat.cardIn("dm-sam");
    h.clock.advance(4000);
    await h.core.onApprovalOutcome({
      sessionId: card.sessionId,
      switchRequestId: card.switchRequestId,
      kind: "approval",
      state: "answered",
      answer: "allow",
      answeredBy: PARTICIPANTS.sam,
      answeredAtMs: h.clock.nowMs(),
    });
    const timed = h.core.stores.ledger.list({ requestId: held.request_id as string }).find((entry) => "latency_ms" in entry.payload);
    expect(timed).toBeDefined();
    const team = (await get("/v1/ledger/team?limit=200")).json().entries as { seq: number; payload: Record<string, unknown> }[];
    const same = team.find((entry) => entry.seq === timed?.seq);
    expect(same).toBeDefined();
    expect(same?.payload).not.toHaveProperty("latency_ms");
  });

  it("leaves out drills, and stands still while one is open", async () => {
    await askedForRefund();
    await h.core.check(gateRefund(REFUND_SC4));
    const before = (await get("/v1/ledger/team?limit=200")).json().entries as { seq: number; type: string }[];
    expect(before.length).toBeGreaterThan(0);

    const drill = await h.core.sendDrill("sam");
    if (!drill.ok) throw new Error(drill.reason);
    // Something real after the drill opened: the team's list still stops where it was.
    await h.core.check(gateRefund({ ...REFUND_SC4, order_id: "A-1941", amount: 30000 }));
    const during = (await get("/v1/ledger/team?limit=200")).json().entries as { seq: number; type: string; request_id: string | null }[];
    expect(during).toEqual(before);
    expect(h.core.stores.ledger.list().length).toBeGreaterThan(before.length);

    const all = h.core.stores.ledger.list();
    expect(all.some((entry) => entry.request_id === drill.requestId)).toBe(true);
    for (const entry of during) {
      expect(entry.type.startsWith("drill_")).toBe(false);
      expect(entry.request_id).not.toBe(drill.requestId);
    }
  });

  it("gives the newest entries up to the limit, and refuses a limit out of range", async () => {
    await askedForRefund();
    await h.core.check(gateRefund(REFUND_SC4));
    const all = h.core.stores.ledger.list();
    const last = (await get("/v1/ledger/team?limit=1")).json().entries;
    expect(last).toHaveLength(1);
    expect(last[0].seq).toBe(all.at(-1)?.seq);
    expect((await get("/v1/ledger/team?limit=0")).statusCode).toBe(400);
    expect((await get("/v1/ledger/team?limit=201")).statusCode).toBe(400);
  });
});

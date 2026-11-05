/** F16: `mode: shadow` logs what would have been held without blocking, and the simulator replays a policy change. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { chatMessage, gateRefund, hookShell, makeHarness, MINUTE, PARTICIPANTS, POLICY_PATH, REFUND_SC4, type Harness } from "./harness.js";

const TOKEN = "test-internal-token";
const auth = { authorization: `Bearer ${TOKEN}` };
const SMALL = { order_id: "A-1931", customer_id: "cus_8812", amount: 2000, destination: "rohan.s@okhdfc" };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clearance-shadow-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const POLICY = readFileSync(POLICY_PATH, "utf8");

function policyAt(text: string): string {
  const path = join(dir, "policy.yaml");
  writeFileSync(path, text);
  return path;
}

describe("mode: shadow", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness({ policyPath: policyAt(POLICY.replace("mode: enforce", "mode: shadow")) });
  });
  afterEach(() => h.core.close());

  const counts = (table: string) => (h.core.stores.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  it("lets through what it would have held, says so, and holds nothing", async () => {
    const response = await h.core.check(gateRefund(REFUND_SC4));
    expect(response).toMatchObject({ decision: "allow", would_decide: "hold", class: "refund", tier: "high", score: 55 });
    expect(response.reason).toContain("SHADOW");
    expect(response.reason).toContain("refunds over ₹10,000 need finance approval");
    expect(response.request_id).toBeUndefined();
    expect(h.chat.cards).toEqual([]);
    expect(h.chat.messages).toEqual([]);
    expect(h.gate.calls).toEqual([]);
    expect(counts("requests")).toBe(0);
    expect(counts("timers")).toBe(0);
    expect(counts("grants")).toBe(0);
  });

  it("logs each one, for the rollout decision", async () => {
    const response = await h.core.check(gateRefund(REFUND_SC4));
    const row = h.core.stores.db.prepare(`SELECT decision, would_decide, class, tier FROM actions`).get();
    expect(row).toEqual({ decision: "allow", would_decide: "hold", class: "refund", tier: "high" });
    expect(h.core.shadowLog().would_hold).toEqual([
      expect.objectContaining({ class: "refund", tier: "high", agent: "refunds-agent", call_hash: response.call_hash }),
    ]);
  });

  it("does not count what would have been allowed as held", async () => {
    const response = await h.core.check(hookShell("ls -la"));
    expect(response).toMatchObject({ decision: "allow", would_decide: "allow" });
    expect(h.core.shadowLog().would_hold).toEqual([]);
  });

  it("still denies: shadow is about holds, and a deny guards Clearance itself", async () => {
    const edit = await h.core.check({
      id: "shadow-file-write",
      at: new Date(h.clock.nowMs()).toISOString(),
      source: "hook",
      vendor: "claude",
      agent: { name: "coder" },
      kind: "file_write",
      raw: { path: ".claude/settings.json" },
      file: { path: ".claude/settings.json" },
    });
    expect(edit.decision).toBe("deny");
    const unknown = await h.core.check({ ...gateRefund(REFUND_SC4), agent: { name: "nobody-agent" } });
    expect(unknown.decision).toBe("deny");
  });

  it("adds up the 24 h window as if the calls had run, so it reports what enforcement would really do", async () => {
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L2", h.clock.nowMs());
    const run = (order: string) => h.core.check(gateRefund({ ...SMALL, amount: 4000, order_id: order }));
    expect((await run("A-1931")).would_decide).toBe("allow");
    expect((await run("A-2004")).would_decide).toBe("allow");
    const third = await run("A-1932");
    expect(third).toMatchObject({ decision: "allow", would_decide: "hold" });
    expect(third.flags?.map((flag) => flag.code)).toContain("aggregate_limit");
  });

  it("opens no review card and makes no request for what would have run alone", async () => {
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L2", h.clock.nowMs());
    await h.core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
    const response = await h.core.check(gateRefund(SMALL));
    expect(response).toMatchObject({ decision: "allow", would_decide: "allow" });
    expect(h.chat.cards).toEqual([]);
    expect(counts("requests")).toBe(0);
  });

  it("is reported by GET /v1/health, which is what E2 reads", async () => {
    expect(h.core.health().mode).toBe("shadow");
  });

  it("is reported by GET /v1/policy", async () => {
    const app = buildServer(h.core, { internalToken: TOKEN });
    try {
      await h.core.check(gateRefund(REFUND_SC4));
      const body = (await app.inject({ method: "GET", url: "/v1/policy", headers: auth })).json();
      expect(body).toMatchObject({ mode: "shadow", shadow_would_hold: 1 });
    } finally {
      await app.close();
    }
  });
});

describe("mode: enforce", () => {
  it("has nothing to say about what it would have done", async () => {
    const h = makeHarness();
    try {
      const response = await h.core.check(gateRefund(REFUND_SC4));
      expect(response.would_decide).toBeUndefined();
      expect(h.core.shadowLog().would_hold).toEqual([]);
      expect(h.core.health().mode).toBe("enforce");
    } finally {
      h.core.close();
    }
  });
});

describe("POST /v1/policy/simulate over the last N actions", () => {
  let h: Harness;
  let app: FastifyInstance;
  beforeEach(() => {
    h = makeHarness();
    app = buildServer(h.core, { internalToken: TOKEN });
  });
  afterEach(async () => {
    await app.close();
    h.core.close();
  });

  const simulate = (payload: unknown) => app.inject({ method: "POST", url: "/v1/policy/simulate", headers: auth, payload: payload as object });

  it("the same policy changes nothing", async () => {
    await h.core.check(gateRefund(REFUND_SC4));
    await h.core.check(hookShell("ls -la"));
    const response = await simulate({ last: 10 });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      replayed: 2,
      skipped: 0,
      current: { allow: 1, hold: 1, deny: 0 },
      proposed: { allow: 1, hold: 1, deny: 0 },
      delta: { allow: 0, hold: 0, deny: 0 },
      changed: [],
    });
  });

  it("a change prints the held and allowed deltas, and which calls moved", async () => {
    await h.core.check(hookShell("echo hello"));
    await h.core.check(hookShell("ls -la"));
    const text = POLICY.replace("protected:", "protected:\n  - { shell: '^echo\\b' }");
    const response = await simulate({ policy: text, last: 10 });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ replayed: 2, current: { allow: 2, hold: 0 }, proposed: { allow: 1, hold: 1 }, delta: { allow: -1, hold: 1, deny: 0 } });
    expect(body.changed).toEqual([expect.objectContaining({ agent: "coder", from: "allow", to: "hold" })]);
    expect(body.policy_hash.proposed).not.toBe(body.policy_hash.current);
  });

  it("takes only the last N", async () => {
    for (const command of ["ls a", "ls b", "ls c"]) await h.core.check(hookShell(command));
    expect((await simulate({ last: 2 })).json().replayed).toBe(2);
  });

  it("rebuilds the 24 h window as it goes, at each call's own time, rather than reading today's", async () => {
    h.core.stores.autonomy.setLevel("refunds-agent", "refund", "small", "L2", h.clock.nowMs());
    for (const order of ["A-1931", "A-2004", "A-1932"]) {
      await h.core.check(gateRefund({ ...SMALL, amount: 4000, order_id: order }, { at: new Date(h.clock.nowMs()).toISOString() }));
      h.clock.advance(MINUTE);
    }
    expect((await simulate({ last: 10 })).json()).toMatchObject({
      current: { allow: 2, hold: 1 },
      proposed: { allow: 2, hold: 1 },
      delta: { allow: 0, hold: 0 },
    });
  });

  it("writes nothing and opens nothing", async () => {
    await h.core.check(gateRefund(REFUND_SC4));
    const db = h.core.stores.db;
    const snapshot = () => ["ledger", "actions", "requests", "aggregates", "routes", "bucket_events"].map((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get());
    const before = snapshot();
    const cards = h.chat.cards.length;
    await simulate({ policy: POLICY.replace("protected:", "protected:\n  - { shell: '^echo\\b' }"), last: 10 });
    expect(snapshot()).toEqual(before);
    expect(h.chat.cards).toHaveLength(cards);
    expect(h.core.policy().file.mode).toBe("enforce");
  });

  it("answers a policy that doesn't load with the line that's wrong", async () => {
    const response = await simulate({ policy: "version: 1\nmode: sideways\n", last: 10 });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/line \d+/);
  });

  it("says how many it could not replay", async () => {
    await h.core.check(hookShell("ls a"));
    h.core.stores.db.prepare(`UPDATE actions SET action_json = NULL`).run();
    expect((await simulate({ last: 10 })).json()).toMatchObject({ replayed: 0, skipped: 1 });
  });

  it("refuses a nonsense N", async () => {
    expect((await simulate({ last: 0 })).statusCode).toBe(400);
    expect((await simulate({ last: 100000 })).statusCode).toBe(400);
  });

  it("still classifies one call, as it did", async () => {
    const response = await simulate({ action: gateRefund(REFUND_SC4) });
    expect(response.json()).toMatchObject({ decision: "hold", class: "refund" });
  });
});

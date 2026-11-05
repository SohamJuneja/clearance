import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildAcmeServer } from "../src/server";
import { DEMO_RESET_BUDGET_MS, runDemoReset } from "../../../scripts/demo-reset";

const KEY = "demo-reset-test-key";

let app: FastifyInstance;
let acmeUrl: string;
let lines: string[];

const headers = { "x-acme-admin-key": KEY, "content-type": "application/json" };
const log = (line: string) => lines.push(line);
const filledHook = async () => ({ done: true, note: "core database removed" });

beforeEach(async () => {
  lines = [];
  app = buildAcmeServer({ dbPath: ":memory:", adminKey: KEY, logger: false });
  acmeUrl = await app.listen({ host: "127.0.0.1", port: 0 });
});

afterEach(async () => {
  await app.close();
});

async function dirtyAcme() {
  const res = await fetch(`${acmeUrl}/refunds`, {
    method: "POST",
    headers,
    body: JSON.stringify({ order_id: "A-1931", customer_id: "cus_8812", amount: 40000, destination: "meera.k@okaxis" }),
  });
  expect(res.status).toBe(201);
}

async function moneyOut() {
  const res = await fetch(`${acmeUrl}/state`, { headers });
  return ((await res.json()) as { money_out: number }).money_out;
}

describe("demo reset", () => {
  it("resets Acme through its API and prints the elapsed time", async () => {
    await dirtyAcme();
    expect(await moneyOut()).toBe(40000);
    const result = await runDemoReset({ acmeUrl, adminKey: KEY, log, clearance: filledHook });
    expect(await moneyOut()).toBe(0);
    expect(result.ok).toBe(true);
    expect(lines.join("\n")).toMatch(/done in \d+\.\d+ s/);
  });

  it("stays well inside the 10 s budget", async () => {
    const result = await runDemoReset({ acmeUrl, adminKey: KEY, log, clearance: filledHook });
    expect(DEMO_RESET_BUDGET_MS).toBe(10_000);
    expect(result.elapsedMs).toBeLessThan(DEMO_RESET_BUDGET_MS);
  });

  it("passes the Clearance hook the core database path", async () => {
    let seen: string | undefined;
    await runDemoReset({
      acmeUrl,
      adminKey: KEY,
      log,
      clearanceDbPath: "./data/clearance.sqlite",
      clearance: async (ctx) => {
        seen = ctx.clearanceDbPath;
        return { done: true, note: "ok" };
      },
    });
    expect(seen).toBe("./data/clearance.sqlite");
  });

  // The real hook stops services and clears their databases, so a test must never reach it.
  it("a hook that didn't finish is reported loudly, so a partial reset cannot pass for a full one", async () => {
    const result = await runDemoReset({
      acmeUrl,
      adminKey: KEY,
      log,
      clearance: async () => ({ done: false, note: "stub: nothing was reset" }),
    });
    expect(result.clearance.done).toBe(false);
    expect(lines.join("\n")).toMatch(/WARNING.*Clearance state was NOT reset/);
    expect(lines.join("\n")).toContain("./data/clearance.sqlite");
  });

  it("a wrong admin key fails rather than reporting success", async () => {
    await expect(runDemoReset({ acmeUrl, adminKey: "wrong", log, clearance: filledHook })).rejects.toThrow(/401/);
  });

  it("a missing admin key fails before calling anything", async () => {
    await expect(runDemoReset({ acmeUrl, adminKey: "", log, clearance: filledHook })).rejects.toThrow(/ACME_ADMIN_KEY/);
  });

  it("an Acme that is down fails with a message naming it", async () => {
    await expect(runDemoReset({ acmeUrl: "http://127.0.0.1:1", adminKey: KEY, log, clearance: filledHook })).rejects.toThrow(/cannot reach Acme/i);
  });

  it("an Acme that answers but did not actually reset is caught", async () => {
    const lying: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/admin/reset")) return new Response('{"ok":true}', { status: 200 });
      return fetch(input, init);
    };
    await dirtyAcme();
    await expect(runDemoReset({ acmeUrl, adminKey: KEY, log, clearance: filledHook, fetchImpl: lying })).rejects.toThrow(/did not reset/i);
  });

  it("a hook failure stops the reset with an error", async () => {
    const clearance = async () => {
      throw new Error("core is holding the database");
    };
    await expect(runDemoReset({ acmeUrl, adminKey: KEY, log, clearance })).rejects.toThrow(/core is holding the database/);
  });

  it("going over budget is a failure, not a footnote", async () => {
    // The clock is read once at the start and once at the end, so one step is the whole elapsed time.
    let t = 0;
    const result = await runDemoReset({ acmeUrl, adminKey: KEY, log, clearance: filledHook, now: () => (t += 10_001) });
    expect(result.elapsedMs).toBe(10_001);
    expect(result.ok).toBe(false);
    expect(lines.join("\n")).toMatch(/over the 10 s budget/);
  });

  it("never prints the admin key", async () => {
    await runDemoReset({ acmeUrl, adminKey: KEY, log, clearance: filledHook });
    expect(lines.join("\n")).not.toContain(KEY);
  });
});

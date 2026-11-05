import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AcmeClient, CoreClient, moneyOut, probe, waitUntil, WorldError } from "./world.ts";

let server: Server | undefined;

async function serve(
  handler: (path: string) => { status: number; body: unknown },
): Promise<string> {
  server = createServer((req, res) => {
    const { status, body } = handler(req.url ?? "/");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((done) => {
    if (!server) return done();
    server.close(() => done());
    server.closeAllConnections();
    server = undefined;
  });
});

const state = { refunds: [], deploys: [], outbox: [], deleted_records: [] };
const closedPort = "http://127.0.0.1:9";

describe("probe", () => {
  it("names the service when nothing is listening, in the words a person expects", async () => {
    const result = await probe("acme", closedPort);
    expect(result.reachable).toBe(false);
    expect(result.message).toMatch(/^Acme not reachable at http:\/\/127\.0\.0\.1:9 \(/);
  });

  it("counts any HTTP answer as listening, including a refusal", async () => {
    const url = await serve(() => ({ status: 401, body: {} }));
    expect((await probe("core", url)).reachable).toBe(true);
  });
});

describe("AcmeClient", () => {
  it("reads state and adds up the money out", async () => {
    const url = await serve(() => ({
      status: 200,
      body: {
        ...state,
        refunds: [
          { id: "re_1", amount: 4000 },
          { id: "re_2", amount: 36000 },
        ],
      },
    }));
    expect(moneyOut(await new AcmeClient(url, () => "key").state())).toBe(40000);
  });

  it("refuses a state it can't read, rather than treating it as no refunds", async () => {
    const url = await serve(() => ({ status: 200, body: { money: "lots" } }));
    await expect(new AcmeClient(url, () => "key").state()).rejects.toThrow(/unexpected shape/);
  });

  it("says Acme is not reachable instead of crashing on a closed port", async () => {
    await expect(new AcmeClient(closedPort, () => "key").state()).rejects.toThrow(
      /Acme not reachable/,
    );
  });

  it("waits for a refund that is new since the snapshot", async () => {
    let calls = 0;
    const old = { id: "re_old", amount: 40000, order_id: "A-1931" };
    const fresh = { id: "re_new", amount: 40000, order_id: "A-1931" };
    const url = await serve(() => {
      calls += 1;
      return { status: 200, body: { ...state, refunds: calls < 3 ? [old] : [old, fresh] } };
    });
    const acme = new AcmeClient(url, () => "key");
    const before = await acme.state();
    const found = await acme.waitForRefund((refund) => refund.amount === 40000, {
      before,
      timeoutMs: 2_000,
      pollMs: 5,
      description: "a refund",
    });
    expect(found.id).toBe("re_new");
  });
});

describe("CoreClient", () => {
  it("reads a ledger as a bare array or under entries", async () => {
    const url = await serve((path) =>
      path === "/v1/ledger"
        ? { status: 200, body: { entries: [{ type: "held" }] } }
        : { status: 404, body: {} },
    );
    expect(await new CoreClient(url, () => undefined).ledger()).toEqual([{ type: "held" }]);
  });

  it("reports health without throwing", async () => {
    expect(await new CoreClient(closedPort, () => undefined).isHealthy()).toBe(false);
  });

  it("says so when core has no drill trigger", async () => {
    const url = await serve(() => ({ status: 404, body: {} }));
    await expect(new CoreClient(url, () => undefined).sendDrill("sam")).rejects.toThrow(/no POST/);
  });
});

describe("waitUntil", () => {
  it("names what it waited for on timeout", async () => {
    await expect(
      waitUntil(async () => undefined, { timeoutMs: 10, pollMs: 2, description: "the moon" }),
    ).rejects.toThrow(WorldError);
    await expect(
      waitUntil(async () => undefined, { timeoutMs: 10, pollMs: 2, description: "the moon" }),
    ).rejects.toThrow(/the moon/);
  });
});

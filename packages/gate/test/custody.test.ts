import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import {
  ADMIN_KEY,
  ALL_ENDPOINTS,
  INTERNAL_TOKEN,
  TOK_ALL,
  bearer,
  buildGateServer,
  gateConfig,
  holdFor,
  startFakeAcme,
  startFakeCore,
  tempDb,
  type FakeAcme,
  type FakeCore,
  type TempDb,
} from "./helpers.js";

let core: FakeCore;
let acme: FakeAcme;
let db: TempDb;
let gate: FastifyInstance;
let logged: string;

beforeEach(async () => {
  core = await startFakeCore();
  acme = await startFakeAcme();
  db = tempDb();
  logged = "";
  const stream = new Writable({
    write(chunk, _enc, done) {
      logged += chunk.toString();
      done();
    },
  });
  gate = buildGateServer(gateConfig(core, acme, db), { logger: { level: "trace", stream } });
  await gate.ready();
});

afterEach(async () => {
  await gate.close();
  await core.close();
  await acme.close();
  db.cleanup();
});

/** A compromised or sloppy upstream that reflects the key it was sent. */
const reflectKey = () => ({
  status: 200,
  body: { reflected: `key=${ADMIN_KEY}`, nested: { again: ADMIN_KEY } },
});

async function driveEverything(): Promise<string[]> {
  const bodies: string[] = [];
  const hit = async (opts: InjectOptions) => {
    const res = await gate.inject(opts);
    bodies.push(res.body, JSON.stringify(res.headers));
    return res;
  };
  for (const ep of ALL_ENDPOINTS) {
    const req: InjectOptions = {
      method: ep.method,
      url: ep.url,
      payload: ep.payload,
      headers: bearer(TOK_ALL),
    };
    await hit(req);
    core.decide(holdFor(`CLR-${ep.name}`.replaceAll(" ", "-")));
    await hit(req);
    core.decide(() => ({ decision: "deny", reason: "no" }));
    await hit(req);
    core.decide(() => ({ rawStatus: 500, rawBody: "boom" }));
    await hit(req);
    core.decide(() => ({ decision: "allow", reason: "ok" }));
  }
  await hit({ method: "GET", url: "/acme/orders/A-1931", headers: bearer(TOK_ALL) });
  await hit({ method: "GET", url: "/acme/orders/nope", headers: bearer(TOK_ALL) });
  await hit({
    method: "GET",
    url: "/internal/lookup/orders/A-1931",
    headers: bearer(INTERNAL_TOKEN),
  });
  await hit({ method: "GET", url: "/pending/CLR-refund", headers: bearer(TOK_ALL) });
  await hit({
    method: "POST",
    url: "/internal/execute/CLR-refund",
    payload: { call_hash: "wrong" },
    headers: bearer(INTERNAL_TOKEN),
  });
  await hit({
    method: "POST",
    url: "/internal/execute/CLR-refund",
    payload: { call_hash: "hash-CLR-refund" },
    headers: bearer(INTERNAL_TOKEN),
  });
  await hit({ method: "GET", url: "/acme/orders/A-1931", headers: bearer("bad-token") });
  return bodies;
}

describe("credential custody", () => {
  it("the admin key never appears in a response or a log line on any path", async () => {
    const bodies = await driveEverything();
    expect(bodies.length).toBeGreaterThan(20);
    for (const body of bodies) expect(body).not.toContain(ADMIN_KEY);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).not.toContain(ADMIN_KEY);
  });

  it("no token of any kind appears in a log line", async () => {
    await driveEverything();
    for (const secret of [TOK_ALL, INTERNAL_TOKEN]) expect(logged).not.toContain(secret);
  });

  it("scrubs the key from a read when an upstream reflects it", async () => {
    acme.respond(reflectKey);
    const res = await gate.inject({
      method: "GET",
      url: "/acme/orders/A-1931",
      headers: bearer(TOK_ALL),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(ADMIN_KEY);
    expect(res.json().reflected).toBe("key=[redacted]");
  });

  it("scrubs the key from an allowed write and from a stored execute result", async () => {
    acme.respond(reflectKey);
    const ep = ALL_ENDPOINTS[0]!;
    const allowed = await gate.inject({
      method: ep.method,
      url: ep.url,
      payload: ep.payload,
      headers: bearer(TOK_ALL),
    });
    expect(allowed.body).not.toContain(ADMIN_KEY);

    core.decide(holdFor("CLR-1"));
    await gate.inject({
      method: ep.method,
      url: ep.url,
      payload: ep.payload,
      headers: bearer(TOK_ALL),
    });
    const execute = () =>
      gate.inject({
        method: "POST",
        url: "/internal/execute/CLR-1",
        payload: { call_hash: "hash-CLR-1" },
        headers: bearer(INTERNAL_TOKEN),
      });
    const first = await execute();
    const second = await execute();
    expect(first.body).not.toContain(ADMIN_KEY);
    expect(second.body).not.toContain(ADMIN_KEY);
  });

  it("scrubs the key from a lookup when an upstream reflects it", async () => {
    acme.respond(reflectKey);
    const res = await gate.inject({
      method: "GET",
      url: "/internal/lookup/orders/A-1931",
      headers: bearer(INTERNAL_TOKEN),
    });
    expect(res.body).not.toContain(ADMIN_KEY);
  });

  it("does not follow a redirect from Acme, so the key cannot be carried to another host", async () => {
    const other = await startFakeAcme();
    acme.respond(() => ({ status: 302, location: `${other.url}/orders/A-1931` }));
    const read = await gate.inject({
      method: "GET",
      url: "/acme/orders/A-1931",
      headers: bearer(TOK_ALL),
    });
    expect(read.statusCode).toBe(502);
    const ep = ALL_ENDPOINTS[0]!;
    const write = await gate.inject({
      method: ep.method,
      url: ep.url,
      payload: ep.payload,
      headers: bearer(TOK_ALL),
    });
    expect(write.statusCode).toBe(502);
    expect(other.calls).toHaveLength(0);
    await other.close();
  });

  it("does not pass Acme's response headers through, only the content type", async () => {
    acme.respond(() => ({
      status: 200,
      body: { ok: true },
      contentType: "application/json; charset=utf-8",
    }));
    const res = await gate.inject({
      method: "GET",
      url: "/acme/orders/A-1931",
      headers: bearer(TOK_ALL),
    });
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["x-acme-admin-key"]).toBeUndefined();
  });

  it("does not forward an agent's own Authorization or custom headers to Acme", async () => {
    await gate.inject({
      method: "GET",
      url: "/acme/orders/A-1931",
      headers: { ...bearer(TOK_ALL), "x-acme-admin-key": "agent-guess", "x-custom": "1" },
    });
    expect(acme.calls[0]!.headers.authorization).toBeUndefined();
    expect(acme.calls[0]!.headers["x-custom"]).toBeUndefined();
    expect(acme.calls[0]!.headers["x-acme-admin-key"]).toBe(ADMIN_KEY);
  });

  it("does not put the key into what it sends core", async () => {
    const ep = ALL_ENDPOINTS[0]!;
    core.decide(holdFor("CLR-2"));
    await gate.inject({
      method: ep.method,
      url: ep.url,
      payload: ep.payload,
      headers: bearer(TOK_ALL),
    });
    expect(JSON.stringify(core.checks)).not.toContain(ADMIN_KEY);
  });
});

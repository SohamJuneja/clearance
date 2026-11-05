/** The gate's MCP tools, driven by the real MCP client over streamable HTTP. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  ADMIN_KEY,
  HELD_TEXT,
  INTERNAL_TOKEN,
  TOK_ALL,
  TOK_REFUNDS,
  bearer,
  buildGateServer,
  gateConfig,
  holdFor,
  rawRequest,
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
let base: string;
const clients: Client[] = [];

beforeEach(async () => {
  core = await startFakeCore();
  acme = await startFakeAcme();
  db = tempDb();
  gate = buildGateServer(gateConfig(core, acme, db));
  base = await gate.listen({ port: 0, host: "127.0.0.1" });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await gate.close();
  await core.close();
  await acme.close();
  db.cleanup();
});

async function connect(token = TOK_ALL, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { ...bearer(token), ...headers } },
    }),
  );
  clients.push(client);
  return client;
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { isError: result.isError === true, text: result.content.map((c) => c.text).join("\n") };
}

const REFUND = { order_id: "A-1931", customer_id: "c", amount: 40000, destination: "x@y" };

const TOOLS = [
  {
    tool: "refund_customer",
    args: REFUND,
    endpoint: "POST /acme/refunds",
    upstream: ["POST", "/refunds"],
  },
  {
    tool: "deploy_service",
    args: { service: "checkout", env: "prod", version: "v2.14.0" },
    endpoint: "POST /acme/deploys",
    upstream: ["POST", "/deploys"],
  },
  {
    tool: "send_customer_email",
    args: { to: "a@b.in", subject: "s", body: "b", attachments: ["customers.csv"] },
    endpoint: "POST /acme/emails",
    upstream: ["POST", "/emails"],
  },
  {
    tool: "delete_records",
    args: { table: "customers", id: "cus_1" },
    endpoint: "DELETE /acme/records/customers/cus_1",
    upstream: ["DELETE", "/records/customers/cus_1"],
  },
  {
    tool: "merge_pull_request",
    args: { repo: "acme/acme-mini-app", pr: 42 },
    endpoint: "POST /github/merge",
    upstream: ["POST", "/pulls/42/merge"],
  },
] as const;

describe("tools/list", () => {
  it("offers exactly the planned tools, each with an input schema and a description", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "check_clearance",
        "delete_records",
        "deploy_service",
        "merge_pull_request",
        "refund_customer",
        "send_customer_email",
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
    }
    const refund = tools.find((t) => t.name === "refund_customer")!;
    expect(refund.inputSchema.properties).toHaveProperty("amount");
  });
});

describe.each(TOOLS)("$tool", ({ tool, args, endpoint, upstream }) => {
  it("goes through check with the identity from the token, and executes on allow", async () => {
    const out = await call(await connect(), tool, args);
    expect(out.isError).toBe(false);
    expect(core.checks).toHaveLength(1);
    const { action, authorization } = core.checks[0]!;
    expect(authorization).toBe(`Bearer ${INTERNAL_TOKEN}`);
    expect(action).toMatchObject({
      source: "gate",
      vendor: "gate",
      kind: "business",
      agent: { name: "ops-agent" },
    });
    expect(action.business!.endpoint).toBe(endpoint);
    const sent = acme.mutations()[0]!;
    expect([sent.method, sent.url]).toEqual(upstream);
    expect(sent.headers["x-acme-admin-key"]).toBe(ADMIN_KEY);
  });

  it("returns PENDING at once on a hold and runs nothing", async () => {
    core.decide(holdFor("CLR-0042"));
    const out = await call(await connect(), tool, args);
    expect(out.isError).toBe(false);
    expect(out.text.startsWith("PENDING CLR-0042")).toBe(true);
    expect(out.text).toContain(HELD_TEXT);
    expect(acme.mutations()).toHaveLength(0);
  });

  it("is an error with the reason on a deny", async () => {
    core.decide(() => ({ decision: "deny", reason: "protected" }));
    const out = await call(await connect(), tool, args);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("DENIED");
    expect(out.text).toContain("protected");
    expect(acme.mutations()).toHaveLength(0);
  });

  it("fails closed when core answers badly", async () => {
    core.decide(() => ({
      rawStatus: 500,
      rawBody: JSON.stringify({ decision: "allow", reason: "x" }),
    }));
    const out = await call(await connect(), tool, args);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("UNAVAILABLE");
    expect(acme.mutations()).toHaveLength(0);
  });
});

describe("same path as HTTP", () => {
  it("a held tool call is executed once by the internal route", async () => {
    core.decide(holdFor("CLR-0100"));
    await call(await connect(), "refund_customer", REFUND);
    const execute = () =>
      gate.inject({
        method: "POST",
        url: "/internal/execute/CLR-0100",
        payload: { call_hash: "hash-CLR-0100" },
        headers: bearer(INTERNAL_TOKEN),
      });
    expect((await execute()).json()).toMatchObject({ ok: true, alreadyExecuted: false });
    expect((await execute()).json()).toMatchObject({ ok: true, alreadyExecuted: true });
    expect(acme.mutations()).toHaveLength(1);
    expect(acme.mutations()[0]!.body).toEqual(REFUND);
  });

  it("fills a refund's customer and destination the same way", async () => {
    await call(await connect(), "refund_customer", { order_id: "A-1931", amount: 4000 });
    expect(core.checks[0]!.action.business!.args).toEqual({
      order_id: "A-1931",
      amount: 4000,
      customer_id: "cus_8812",
      destination: "meera.old@okhdfcbank",
    });
  });

  it("passes room and thread hints", async () => {
    const client = await connect(TOK_ALL, {
      "x-clearance-room": "!room",
      "x-clearance-thread": "t-1",
    });
    await call(client, "refund_customer", REFUND);
    expect(core.checks[0]!.action.session).toEqual({ switchRoomId: "!room", threadId: "t-1" });
  });

  it("scrubs the admin key from a result when an upstream reflects it", async () => {
    acme.respond(() => ({ status: 200, body: { reflected: ADMIN_KEY } }));
    const out = await call(await connect(), "refund_customer", REFUND);
    expect(out.text).not.toContain(ADMIN_KEY);
  });

  it("does not wait long when core hangs", async () => {
    await gate.close();
    core.decide(() => ({ decision: "allow", reason: "ok" }));
    const slow = await startFakeAcme();
    slow.respond(() => ({ status: 200, body: {}, delayMs: 2000 }));
    gate = buildGateServer(gateConfig(slow, acme, db, { coreTimeoutMs: 50 }));
    base = await gate.listen({ port: 0, host: "127.0.0.1" });
    const started = Date.now();
    const out = await call(await connect(), "refund_customer", REFUND);
    expect(out.text).toContain("UNAVAILABLE");
    expect(Date.now() - started).toBeLessThan(1500);
    await slow.close();
  });
});

describe("tokens", () => {
  it("refuses a bad token", async () => {
    await expect(connect("wrong-token")).rejects.toThrow();
    expect(core.checks).toHaveLength(0);
  });

  it("refuses the internal token", async () => {
    await expect(connect(INTERNAL_TOKEN)).rejects.toThrow();
  });

  it("answers 401 with no token at all", async () => {
    const res = await rawRequest(base, "POST", "/mcp", {});
    expect(res.status).toBe(401);
  });

  it("holds a token to its classes", async () => {
    const out = await call(await connect(TOK_REFUNDS), "deploy_service", TOOLS[1].args);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("refunds-agent is not allowed");
    expect(core.checks).toHaveLength(0);
  });

  it("the identity is the token's, whichever client is connected", async () => {
    await call(await connect(TOK_REFUNDS), "refund_customer", REFUND);
    expect(core.checks[0]!.action.agent.name).toBe("refunds-agent");
  });
});

describe("bad arguments never reach core", () => {
  const rejected = async (name: string, args: Record<string, unknown>) => {
    const client = await connect();
    const out = await client.callTool({ name, arguments: args }).then(
      (r) => (r as ToolResult).isError === true,
      () => true,
    );
    expect(out).toBe(true);
    expect(core.checks).toHaveLength(0);
    expect(acme.mutations()).toHaveLength(0);
  };

  it("an amount as a string", () => rejected("refund_customer", { ...REFUND, amount: "40000" }));
  it("an agent name in the arguments", () =>
    rejected("refund_customer", { ...REFUND, agent: { name: "sam" } }));
  it("an unknown field", () => rejected("refund_customer", { ...REFUND, approved_by: "sam" }));
  it("a refund with no order", () => rejected("refund_customer", { customer_id: "c", amount: 5 }));
  it("a traversal in a table name", () => rejected("delete_records", { table: "..", id: "x" }));
  it("a slash in a record id", () =>
    rejected("delete_records", { table: "customers", id: "a/../b" }));
  it("an unknown tool", () => rejected("drop_database", {}));
});

describe("check_clearance", () => {
  const hold = async (id: string) => {
    core.decide(holdFor(id));
    await call(await connect(), "refund_customer", REFUND);
  };

  it("says PENDING while waiting", async () => {
    await hold("CLR-0200");
    core.requests.set("CLR-0200", { status: 200, body: JSON.stringify({ state: "ROUTED" }) });
    const out = await call(await connect(), "check_clearance", { request_id: "CLR-0200" });
    expect(out.isError).toBe(false);
    expect(out.text.startsWith("PENDING CLR-0200")).toBe(true);
  });

  it("reports the result after execution", async () => {
    await hold("CLR-0201");
    await gate.inject({
      method: "POST",
      url: "/internal/execute/CLR-0201",
      payload: { call_hash: "hash-CLR-0201" },
      headers: bearer(INTERNAL_TOKEN),
    });
    core.requests.set("CLR-0201", { status: 200, body: JSON.stringify({ state: "EXECUTED" }) });
    const out = await call(await connect(), "check_clearance", { request_id: "CLR-0201" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("re_7731");
  });

  it("does not show another agent's request", async () => {
    await hold("CLR-0202");
    core.requests.set("CLR-0202", { status: 200, body: JSON.stringify({ state: "HELD" }) });
    const out = await call(await connect(TOK_REFUNDS), "check_clearance", {
      request_id: "CLR-0202",
    });
    expect(out.isError).toBe(true);
    expect(out.text).not.toContain("HELD");
  });

  it("is an error for an unknown id, or when core cannot answer", async () => {
    const client = await connect();
    expect((await call(client, "check_clearance", { request_id: "CLR-404" })).isError).toBe(true);
    core.requests.set("CLR-0203", { status: 500, body: "{}" });
    const out = await call(client, "check_clearance", { request_id: "CLR-0203" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("UNAVAILABLE");
  });
});

describe("transport", () => {
  it.each(["GET", "DELETE"])(
    "answers %s with 405, since the server keeps no sessions",
    async (method) => {
      const res = await rawRequest(base, method, "/mcp", bearer(TOK_ALL));
      expect(res.status).toBe(405);
    },
  );

  it("still requires a token for those", async () => {
    const res = await rawRequest(base, "GET", "/mcp", {});
    expect(res.status).toBe(401);
  });
});

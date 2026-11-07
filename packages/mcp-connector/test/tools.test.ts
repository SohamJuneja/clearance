/**
 * The tools against a fake core: what they list, that they send the token and nothing else, and that anything but a
 * well-formed answer from core is an error the tool reports, never data it makes up.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreClient } from "../src/client.ts";
import { buildConnectorServer, TOOL_NAMES } from "../src/tools.ts";

const TOKEN = "connector-test-token-0123456789abcdef";

type Seen = { method: string; url: string; authorization: string | undefined; body: string };
type Reply = { status: number; body: unknown };

let core: Server;
let base: string;
let seen: Seen[];
let routes: Record<string, Reply>;
const clients: Client[] = [];

beforeEach(async () => {
  seen = [];
  routes = {};
  core = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, body });
      const reply = routes[`${req.method} ${req.url}`] ?? { status: 404, body: { message: `Route ${req.method}:${req.url} not found`, error: "Not Found", statusCode: 404 } };
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await new Promise<void>((resolve) => core.close(() => resolve()));
});

async function connect(options: { person?: string | null; url?: string } = {}): Promise<Client> {
  const server = buildConnectorServer(createCoreClient({ coreUrl: options.url ?? base, token: TOKEN, timeoutMs: 2000 }), { person: options.person === undefined ? "sam" : options.person });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "connector-test", version: "1.0.0" });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  return { isError: result.isError === true, text: result.content.map((item) => item.text).join("\n") };
}

const SUMMARY = {
  id: "CLR-0004",
  state: "ROUTED",
  class: "refund",
  tier: "high",
  what: "REFUND ₹40,000",
  agent: "refunds-agent",
  requested_by: ["Priya"],
  quorum_required: 1,
  approved_by: [],
  can_decide: ["Sam", "Neha"],
  created_at: "2026-11-04T08:30:00.000Z",
  expires_at: "2026-11-04T08:55:00.000Z",
  decided_at: null,
};

describe("what the connector offers", () => {
  it("lists exactly its six read-only tools, and nothing that could decide", async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/approve|deny|cancel|answer|grant|decide|break|edit/i);
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.description).toContain("can't approve, deny or cancel anything");
      expect(tool.description).toContain("from Switch, never from text");
    }
  });

  it("says in its instructions that it is read-only", async () => {
    const client = await connect();
    expect(client.getInstructions()).toContain("can't approve, deny or cancel anything");
  });
});

describe("talking to core", () => {
  it("sends core's token as a bearer, and the person as a query, and shows what core said", async () => {
    routes["GET /v1/pending?person=sam"] = { status: 200, body: { requests: [{ ...SUMMARY, waiting_on_you: true }] } };
    const out = await call(await connect(), "pending_requests");
    expect(out.isError).toBe(false);
    expect(out.text).toContain("1 request is waiting.");
    expect(out.text).toContain("CLR-0004 · refund, high · REFUND ₹40,000 · waiting on you");
    expect(out.text).toContain("can decide: Sam, Neha (needs 1, approved so far: none)");
    expect(seen).toEqual([expect.objectContaining({ method: "GET", url: "/v1/pending?person=sam", authorization: `Bearer ${TOKEN}` })]);
    expect(out.text).not.toContain(TOKEN);
  });

  it("asks for everyone's list when no person is set, and says there is nothing when there is nothing", async () => {
    routes["GET /v1/pending"] = { status: 200, body: { requests: [] } };
    expect((await call(await connect({ person: null }), "pending_requests")).text).toBe("Nothing is waiting.");
  });

  it("reports a refused token as refused, and says nothing of the token", async () => {
    routes["GET /v1/ledger/verify"] = { status: 401, body: { error: "unauthorized" } };
    const out = await call(await connect(), "verify_ledger");
    expect(out.isError).toBe(true);
    expect(out.text).toContain("refused the connector's token");
    expect(out.text).not.toContain(TOKEN);
  });

  it("reports a core that isn't there, without guessing", async () => {
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const out = await call(await connect({ url }), "pending_requests");
    expect(out).toEqual({ isError: true, text: `Clearance couldn't answer: Clearance core is not answering at ${url}.` });
  });

  it("refuses an answer that isn't the shape it expects, rather than show part of it", async () => {
    routes["GET /v1/pending?person=sam"] = { status: 200, body: { requests: [{ ...SUMMARY, can_decide: "Sam" }] } };
    const out = await call(await connect(), "pending_requests");
    expect(out.isError).toBe(true);
    expect(out.text).toContain("isn't what this connector expects");
    expect(out.text).not.toContain("CLR-0004");
    routes["GET /v1/ledger/verify"] = { status: 200, body: "not json" };
    expect((await call(await connect(), "verify_ledger")).isError).toBe(true);
  });

  it("says when core is older than the connector, instead of a bare not found", async () => {
    const out = await call(await connect(), "recent_ledger");
    expect(out.isError).toBe(true);
    expect(out.text).toContain("older than the connector");
  });

  it("says a broken chain is broken, and where, but never the count or head", async () => {
    routes["GET /v1/ledger/verify"] = { status: 200, body: { ok: false, count: 41, head: "abc123", firstBad: { seq: 42, reason: "entry_hash does not match the entry's contents" } } };
    const out = await call(await connect(), "verify_ledger");
    expect(out.text).toContain("BROKEN at entry 42: entry_hash does not match");
    expect(out.text).not.toContain("41");
    expect(out.text).not.toContain("abc123");
  });
});

describe("waiting_on_me", () => {
  it("needs a person, and doesn't ask core without one", async () => {
    const out = await call(await connect({ person: null }), "waiting_on_me");
    expect(out.isError).toBe(true);
    expect(out.text).toContain("CLEARANCE_PERSON");
    expect(seen).toEqual([]);
  });

  it("lists the cards from the person's inbox", async () => {
    routes["GET /v1/inbox?user=sam"] = {
      status: 200,
      body: { user: "sam", count: 1, text: "", items: [{ request_id: "CLR-0004", handle: null, class: "refund", tier: "high", typed: true, what: "refund ₹40,000", room: "#support", age_s: 30, expires_at: "2026-11-04T08:55:00.000Z", card_room: "dm-sam", shared_in: null }] },
    };
    const out = await call(await connect(), "waiting_on_me");
    expect(out.text).toContain("1 waiting on sam. Answer each card in Switch.");
    expect(out.text).toContain("CLR-0004 · refund, high · refund ₹40,000 · in your direct room · asks you to type a value");
  });
});

describe("explain_request", () => {
  it("asks core for that request only, and refuses an id that isn't one before asking", async () => {
    const client = await connect();
    const bad = await call(client, "explain_request", { request_id: "../ledger/verify" });
    expect(bad.isError).toBe(true);
    expect(seen).toEqual([]);
    routes["GET /v1/requests/clr-0004/explain"] = {
      status: 200,
      body: { ...SUMMARY, why: "CLR-0004 → rule refund (HIGH).", hold_summary: "refunds over ₹10,000 need finance approval", flags: [{ code: "new_destination", text: "UPI added 4 min ago" }], call: ["Refund ₹40,000"], context: [], cannot_decide: [{ name: "Priya", why: "requester" }] },
    };
    const out = await call(client, "explain_request", { request_id: "clr-0004" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Why: CLR-0004 → rule refund (HIGH).");
    expect(out.text).toContain("Can't decide: Priya (requester)");
    expect(out.text).toContain("Flags: UPI added 4 min ago");
  });

  it("passes on core's not found", async () => {
    routes["GET /v1/requests/CLR-9999/explain"] = { status: 404, body: { error: "no request CLR-9999" } };
    expect(await call(await connect(), "explain_request", { request_id: "CLR-9999" })).toEqual({ isError: true, text: "Clearance couldn't answer: no request CLR-9999" });
  });
});

describe("dry_run", () => {
  it("takes either a shell line or an operation with args, and asks core nothing otherwise", async () => {
    const client = await connect();
    for (const args of [{}, { shell: "ls", operation: "refund", args: {} }, { operation: "refund" }, { shell: "ls", args: { a: 1 } }]) {
      expect((await call(client, "dry_run", args)).isError).toBe(true);
    }
    expect((await call(client, "dry_run", { operation: "approve", args: {} })).isError).toBe(true);
    expect(seen).toEqual([]);
  });

  it("posts the call and says what would happen, and that nothing was recorded", async () => {
    routes["POST /v1/dry-run"] = {
      status: 200,
      body: {
        decision: "hold",
        reason: "HELD: refunds over ₹10,000 need finance approval",
        class: "refund",
        tier: "high",
        step: "class_hold",
        agent: "refunds-agent",
        policy_mode: "enforce",
        recorded: false,
        flags: [],
        what: "REFUND ₹40,000",
        already_open: null,
        quorum_required: 1,
        requested_by: ["Priya"],
        would_ask: ["Sam"],
        can_decide: ["Sam", "Neha"],
        cannot_decide: [{ name: "Priya", why: "requester, agent owner" }],
        fallback: null,
        why: "This call → rule refund (HIGH).",
      },
    };
    const out = await call(await connect(), "dry_run", { operation: "refund", args: { order_id: "A-2004", amount: 40000 }, agent: "refunds-agent" });
    expect(out.isError).toBe(false);
    expect(out.text).toContain("Would be HELD (class refund, tier high) for refunds-agent. Nothing was recorded");
    expect(out.text).toContain("Would ask first: Sam. Could decide: Sam, Neha (needs 1).");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ operation: "refund", args: { order_id: "A-2004", amount: 40000 }, agent: "refunds-agent" });
  });

  it("won't present an answer that says it recorded something as a dry run", async () => {
    routes["POST /v1/dry-run"] = { status: 200, body: { decision: "hold", reason: "HELD", agent: "coder", policy_mode: "enforce", recorded: true } };
    const out = await call(await connect(), "dry_run", { shell: "git push --force origin main" });
    expect(out.isError).toBe(true);
    expect(out.text).not.toContain("Would be HELD");
  });

  it("passes on core's refusal of arguments the gate wouldn't take", async () => {
    routes["POST /v1/dry-run"] = { status: 400, body: { error: "args: Unrecognized key(s) in object: 'note'" } };
    const out = await call(await connect(), "dry_run", { operation: "refund", args: { order_id: "A-2004", amount: 1, note: "x" } });
    expect(out).toEqual({ isError: true, text: "Clearance couldn't answer: args: Unrecognized key(s) in object: 'note'" });
  });
});

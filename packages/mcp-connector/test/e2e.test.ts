/**
 * The connector against a real core over HTTP, with the repo's policy and team and synthetic systems of record: every tool
 * answers from core's own routes, and all of them together write nothing. Then the bin itself, under plain node over stdio,
 * as Claude Code, Claude Desktop or Cursor would start it. Chat and the gate are stubs: nothing here reaches Switch.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Action, ChatPort, GatePort, LookupPort } from "@clearance/contracts";
import { buildServer, createClearanceCore, type Clearance } from "@clearance/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreClient } from "../src/client.ts";
import { buildConnectorServer, TOOL_NAMES } from "../src/tools.ts";

const INTERNAL = "e2e-internal-token-0123456789abcdef0123";
const HOOK = "e2e-coder-hook-token-0123456789abcdef";
const POLICY = fileURLToPath(new URL("../../../policy/", import.meta.url));
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const NOW = Date.parse("2026-11-04T14:00:00+05:30");

const PRIYA = "@switch-user-priya:localhost";
const IDENTITIES = {
  people: {
    priya: { switchUserId: "u-priya", participantIds: [PRIYA], mattermostUser: "priya" },
    sam: { switchUserId: "u-sam", participantIds: ["@switch-user-sam:localhost"], mattermostUser: "sam" },
    neha: { switchUserId: "u-neha", participantIds: ["@switch-user-neha:localhost"], mattermostUser: "neha" },
    alex: { switchUserId: "u-alex", participantIds: ["@switch-user-alex:localhost"], mattermostUser: "alex" },
    dev: { switchUserId: "u-dev", participantIds: ["@switch-user-dev:localhost"], mattermostUser: "dev" },
  },
  agents: {
    clearance: { switchAgentId: "ag-clearance", participantId: "@switch-agent-clearance:localhost" },
    "refunds-agent": { switchAgentId: "ag-refunds", participantId: "@switch-agent-refunds:localhost" },
  },
};

/** Synthetic systems of record, from policy/tests/world.yaml. */
const WORLD: Record<string, Record<string, Record<string, unknown>>> = {
  orders: { "A-2004": { id: "A-2004", customer_id: "cus_2044", total: 40000, status: "paid" } },
  customers: { cus_2044: { id: "cus_2044", name: "Rohan S.", email: "rohan@example.in", default_destination: "rohan.s@okhdfc" } },
  destinations: { "rohan.s@okhdfc": { id: "rohan.s@okhdfc", customer_id: "cus_2044", upi: "rohan.s@okhdfc", age_hours: 2000 } },
};
const REFUND = { order_id: "A-2004", customer_id: "cus_2044", amount: 40000, destination: "rohan.s@okhdfc" };

let dir: string;
let core: Clearance;
let app: ReturnType<typeof buildServer>;
let coreUrl: string;
const clients: Client[] = [];

function chatStub(): ChatPort {
  let next = 0;
  return {
    openCard: async (input) => {
      next += 1;
      return { sessionId: `session-${next}`, switchRequestId: input.requestId ?? `sw-${next}` };
    },
    closeCard: async () => undefined,
    postMessage: async () => ({}),
    sendTargeted: async () => undefined,
    ensureDirectRoom: async ({ userName }) => ({ roomId: `dm-${userName}` }),
    upsertDocument: async () => undefined,
  };
}
const gateStub: GatePort = { execute: async () => ({ ok: true, alreadyExecuted: false }), edit: async () => ({ ok: false, error: "not here" }) };
const lookupStub: LookupPort = { lookup: async (kind, id) => WORLD[kind]?.[id] ?? null };

function refund(id: string): Action {
  return {
    id,
    at: new Date(NOW).toISOString(),
    source: "gate",
    vendor: "gate",
    agent: { name: "refunds-agent" },
    session: { switchRoomId: "#support", threadId: "t-77" },
    kind: "business",
    raw: REFUND,
    business: { endpoint: "POST /acme/refunds", args: REFUND },
  };
}

/** Every row of every table. */
function everything(): Record<string, unknown[]> {
  const { db } = core.stores;
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
}

function tokenFile(token: string): string {
  const file = join(dir, "core-token");
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "clearance-mcp-e2e-"));
  const identitiesPath = join(dir, "identities.json");
  writeFileSync(identitiesPath, JSON.stringify(IDENTITIES));
  core = createClearanceCore({
    dbPath: join(dir, "clearance.sqlite"),
    policyPath: join(POLICY, "clearance.policy.yaml"),
    teamPath: join(POLICY, "team.yaml"),
    identitiesPath,
    rollDrills: false,
    chat: chatStub(),
    gate: gateStub,
    lookup: lookupStub,
    clock: { nowMs: () => NOW, scaledMs: (ms) => ms },
  });
  app = buildServer(core, { internalToken: INTERNAL });
  await app.listen({ port: 0, host: "127.0.0.1" });
  coreUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  // Priya asks the refunds agent in #support, and its refund is held for finance.
  await core.onMessage({ roomId: "#support", threadId: "t-77", messageId: "m-1", sender: PRIYA, addressed: false, body: "@refunds-agent refund it", timestampMs: 0 });
  const held = await core.check(refund("e2e-action-1"));
  expect(held).toMatchObject({ decision: "hold", request_id: "CLR-0001" });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await app.close();
  core.close();
  rmSync(dir, { recursive: true, force: true });
});

async function connect(token: string, person: string | null = "sam"): Promise<Client> {
  const server = buildConnectorServer(createCoreClient({ coreUrl, token, timeoutMs: 5000 }), { person });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "connector-e2e", version: "1.0.0" });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: result.isError === true, text: result.content.map((item) => item.text).join("\n") };
}

describe("against a real core", () => {
  it("answers every tool from core, and all of them together write nothing", async () => {
    const client = await connect(INTERNAL);
    const before = everything();

    const pending = await call(client, "pending_requests");
    expect(pending.text).toContain("CLR-0001 · refund, high · REFUND ₹40,000 · waiting on you");
    expect(pending.text).toContain("asked by Priya");
    expect(pending.text).toContain("can decide: Sam, Neha");

    const mine = await call(client, "waiting_on_me");
    expect(mine.text).toContain("1 waiting on sam");
    expect(mine.text).toContain("CLR-0001 · refund, high");

    const why = await call(client, "explain_request", { request_id: "CLR-0001" });
    expect(why.text).toContain("Why: CLR-0001 → rule refund");
    expect(why.text).toContain("Can't decide: Priya (requester, agent owner)");
    expect(why.text).toContain("Held because: refunds over ₹10,000 need finance approval");

    const ledger = await call(client, "recent_ledger", { limit: 5 });
    expect(ledger.text).toMatch(/#\d+ \S+ held CLR-0001/);

    expect((await call(client, "verify_ledger")).text).toBe("The ledger's hash chain verifies, from the first entry to the last.");

    // The same refund again, with who and where left for the gate to fill: it finds CLR-0001, which a real call would join.
    // Its tier is the second call's own, counted with the first in the 24 h total, as a real check would answer it.
    const dry = await call(client, "dry_run", { operation: "refund", args: { order_id: "A-2004", amount: 40000 }, agent: "refunds-agent" });
    expect(dry.isError).toBe(false);
    expect(dry.text).toMatch(/^Would be HELD \(class refund, tier \w+\) for refunds-agent\. Nothing was recorded/);
    expect(dry.text).toContain("CLR-0001 is already open for this exact call");
    const push = await call(client, "dry_run", { shell: "git push --force origin main", agent: "refunds-agent" });
    expect(push.text).toContain("Would be HELD (class merge");
    const safe = await call(client, "dry_run", { shell: "ls -la", agent: "refunds-agent" });
    expect(safe.text).toContain("Would be ALLOWED");

    expect(everything()).toEqual(before);
  });

  it("is refused everything with an agent's hook token, and with a wrong one", async () => {
    for (const token of [HOOK, "not-the-internal-token-at-all-0123"]) {
      const client = await connect(token);
      for (const name of TOOL_NAMES) {
        const args = name === "explain_request" ? { request_id: "CLR-0001" } : name === "dry_run" ? { shell: "git push --force origin main" } : {};
        const out = await call(client, name, args);
        expect(out.isError, name).toBe(true);
        expect(out.text, name).toContain("refused the connector's token");
        expect(out.text).not.toContain(token);
      }
    }
  });
});

describe("the bin, under plain node over stdio", { timeout: 30_000 }, () => {
  it("starts from a token file, lists its tools and answers", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--disable-warning=ExperimentalWarning", MAIN],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CLEARANCE_CORE_URL: coreUrl, CLEARANCE_TOKEN_FILE: tokenFile(INTERNAL), CLEARANCE_PERSON: "neha" },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const client = new Client({ name: "connector-stdio", version: "1.0.0" });
    await client.connect(transport);
    clients.push(client);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect((await call(client, "verify_ledger")).text).toContain("verifies");
    expect((await call(client, "pending_requests")).text).toContain("CLR-0001");
    expect(stderr).not.toContain(INTERNAL);
  });

  it("refuses to start on the placeholder, and never prints a token", async () => {
    const { spawnSync } = await import("node:child_process");
    for (const env of [{ CLEARANCE_INTERNAL_TOKEN: "change-me" }, { CLEARANCE_TOKEN_FILE: join(dir, "missing") }, {}]) {
      const out = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN], {
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CLEARANCE_CORE_URL: coreUrl, ...env },
        input: "",
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(out.status).toBe(1);
      expect(out.stdout).toBe("");
      expect(out.stderr).toMatch(/^clearance-mcp: /);
    }
    const open = tokenFile(INTERNAL);
    chmodSync(open, 0o644);
    const leaked = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CLEARANCE_TOKEN_FILE: open },
      input: "",
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(leaked.status).toBe(1);
    expect(leaked.stderr).toContain("chmod 600");
    expect(leaked.stderr + leaked.stdout).not.toContain(INTERNAL);
  });
});

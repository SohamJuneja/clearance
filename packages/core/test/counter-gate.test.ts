/**
 * F20 through the real gate: real core, real gate, real SQLite on both sides and real call hashes, over real sockets on
 * ports the OS picks. Only Acme is a stand-in, and all it does is count. The question this answers is the one that
 * matters: how many refunds go out, and for how much.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatePort } from "@clearance/contracts";
import { buildGateServer, createGateClient } from "@clearance/gate";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { createClearanceCore, type Clearance } from "../src/core.js";
import { FakeChat, FakeClock, FakeLookup, type OpenedCard } from "./fakes.js";
import { chatMessage, DRILLS_PATH, IDENTITIES, MINUTE, NOW, PARTICIPANTS, POLICY_PATH, REFUND_CRITICAL, REFUND_SC4, TEAM_PATH, WORLD } from "./harness.js";

const INTERNAL = "i".repeat(32);
const AGENT_TOKEN = "a".repeat(32);

type Refund = { body: Record<string, unknown>; key: string | undefined };

let core: Clearance;
let chat: FakeChat;
let clock: FakeClock;
let api: FastifyInstance;
let gate: FastifyInstance;
let gateUrl: string;
let acme: Server;
let refunds: Refund[];
let acmeUp: boolean;

beforeEach(async () => {
  refunds = [];
  acmeUp = true;
  acme = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += String(chunk)));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/refunds" && acmeUp) {
        const key = req.headers["idempotency-key"];
        refunds.push({ body: JSON.parse(raw) as Record<string, unknown>, key: typeof key === "string" ? key : undefined });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: `re_${refunds.length}` }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((done) => acme.listen(0, "127.0.0.1", done));

  const dir = mkdtempSync(join(tmpdir(), "clearance-counter-gate-"));
  const identitiesPath = join(dir, "identities.json");
  writeFileSync(identitiesPath, JSON.stringify(IDENTITIES));
  chat = new FakeChat();
  clock = new FakeClock(NOW);
  let real: GatePort | null = null;
  const port: GatePort = {
    execute: (requestId, callHash) => (real as GatePort).execute(requestId, callHash),
    edit: (requestId, edit) => (real as GatePort).edit(requestId, edit),
  };
  core = createClearanceCore({
    dbPath: join(dir, "core.sqlite"),
    policyPath: POLICY_PATH,
    teamPath: TEAM_PATH,
    identitiesPath,
    drillsPath: DRILLS_PATH,
    rollDrills: false,
    chat,
    gate: port,
    lookup: new FakeLookup(WORLD),
    clock,
  });
  api = buildServer(core, { internalToken: INTERNAL });
  const coreUrl = await api.listen({ port: 0, host: "127.0.0.1" });
  gate = buildGateServer({
    agentTokens: { [AGENT_TOKEN]: { agent: "refunds-agent", classes: ["refund"] } },
    coreUrl,
    acmeUrl: `http://127.0.0.1:${(acme.address() as AddressInfo).port}`,
    acmeAdminKey: "k".repeat(32),
    internalToken: INTERNAL,
    dbPath: join(dir, "gate.sqlite"),
  });
  gateUrl = await gate.listen({ port: 0, host: "127.0.0.1" });
  real = createGateClient({ baseUrl: gateUrl, internalToken: INTERNAL });
});

afterEach(async () => {
  await gate?.close();
  await api.close();
  core.close();
  await new Promise((done) => acme.close(done));
});

const agentHeaders = { authorization: `Bearer ${AGENT_TOKEN}`, "content-type": "application/json" };
const asAgent = async (args: Record<string, unknown>) => {
  const response = await fetch(`${gateUrl}/acme/refunds`, { method: "POST", headers: agentHeaders, body: JSON.stringify(args) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};
const pending = async (id: string) => (await (await fetch(`${gateUrl}/pending/${id}`, { headers: agentHeaders })).json()) as Record<string, unknown>;
const internalExecute = async (id: string, callHash: string) => {
  const response = await fetch(`${gateUrl}/internal/execute/${id}`, {
    method: "POST",
    headers: { authorization: `Bearer ${INTERNAL}`, "content-type": "application/json" },
    body: JSON.stringify({ call_hash: callHash }),
  });
  return (await response.json()) as Record<string, unknown>;
};

const say = (who: string, body: string) => core.onMessage(chatMessage(who, body, { addressed: true, roomId: "#finance", threadId: undefined as unknown as string }));
const typed = (card: OpenedCard, who: string, text: string) =>
  core.onApprovalOutcome({
    sessionId: card.sessionId,
    switchRequestId: card.switchRequestId,
    kind: "questions",
    state: "answered",
    answer: null,
    answers: [{ question_id: card.questions[0]?.id ?? "x", custom_text: text, selected_option_ids: [] }],
    answeredBy: who,
    answeredAtMs: clock.nowMs(),
  });
const lastCounter = () => chat.cards.filter((card) => card.title.includes("COUNTER")).at(-1) as OpenedCard;
const state = (id: string) => core.stores.requests.require(id).state;
const others = (id: string) => core.listRequests().map((row) => row.id as string).filter((other) => other !== id);

async function held(args: Record<string, unknown>): Promise<string> {
  await core.onMessage(chatMessage(PARTICIPANTS.priya, "@refunds-agent refund it"));
  const { status, body } = await asAgent(args);
  expect(status).toBe(202);
  return body.request_id as string;
}

describe("an edit through the real gate", () => {
  it("sends one refund, for the edited amount, with everything else as the agent asked", async () => {
    const id = await held(REFUND_SC4);
    await say(PARTICIPANTS.sam, `@clearance counter ${id} 4000`);
    expect(refunds).toEqual([]);
    await typed(lastCounter(), PARTICIPANTS.sam, '"hdfc"');
    const [next] = others(id) as [string];

    expect(state(id)).toBe("EDITED");
    expect(state(next)).toBe("EXECUTED");
    expect(refunds).toEqual([{ body: { ...REFUND_SC4, amount: 4000 }, key: next }]);

    expect(await pending(id)).toMatchObject({ status: "edited", state: "EDITED", edited_to: next });
    expect(await pending(next)).toMatchObject({ status: "executed", state: "EXECUTED" });
  });

  it("the original can't be made to run afterwards, by anyone", async () => {
    const id = await held(REFUND_SC4);
    const originalHash = core.stores.requests.require(id).callHash;
    await say(PARTICIPANTS.sam, `@clearance counter ${id} 4000`);
    await typed(lastCounter(), PARTICIPANTS.sam, '"hdfc"');
    expect(await internalExecute(id, originalHash)).toMatchObject({ ok: false });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.body.amount).toBe(4000);
  });

  it("the edit waiting on a second person has sent nothing, and the agent can see that", async () => {
    const id = await held(REFUND_CRITICAL);
    await say(PARTICIPANTS.sam, `@clearance counter ${id} 120000`);
    await typed(lastCounter(), PARTICIPANTS.sam, '"hdfc"');
    const [next] = others(id) as [string];
    expect(refunds).toEqual([]);
    expect(await pending(id)).toMatchObject({ status: "edited", edited_to: next });
    expect(await pending(next)).toMatchObject({ status: "pending" });

    const card = chat.cards.filter((one) => one.roomId === "dm-neha" && one.title.includes(next)).at(-1) as OpenedCard;
    await typed(card, PARTICIPANTS.neha, card.questions[0]?.id === "amount" ? '"120000"' : '"hdfc"');
    expect(state(next)).toBe("EXECUTED");
    expect(refunds).toEqual([{ body: { ...REFUND_CRITICAL, amount: 120000 }, key: next }]);
  });

  it("the agent sending the edited call itself while it waits changes nothing: still one refund", async () => {
    const id = await held(REFUND_CRITICAL);
    await say(PARTICIPANTS.sam, `@clearance counter ${id} 120000`);
    await typed(lastCounter(), PARTICIPANTS.sam, '"hdfc"');
    const [next] = others(id) as [string];

    const again = await asAgent({ ...REFUND_CRITICAL, amount: 120000 });
    expect(again.status).toBe(202);
    expect(again.body.request_id).toBe(next);

    const card = chat.cards.filter((one) => one.roomId === "dm-neha" && one.title.includes(next)).at(-1) as OpenedCard;
    await typed(card, PARTICIPANTS.neha, card.questions[0]?.id === "amount" ? '"120000"' : '"hdfc"');
    expect(state(next)).toBe("EXECUTED");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.key).toBe(next);
  });

  it("a gate that doesn't answer leaves it retrying, then gives up under the usual rule, having sent nothing", async () => {
    const id = await held(REFUND_SC4);
    await say(PARTICIPANTS.sam, `@clearance counter ${id} 4000`);
    await gate.close();
    await typed(lastCounter(), PARTICIPANTS.sam, '"hdfc"');
    const [next] = others(id) as [string];
    expect(state(id)).toBe("EDITED");
    expect(state(next)).toBe("APPROVED");
    expect(refunds).toEqual([]);

    clock.advance(6_000);
    await core.tick();
    expect(state(next)).toBe("APPROVED");
    clock.advance(5 * MINUTE);
    await core.tick();
    expect(state(next)).toBe("VOIDED");
    expect(refunds).toEqual([]);
  });

  it("a refused edit runs nothing, and neither call is left able to run", async () => {
    const id = await held(REFUND_SC4);
    const originalHash = core.stores.requests.require(id).callHash;
    // The original goes out behind core's back, the one thing that could make an edit wrong.
    expect(await internalExecute(id, originalHash)).toMatchObject({ ok: true });
    expect(refunds).toHaveLength(1);
    await say(PARTICIPANTS.sam, `@clearance counter ${id} 4000`);
    await typed(lastCounter(), PARTICIPANTS.sam, '"hdfc"');
    const [next] = others(id) as [string];
    expect(state(next)).toBe("VOIDED");
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.body.amount).toBe(REFUND_SC4.amount);
  });
});

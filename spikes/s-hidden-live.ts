/**
 * The break, end to end, on the real core and real Switch, with no room on the call, as under Switch today:
 * Priya names the agent in a room Clearance is in, and Sam asks the same agent somewhere it isn't.
 *
 * Runs packages/core/src/main.ts as its own process on a spare port with a spare database, as a throwaway agent,
 * in throwaway rooms, against a stub gate. E1 can't show this: its chat is a fake with no way to ask Switch. Real
 * agents and rooms aren't touched. Prints no secrets. `spikes/s-inbox-cleanup.ts --delete` removes what it made.
 *
 * CLEARANCE_ENV_FILE=<.env> SWITCH_ENV_FILE=<vendor .env> CLEARANCE_DATA_DIR=<data> pnpm exec tsx spikes/s-hidden-live.ts <scratch dir>
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { createSwitchAgent, type SwitchAgent } from "../packages/switch-agent/src/agent.js";
import { registerAgent } from "../packages/switch-agent/src/register.js";
import { BRIDGE_URL, MATTERMOST_URL, identities, mattermost, say, secrets, sleep, waitFor, type MattermostPost } from "./lib.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = process.argv[2];
if (!scratch) throw new Error("give a scratch directory");
mkdirSync(scratch, { recursive: true });

const CORE_PORT = 7791;
const GATE_PORT = 7793;
const CACHE_MS = 5_500;
const stamp = Date.now().toString(36);
const CLEARANCE = `spike-clr-${stamp}`;
const TARGET = `spike-tgt-${stamp}`;
const SECOND = `spike-tg2-${stamp}`;
const GHOST = `spike-ghost-${stamp}`;

const readEnv = (path: string) =>
  Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "")]),
  );
const switchEnv = readEnv(process.env.SWITCH_ENV_FILE!);
const personaPassword = readEnv(process.env.CLEARANCE_ENV_FILE!).PERSONA_PASSWORD!;

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  say(`${ok ? "  ok  " : " FAIL "} ${what}`);
  if (!ok) failures.push(what);
};

const init = (method: string, cookie: string | null, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const login = async (email: string, password: string) => {
  const res = await fetch(`${BRIDGE_URL}/gateway/auth/login`, init("POST", null, { email, password }));
  if (!res.ok) throw new Error(`login as ${email}: ${res.status}`);
  return res.headers.getSetCookie()[0]!.split(";")[0]!;
};
const gateway = async (cookie: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${BRIDGE_URL}/gateway${path}`, init(method, cookie, body));
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON.
  }
  return { status: res.status, body: parsed as Record<string, unknown> };
};
const register = async (cookie: string, name: string) => {
  const key = await gateway(cookie, "POST", "/api-keys", { label: `spike-reach-${stamp}` });
  const made = await registerAgent({ bridgeUrl: BRIDGE_URL, registrationKey: String(key.body.key), name, description: "Throwaway: is the agent working somewhere Clearance can't see?" });
  await gateway(cookie, "DELETE", `/api-keys/${String(key.body.id)}`);
  return { name, agentId: made.agentId, apiKey: made.apiKey };
};

const clearanceAdmin = await login("clearance-admin@clearance.example", secrets.clearanceAdminPassword);
const priya = await login("priya@clearance.example", personaPassword);
const samCookie = await login("sam@clearance.example", personaPassword);
const observer = await register(clearanceAdmin, CLEARANCE);
const target = await register(priya, TARGET);
const second = await register(priya, SECOND);
await gateway(clearanceAdmin, "PUT", `/agents/${observer.agentId}/addressing-policy`, {
  policy: { rules: [{ users: Object.values(identities.people).map((person) => person.externalUserRowId), agents: "*", owner: true }] },
});
// Addressing anyone, as every real agent reads today.
for (const agent of [target, second]) await gateway(priya, "PUT", `/agents/${agent.agentId}/addressing-policy`, { policy: null });

const setup = createSwitchAgent({ bridgeUrl: BRIDGE_URL, agentId: observer.agentId, apiKey: observer.apiKey });
await setup.start({});
const roomId = (await setup.op<{ id: string }>("create_room", { name: `spike-inbox-seen-${stamp}`, description: "Throwaway", agent_names: [CLEARANCE, TARGET, SECOND], user_names: ["sam", "priya"], channel_type: "channel_private" })).id;
const hands = { sam: mattermost("sam"), neha: mattermost("neha"), priya: mattermost("priya") };
const botOf = async (name: string) =>
  waitFor(`${name}'s bot`, async () => {
    const res = await hands.sam.call("GET", `/users/username/${name}`);
    return res.status === 200 ? (res.body as unknown as { id: string }) : undefined;
  }, 30_000);
const observerBot = await botOf(CLEARANCE);

/** Writes to a bot directly until Switch has made the room: a brand new bot isn't known to the bridge at once. */
const openDirect = async (who: "sam" | "neha", bot: { id: string }, agentOps: () => Promise<{ room_id: string; name: string }[]>, wanted: string, body = "hello") => {
  const direct = await hands[who].call("POST", "/channels/direct", [identities.people[who]!.mattermostUserId, bot.id]);
  const channelId = String(direct.body.id);
  let said = 0;
  const room = await waitFor(`${who}'s direct room`, async () => {
    if (Date.now() - said > 5_000) {
      await hands[who].post(channelId, body);
      said = Date.now();
    }
    return (await agentOps()).find((entry) => entry.name === wanted);
  }, 60_000);
  return { channelId, roomId: room.room_id };
};
const listRooms = (agent: { agentId: string; apiKey: string }) => async () => {
  const res = await fetch(`${BRIDGE_URL}/agents/${agent.agentId}/ops/list_rooms`, {
    method: "POST",
    headers: { authorization: `Bearer ${agent.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  return ((await res.json()) as { result: { room_id: string; name: string }[] }).result;
};
const samDm = await openDirect("sam", observerBot, listRooms(observer), `Mattermost: sam / ${CLEARANCE}`);
const nehaDm = await openDirect("neha", observerBot, listRooms(observer), `Mattermost: neha / ${CLEARANCE}`);
const channelOfRoom = (await setup.op<{ external_channel_id: string }>("get_room_detail", { room_id: roomId })).external_channel_id;
await setup.stop();

// ── A spare core, knowing the throwaway agents as team agents ────────────────
const dataDir = join(scratch, "data");
mkdirSync(dataDir, { recursive: true });
const internalToken = randomBytes(24).toString("hex");
writeFileSync(
  join(dataDir, "identities.json"),
  JSON.stringify({ people: identities.people, unlinked: identities.unlinked, agents: { clearance: { switchAgentId: observer.agentId } }, bridgeId: identities.bridgeId, mattermostTeam: identities.mattermostTeam, rooms: { "#seen": roomId } }),
  { mode: 0o600 },
);
// Without the real Clearance bot's token, which this core has no business holding.
const { clearance: _realBot, ...personaTokens } = secrets.mattermostTokens;
writeFileSync(join(dataDir, "secrets.json"), JSON.stringify({ mattermostTokens: personaTokens, switchAgentKeys: { clearance: observer.apiKey } }), { mode: 0o600 });
writeFileSync(join(dataDir, "hook-tokens.json"), JSON.stringify({ [randomBytes(24).toString("hex")]: "coder" }), { mode: 0o600 });
const teamPath = join(scratch, "team.yaml");
const entry = (name: string) => `  ${name}: { cwd: "~/.switch/agents/<host>/${name}", owner: priya, vendor: claude }\n`;
writeFileSync(teamPath, readFileSync(join(ROOT, "policy/team.yaml"), "utf8").replace(/^agents:.*\n/m, (line) => `${line}${entry(TARGET)}${entry(SECOND)}${entry(GHOST)}`));

const world = parse(readFileSync(join(ROOT, "policy/tests/world.yaml"), "utf8")) as Record<string, Record<string, unknown>>;
const executed: string[] = [];
const gate = createServer((req, res) => {
  const parts = (req.url ?? "").split("/").map(decodeURIComponent);
  res.setHeader("content-type", "application/json");
  if (parts[2] === "lookup") {
    const value = world[parts[3]!]?.[parts[4]!];
    res.statusCode = value ? 200 : 404;
    res.end(JSON.stringify(value ?? { error: "not found" }));
    return;
  }
  executed.push(parts[3]!);
  res.end(JSON.stringify({ ok: true, alreadyExecuted: false, status: 200, result: { id: "re_spike" } }));
});
await new Promise<void>((done) => gate.listen(GATE_PORT, "127.0.0.1", done));

const core = spawn(process.execPath, ["--import", "tsx", join(ROOT, "packages/core/src/main.ts")], {
  cwd: ROOT,
  env: {
    ...process.env,
    CLEARANCE_INTERNAL_TOKEN: internalToken,
    CLEARANCE_DATA_DIR: dataDir,
    CLEARANCE_DB_PATH: join(scratch, "core.sqlite"),
    CLEARANCE_CORE_PORT: String(CORE_PORT),
    CLEARANCE_GATE_URL: `http://127.0.0.1:${GATE_PORT}`,
    CLEARANCE_AGENT_NAME: CLEARANCE,
    CLEARANCE_TEAM_PATH: teamPath,
    CLEARANCE_TIME_SCALE: "1",
    CLEARANCE_DRILL_RATE: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let coreLog = "";
for (const stream of [core.stdout, core.stderr]) stream.on("data", (chunk: Buffer) => (coreLog += chunk.toString()));
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${CORE_PORT}${path}`, {
    method,
    headers: { authorization: `Bearer ${internalToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await res.json()) as Record<string, unknown>;
};

type Held = { id: string; quorum: number; requesters: string[]; flags: { code: string; text: string }[] };
let amount = 40_000;
/** No session on the action: under Switch a managed agent's call doesn't say which room it came from. */
const holdFor = async (agent: string): Promise<Held> => {
  amount += 100;
  const args = { order_id: "A-2004", customer_id: "cus_2044", amount, destination: "rohan.s@okhdfc" };
  const startedAt = Date.now();
  const body = await api("POST", "/v1/check", {
    action: { id: `spike-${randomUUID()}`, at: new Date().toISOString(), source: "gate", vendor: "gate", agent: { name: agent }, kind: "business", raw: args, business: { endpoint: "POST /acme/refunds", args } },
  });
  if (body.decision !== "hold") throw new Error(`expected a hold: ${JSON.stringify(body).slice(0, 200)}`);
  const id = String(body.request_id);
  const request = await api("GET", `/v1/requests/${id}`);
  say(`    ${id}: quorum ${String(request.quorum_required)}, requesters ${JSON.stringify(request.requester_ids)}, flags ${JSON.stringify((request.flags as { code: string }[]).map((flag) => flag.code))}, answered in ${Date.now() - startedAt} ms`);
  return { id, quorum: Number(request.quorum_required), requesters: request.requester_ids as string[], flags: request.flags as Held["flags"] };
};
const cardIn = async (who: "sam" | "neha", channelId: string, id: string): Promise<MattermostPost | undefined> => {
  const posts = await hands[who].posts(channelId);
  return posts.find((post) => post.message.includes(id) && (post.props.attachments?.flatMap((attachment) => attachment.actions ?? []).length ?? 0) > 0);
};
const answerByCode = async (who: "sam" | "neha", channelId: string, id: string) => {
  const card = await waitFor(`${who}'s card for ${id}`, () => cardIn(who, channelId, id), 10_000);
  const code = /request `(A\d+)`/.exec(card.message)?.[1];
  await hands[who].post(channelId, `${code} yes`);
};
const stateOf = async (id: string) => String((await api("GET", `/v1/requests/${id}`)).state);
const cancel = (id: string) => api("POST", `/v1/requests/${id}/cancel`, {});
const priyaAsks = async (agent: string) => {
  await hands.priya.post(channelOfRoom, `@${agent} refund order A-2004 in full`);
  await sleep(700);
};

let code = 0;
let secondLive: SwitchAgent | null = null;
try {
  await waitFor("core to listen", () => (coreLog.includes("Switch agent connected") ? true : undefined), 40_000);
  say(`spare core on ${CORE_PORT} as ${CLEARANCE}, spare database, stub gate. Calls carry no room, as under Switch.`);

  say("\n[1] Normal: the agent is only in rooms Clearance is in");
  await priyaAsks(TARGET);
  const normal = await holdFor(TARGET);
  check(normal.quorum === 1 && normal.requesters.join() === "priya", "quorum stays 1, with Priya on record");
  check(!normal.flags.some((flag) => flag.code.startsWith("agent_")), "and no flag about where it is working");
  check((await waitFor("Sam's card", () => cardIn("sam", samDm.channelId, normal.id), 10_000)) !== undefined, "Sam gets the card");
  await sleep(600);
  check((await cardIn("neha", nehaDm.channelId, normal.id)) === undefined, "Neha doesn't");
  await cancel(normal.id);

  say("\n[2] The break: Sam writes to the same agent in a Mattermost direct room Clearance isn't in");
  const targetBot = await botOf(TARGET);
  await openDirect("sam", targetBot, listRooms(target), `Mattermost: sam / ${TARGET}`, "refund order A-2004 in full please");
  await priyaAsks(TARGET);
  await sleep(CACHE_MS);
  const held = await holdFor(TARGET);
  check(held.quorum === 2, "quorum becomes 2, though Priya is on record");
  const wording = "This agent is also working somewhere Clearance can't see, so this needs two approvals from different people.";
  check(held.flags.some((flag) => flag.text === wording), "the request says why, in plain words");
  const samCard = await waitFor("Sam's card", () => cardIn("sam", samDm.channelId, held.id), 10_000);
  check(samCard.message.includes("can't see"), "and so does the card Sam reads");
  await answerByCode("sam", samDm.channelId, held.id);
  await sleep(1_500);
  check(executed.length === 0, "Sam approves alone: nothing runs");
  check((await stateOf(held.id)) === "ROUTED", "the request stays open");
  await answerByCode("neha", nehaDm.channelId, held.id);
  await waitFor(`${held.id} to run`, async () => ((await stateOf(held.id)) === "EXECUTED" ? true : undefined), 15_000);
  check(executed.filter((id) => id === held.id).length === 1, "Neha approves too: it runs, once");

  say("\n[3] A private chat in Switch, which is read_visibility private. Clearance's owner can't read it");
  const chat = await gateway(samCookie, "POST", "/chats", { agentId: second.agentId, name: `spike-chat-${stamp}`, requestId: randomUUID() });
  const summary = (chat.body as { chat?: { id?: string; roomId?: string } }).chat;
  const chatRoom = String(summary?.roomId ?? summary?.id);
  check(chat.status < 300, `Sam can start one with an agent addressable by anyone (HTTP ${chat.status})`);
  await priyaAsks(SECOND);
  const quiet = await holdFor(SECOND);
  say("    A member of the chat, no live session in it. This is how a managed agent looks, since Switch doesn't know where its sessions are:");
  check(quiet.quorum === 1, "NOT detected: quorum stays 1. This is the stated limit");
  await cancel(quiet.id);

  secondLive = createSwitchAgent({ bridgeUrl: BRIDGE_URL, agentId: second.agentId, apiKey: second.apiKey });
  await secondLive.start({});
  await secondLive.op("list_participants", {}, { roomId: chatRoom });
  await sleep(500);
  await priyaAsks(SECOND);
  await sleep(CACHE_MS);
  const seen = await holdFor(SECOND);
  check(seen.quorum === 2 && seen.flags.some((flag) => flag.code === "agent_elsewhere"), "A protocol agent with a live session there is detected: quorum 2");
  await cancel(seen.id);

  say("\n[4] An agent Switch doesn't know, so nobody can say where it is");
  const ghost = await holdFor(GHOST);
  check(ghost.quorum === 2 && ghost.flags.some((flag) => flag.code === "agent_reach_unknown"), "the cautious side: quorum 2, and it says it couldn't check");
  await cancel(ghost.id);

  const verify = await api("GET", "/v1/ledger/verify");
  check(verify.ok === true, `the ledger verifies (${String(verify.count)} entries)`);
  const noise = coreLog.split("\n").filter((line) => line.trim() && !line.includes("Switch agent connected"));
  say(`\ncore's log, ${noise.length} lines other than the start: ${JSON.stringify(noise.slice(0, 4).map((line) => line.slice(0, 150)))}`);
} catch (error) {
  code = 1;
  say(`STOPPED: ${(error as Error).message}`);
  say(`core's log: ${coreLog.slice(-1200)}`);
} finally {
  if (secondLive) await secondLive.stop().catch(() => undefined);
  core.kill("SIGTERM");
  gate.close();
  await sleep(300);
}
say(failures.length > 0 ? `\nFAILED: ${JSON.stringify(failures)}` : code === 0 ? "\nAll checks passed." : "");
say(`Mattermost: ${MATTERMOST_URL.replace(/.*:/, "port ")}. Run spikes/s-inbox-cleanup.ts --delete to remove what this made.`);
process.exit(failures.length > 0 || code !== 0 ? 1 : 0);

/**
 * F7, F8 and F15 on the live stack: the inbox within 2 seconds, answering from it, the ledger mirror, and
 * `@clearance install`.
 *
 * The stack is shared, so nothing here touches `clearance`, `support`, `eng` or the running core. It runs
 * the real packages/core/src/main.ts as its own process, on a spare port with a spare database, as a
 * throwaway agent with its own bot, in throwaway rooms, against a stub gate. It uses Sam, Neha and Alex's
 * accounts, whose direct rooms with this agent are separate from their rooms with Clearance. Prints no
 * secrets. Removes what it made unless given --keep.
 *
 * CLEARANCE_ENV_FILE=<.env> pnpm exec tsx spikes/s-inbox-live.ts <scratch dir> [--keep]
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { createSwitchAgent } from "../packages/switch-agent/src/agent.js";
import { registerAgent } from "../packages/switch-agent/src/register.js";
import { BRIDGE_URL, MATTERMOST_URL, identities, mattermost, say, secrets, sleep, waitFor, type MattermostPost } from "./lib.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = process.argv[2];
if (!scratch || scratch.startsWith("--")) throw new Error("give a scratch directory");
const keep = process.argv.includes("--keep");
mkdirSync(scratch, { recursive: true });

const CORE_PORT = 7791;
const GATE_PORT = 7793;
for (const port of [CORE_PORT, GATE_PORT]) if ([7700, 7710, 7800, 7900].includes(port)) throw new Error("that port is the live stack's");

const stamp = Date.now().toString(36);
const AGENT = `spike-clr-${stamp}`;
const INSTALL_ROOM = `spike-install-${stamp}`;
const readEnv = (path: string) =>
  Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "")]),
  );
const env = readEnv(process.env.SWITCH_ENV_FILE!);
const personaPassword = readEnv(process.env.CLEARANCE_ENV_FILE!).PERSONA_PASSWORD!;

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  say(`${ok ? "  ok  " : " FAIL "} ${what}`);
  if (!ok) failures.push(what);
};

const jsonInit = (method: string, cookie: string | null, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const loginCookie = async (email: string, password: string) => {
  const res = await fetch(`${BRIDGE_URL}/gateway/auth/login`, jsonInit("POST", null, { email, password }));
  if (!res.ok) throw new Error(`login as ${email}: ${res.status}`);
  return res.headers.getSetCookie()[0]!.split(";")[0]!;
};
const gateway = async (cookie: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${BRIDGE_URL}/gateway${path}`, jsonInit(method, cookie, body));
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON.
  }
  return { status: res.status, body: parsed as Record<string, unknown> & unknown[] };
};

// ── A throwaway agent with its own bot, and rooms for it ─────────────────────
const owner = await loginCookie("clearance-admin@clearance.example", secrets.clearanceAdminPassword);
const key = await gateway(owner, "POST", "/api-keys", { label: `spike-inbox-${stamp}` });
const registered = await registerAgent({ bridgeUrl: BRIDGE_URL, registrationKey: String(key.body.key), name: AGENT, description: "Throwaway: live check of the inbox, mirror and install." });
await gateway(owner, "DELETE", `/api-keys/${String(key.body.id)}`);
const policy = await gateway(owner, "PUT", `/agents/${registered.agentId}/addressing-policy`, {
  policy: { rules: [{ users: Object.values(identities.people).map((person) => person.externalUserRowId), agents: "*", owner: true }] },
});
if (policy.status !== 200) throw new Error(`addressing policy: ${policy.status}`);
const agent = createSwitchAgent({ bridgeUrl: BRIDGE_URL, agentId: registered.agentId, apiKey: registered.apiKey });
await agent.start({});

const makeRoom = async (name: string) => (await agent.op<{ id: string }>("create_room", { name, description: "Throwaway: live check.", agent_names: [AGENT], user_names: ["sam", "priya"], channel_type: "channel_private" })).id;
const rooms = { a: await makeRoom(`spike-inbox-a-${stamp}`), b: await makeRoom(`spike-inbox-b-${stamp}`), approvals: await makeRoom(`spike-ledger-${stamp}`) };
const hands = { sam: mattermost("sam"), alex: mattermost("alex"), neha: mattermost("neha") };
const bot = await waitFor("the agent's bot", async () => {
  const res = await hands.sam.call("GET", `/users/username/${AGENT}`);
  return res.status === 200 ? (res.body as unknown as { id: string }) : undefined;
}, 30_000);

// Each person writes to it once, as PLAN S7 has it.
const directRooms: Record<string, { channelId: string; roomId: string }> = {};
for (const name of ["sam", "neha", "alex"] as const) {
  const direct = await hands[name].call("POST", "/channels/direct", [identities.people[name]!.mattermostUserId, bot.id]);
  const channelId = String(direct.body.id);
  // A brand new bot isn't known to the bridge straight away, and a message before then opens no room.
  let said = 0;
  const room = await waitFor(`${name}'s direct room`, async () => {
    if (Date.now() - said > 5_000) {
      await hands[name].post(channelId, "hello");
      said = Date.now();
    }
    const list = await agent.op<{ room_id: string; name: string }[]>("list_rooms", {});
    return list.find((entry) => entry.name === `Mattermost: ${name} / ${AGENT}`);
  }, 60_000);
  directRooms[name] = { channelId, roomId: room.room_id };
}
const channelOf = async (roomId: string) => (await agent.op<{ external_channel_id: string }>("get_room_detail", { room_id: roomId })).external_channel_id;
const channels = { a: await channelOf(rooms.a), b: await channelOf(rooms.b), approvals: await channelOf(rooms.approvals) };

// A token for its bot, minted the way setup-identities does it.
const adminLogin = await fetch(`${MATTERMOST_URL}/api/v4/users/login`, jsonInit("POST", null, { login_id: env.MATTERMOST_ADMIN_USER, password: env.MATTERMOST_ADMIN_PASSWORD }));
const adminToken = adminLogin.headers.get("token")!;
const minted = await fetch(`${MATTERMOST_URL}/api/v4/users/${bot.id}/tokens`, {
  method: "POST",
  headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
  body: JSON.stringify({ description: "spike: inbox" }),
});
if (!minted.ok) throw new Error(`minting the bot's token: ${minted.status}`);
const botToken = String(((await minted.json()) as { token: string }).token);

// Switch's real limit on a document, against the margin the mirror keeps.
const sizedDocument = async (bytes: number) =>
  agent
    .op<{ document_id: string }>(
      "create_room_document",
      { name: `spike-size-${bytes}`, description: "Throwaway", instructions: "Throwaway", content: "x".repeat(bytes) },
      { roomId: rooms.approvals },
    )
    .then(
      (created) => ({ ok: true, id: created.document_id, why: "" }),
      (error: Error) => ({ ok: false, id: "", why: error.message.slice(0, 90) }),
    );
const atMargin = await sizedDocument(1_000_000);
const overLimit = await sizedDocument(1_048_577);
say(`Switch takes a 1,000,000 byte document: ${atMargin.ok}. A 1,048,577 byte one: ${overLimit.ok} (${overLimit.why})`);
if (!atMargin.ok || overLimit.ok) failures.push("Switch's document limit is not what the mirror assumes");
if (atMargin.ok) await agent.op("delete_room_document", { document_id: atMargin.id }, { roomId: rooms.approvals });
await agent.stop();

// ── A data folder for this agent, with the real people in it ─────────────────
const dataDir = join(scratch, "data");
mkdirSync(dataDir, { recursive: true });
// Core refuses to start without per-agent hook tokens. Nothing in this spike calls a hook.
writeFileSync(join(dataDir, "hook-tokens.json"), JSON.stringify({ [randomBytes(24).toString("hex")]: "coder" }), { mode: 0o600 });
const internalToken = randomBytes(24).toString("hex");
writeFileSync(
  join(dataDir, "identities.json"),
  JSON.stringify({
    people: identities.people,
    unlinked: identities.unlinked,
    agents: { clearance: { switchAgentId: registered.agentId } },
    bridgeId: identities.bridgeId,
    mattermostTeam: identities.mattermostTeam,
    rooms: { "#support": rooms.a, "#finance": rooms.b, "#approvals": rooms.approvals },
  }),
  { mode: 0o600 },
);
writeFileSync(
  join(dataDir, "secrets.json"),
  JSON.stringify({ mattermostTokens: { ...secrets.mattermostTokens, clearance: botToken }, switchAgentKeys: { clearance: registered.apiKey } }),
  { mode: 0o600 },
);
const templatePath = join(scratch, "template.yaml");
writeFileSync(templatePath, readFileSync(join(ROOT, "templates/clearance.template.yaml"), "utf8").replace("agents: [clearance]", `agents: [${AGENT}]`));

// ── A stand-in gate, on a spare port, that records what it is asked to run ───
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

// ── The real core, as its own process ────────────────────────────────────────
const logPath = join(scratch, "core.log");
const core = spawn(process.execPath, ["--import", "tsx", join(ROOT, "packages/core/src/main.ts")], {
  cwd: ROOT,
  env: {
    ...process.env,
    CLEARANCE_INTERNAL_TOKEN: internalToken,
    CLEARANCE_DATA_DIR: dataDir,
    CLEARANCE_DB_PATH: join(scratch, "core.sqlite"),
    CLEARANCE_CORE_PORT: String(CORE_PORT),
    CLEARANCE_GATE_URL: `http://127.0.0.1:${GATE_PORT}`,
    CLEARANCE_AGENT_NAME: AGENT,
    CLEARANCE_TEMPLATE_PATH: templatePath,
    CLEARANCE_TEMPLATE_NAME: `spike-install-${stamp}`,
    CLEARANCE_INSTALL_ROOM: INSTALL_ROOM,
    CLEARANCE_GATEWAY_URL: "http://127.0.0.1:3000",
    CLEARANCE_TIME_SCALE: "1",
    // A roll of the dice mustn't add a drill to the rounds that time the list. Step 6b sends its own.
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
await waitFor("core to listen", () => (coreLog.includes("Switch agent connected") ? true : undefined), 40_000);
say(`core is up on ${CORE_PORT} as ${AGENT}, spare database, stub gate`);

let actionNumber = 0;
const refund = (roomId: string, amount: number, order = "A-2004", customer = "cus_2044", destination = "rohan.s@okhdfc") => {
  actionNumber += 1;
  const args = { order_id: order, customer_id: customer, amount, destination };
  return {
    id: `spike-${stamp}-${actionNumber}`,
    at: new Date().toISOString(),
    source: "gate",
    vendor: "gate",
    agent: { name: "refunds-agent" },
    session: { switchRoomId: roomId },
    kind: "business",
    raw: args,
    business: { endpoint: "POST /acme/refunds", args },
  };
};
const hold = async (action: unknown) => {
  const body = await api("POST", "/v1/check", { action });
  if (body.decision !== "hold") throw new Error(`expected a hold, got ${JSON.stringify(body).slice(0, 200)}`);
  return String(body.request_id);
};

const samDm = directRooms.sam!.channelId;
const posts = async (channelId = samDm, who: keyof typeof hands = "sam") => (await hands[who].posts(channelId)).reverse();
const isInbox = (post: MattermostPost) => /\*\*Needs your response \(\d+\)\*\*/.test(post.message) && post.user_id === bot.id;
const inboxPosts = async (channelId = samDm) => (await posts(channelId)).filter(isInbox);
const buttonsOf = (post: MattermostPost) => post.props.attachments?.flatMap((attachment) => attachment.actions ?? []).length ?? 0;
const show = (post: MattermostPost) => {
  const lines = post.message.split("\n");
  const brief = lines.length > 7 ? [...lines.slice(0, 3), `... ${lines.length - 3} more lines`] : lines;
  return `    [${post.user_id === bot.id ? AGENT.slice(0, 9) : "person"}${buttonsOf(post) ? `, ${buttonsOf(post)} buttons` : ""}] ${brief.join("\n      ")}`;
};

/** Time from just before the check to the moment the person can read a list holding all these. */
const timeUntilListed = async (startedAt: number, ids: string[]) =>
  waitFor(
    `an inbox post listing ${ids.join(", ")}`,
    async () => {
      const latest = (await inboxPosts()).at(-1);
      return latest && ids.every((id) => latest.message.includes(id)) ? Date.now() - startedAt : undefined;
    },
    15_000,
  );

const settleAll = async (ids: string[]) => {
  for (const id of ids) await api("POST", `/v1/requests/${id}/cancel`, {});
  await waitFor("the list to empty", async () => ((await inboxPosts()).length === 0 ? true : undefined), 15_000);
};

let code = 0;
try {
  // ── The 2 seconds ──────────────────────────────────────────────────────────
  say("\n[1] Two requests from two rooms, within 2 seconds of being held");
  const samples: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    const startedAt = Date.now();
    const [first, second] = await Promise.all([hold(refund(rooms.a, 40_000 + round * 100)), hold(refund(rooms.b, 50_000 + round * 100))]);
    samples.push(await timeUntilListed(startedAt, [first, second]));
    await settleAll([first, second]);
  }
  say(`    together, from before the checks to the list being readable: ${samples.map((ms) => `${ms} ms`).join(", ")}`);
  check(Math.max(...samples) < 2000, `all five inside 2000 ms (worst ${Math.max(...samples)} ms)`);

  const apart: number[] = [];
  for (let round = 0; round < 3; round += 1) {
    const one = await hold(refund(rooms.a, 60_000 + round * 100));
    await timeUntilListed(Date.now(), [one]);
    await sleep(1_300);
    const startedAt = Date.now();
    const two = await hold(refund(rooms.b, 70_000 + round * 100));
    apart.push(await timeUntilListed(startedAt, [one, two]));
    if (round === 2) {
      // ── What a person sees ───────────────────────────────────────────────
      say("\n[2] What Sam's direct room looks like with two open, oldest at the top");
      for (const post of (await posts()).slice(-4)) say(show(post));
      const live = await inboxPosts();
      const open = (await posts()).filter((post) => buttonsOf(post) > 0);
      check(open.length === 2, `one card each, not doubled by a tick landing during the open (${open.length} with buttons)`);
      check(live.length === 1, `one live inbox post, not a pile (${live.length})`);
      check(live[0]!.message.includes("(2)"), "it says (2)");
      const lines = live[0]!.message.split("\n");
      check(lines[1]!.includes(two), "newest first");
      check(lines[2]!.includes(one), "older second");
      check(/#finance/.test(lines[1]!) && /#support/.test(lines[2]!), "each line names its room");
      check(!(await posts()).some((post) => post.message.includes("The card is just above")), "no line saying the card is above");

      const cards = (await posts()).filter((post) => buttonsOf(post) > 0);
      check(cards.length >= 2, `both cards have their buttons (${cards.length})`);

      // ── Answering from the inbox ─────────────────────────────────────────
      say("\n[3] Answering from the inbox handle settles the original request");
      const handleOf = (id: string) => new RegExp(`^(A\\d+) ${id}`, "m").exec(live[0]!.message)?.[1];
      const handle = handleOf(one);
      check(handle !== undefined, `the inbox line shows Switch's code for ${one}: ${handle}`);
      check(handleOf(two) !== undefined, `and for ${two}: ${handleOf(two)}`);
      const originBefore = (await hands.sam.posts(channels.a)).find((post) => post.message.includes(one) && buttonsOf(post) > 0);
      check(originBefore !== undefined, "the copy of the card in the origin room has buttons");
      const answeredAt = Date.now();
      await hands.sam.post(samDm, `${handle} yes`);
      const state = await waitFor(`${one} to settle`, async () => {
        const request = await api("GET", `/v1/requests/${one}`);
        return request.state === "EXECUTED" ? request : undefined;
      }, 15_000);
      say(`    typed "${handle} yes" in the direct room: ${String(state.state)} after ${Date.now() - answeredAt} ms`);
      check(state.approvals !== undefined && JSON.stringify(state.approvals) === '["sam"]', "counted as Sam's approval");
      check(executed.filter((id) => id === one).length === 1, "the gate was asked to run it once");
      await sleep(800);
      const originAfter = (await hands.sam.posts(channels.a)).find((post) => post.id === originBefore!.id);
      check(originAfter !== undefined && buttonsOf(originAfter) === 0, "the card in the origin room lost its buttons");
      const shrunk = await waitFor("the list to shrink", async () => {
        const latest = await inboxPosts();
        return latest.length === 1 && latest[0]!.message.includes("(1)") ? latest[0] : undefined;
      }, 5_000);
      check(shrunk.message.includes(two) && !shrunk.message.includes(one), "the list is down to the other request");

      // ── A code is only good in its room ──────────────────────────────────
      say("\n[4] The same list asked for elsewhere");
      // Starts with the word core reads, and names this spike's agent so that the message is addressed to it.
      await hands.sam.post(channels.a, `@clearance inbox @${AGENT}`);
      const elsewhere = await waitFor("the reply in the other room", async () => {
        const list = await hands.sam.posts(channels.a);
        return list.find((post) => post.user_id === bot.id && post.message.startsWith("**Needs your response"));
      }, 10_000);
      say(show(elsewhere));
      check(!/\bA\d+ CLR-/.test(elsewhere.message), "no code in another room, where it could be a different card");
      check(elsewhere.message.includes(two), "the request is listed");

      // ── Emptying ─────────────────────────────────────────────────────────
      say("\n[5] Answering the last one");
      const lastHandle = new RegExp(`^(A\\d+) ${two}`, "m").exec(shrunk.message)?.[1];
      await hands.sam.post(samDm, `${lastHandle} no`);
      await waitFor(`${two} to be denied`, async () => ((await api("GET", `/v1/requests/${two}`)).state === "DENIED" ? true : undefined), 15_000);
      await waitFor("the post to go", async () => ((await inboxPosts()).length === 0 ? true : undefined), 5_000);
      check(executed.filter((id) => id === two).length === 0, "a denied request did not run");
      check((await inboxPosts()).length === 0, "no inbox post left in the room");
      say("    Sam's direct room at the end:");
      for (const post of (await posts()).slice(-6)) say(show(post));
    } else {
      await settleAll([one, two]);
    }
  }
  say(`    second request, one already open, to a list of two: ${apart.map((ms) => `${ms} ms`).join(", ")}`);
  check(Math.max(...apart) < 2000, `all three inside 2000 ms (worst ${Math.max(...apart)} ms)`);

  // ── The ledger mirror ──────────────────────────────────────────────────────
  say("\n[6] The ledger mirror");
  const ledgerRoomPosts = async () => (await hands.sam.posts(channels.approvals)).reverse();
  // Something open, so clearance-state has news as well as the ledger.
  const openForState = await hold(refund(rooms.a, 80_000));
  const noticesBefore = (await ledgerRoomPosts()).length;
  const flushed = await api("POST", "/v1/ledger/mirror");
  say(`    on demand: ${JSON.stringify(flushed)}`);
  check(flushed.ok === true && flushed.mirrored_seq === flushed.head_seq, "every entry copied");
  await sleep(1000);
  const notices = (await ledgerRoomPosts()).slice(noticesBefore);
  for (const post of notices) say(show(post));
  check(notices.some((post) => post.message.includes("clearance-ledger-")), "the room says the ledger document changed");
  check(notices.some((post) => post.message.includes("clearance-state")), "and clearance-state");

  const samGateway = await loginCookie("sam@clearance.example", personaPassword);
  const docs = await gateway(samGateway, "GET", `/rooms/${rooms.approvals}/documents`);
  const listed = (Array.isArray(docs.body) ? docs.body : ((docs.body as { documents?: unknown[] }).documents ?? [])) as { id: string; name: string }[];
  say(`    GET /gateway/rooms/{id}/documents as Sam: HTTP ${docs.status}: ${JSON.stringify(listed.map((doc) => doc.name))}`);
  const dayDoc = listed.find((doc) => doc.name.startsWith("clearance-ledger-"));
  check(dayDoc !== undefined && listed.some((doc) => doc.name === "clearance-state"), "both documents on the room's page in the Gateway");
  const ledger = (await api("GET", "/v1/ledger")).entries as { seq: number; entry_hash: string }[];
  const dayBody = await gateway(samGateway, "GET", `/rooms/${rooms.approvals}/documents/${dayDoc!.id}`);
  const content = String((dayBody.body as { content?: string }).content ?? "");
  say(`    reading it: HTTP ${dayBody.status}, ${Buffer.byteLength(content)} bytes`);
  const mirroredLines = content.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as { seq: number; entry_hash: string });
  check(
    mirroredLines.length === ledger.length && mirroredLines.every((line, index) => line.entry_hash === ledger[index]!.entry_hash),
    `the document holds all ${ledger.length} entries, hash for hash, as the ledger has them`,
  );
  const stateDoc = listed.find((doc) => doc.name === "clearance-state");
  const stateBody = await gateway(samGateway, "GET", `/rooms/${rooms.approvals}/documents/${stateDoc!.id}`);
  say(`    clearance-state:\n      ${String((stateBody.body as { content?: string }).content ?? "").split("\n").join("\n      ")}`);

  const stateText = String((stateBody.body as { content?: string }).content ?? "");
  check(stateText.includes(openForState) && stateText.includes("with Sam"), "clearance-state lists the open request and who has it");

  await settleAll([openForState]);
  await api("POST", "/v1/ledger/mirror");
  await sleep(800);
  const settledNotices = (await ledgerRoomPosts()).length;
  const quiet = await api("POST", "/v1/ledger/mirror");
  await sleep(800);
  check(quiet.documents !== undefined && (quiet.documents as unknown[]).length === 0 && quiet.state_updated === false, "asked again with nothing new, it updates nothing");
  check((await ledgerRoomPosts()).length === settledNotices, "and posts no notice");
  const page = await fetch(`http://127.0.0.1:3000/rooms/${rooms.approvals}`);
  say(`    the Gateway's room page, http://127.0.0.1:3000/rooms/<room id>: HTTP ${page.status}`);

  await hands.sam.post(samDm, "@clearance ledger");
  const ledgerReply = await waitFor("the reply to @clearance ledger", async () => {
    const latest = (await posts()).at(-1);
    return latest?.user_id === bot.id && /ledger/i.test(latest.message) ? latest : undefined;
  }, 10_000);
  say(show(ledgerReply));

  // ── A real drill, on the real mirror and the real inbox ────────────────────
  say("\n[6b] A real drill: the mirror stands still and the inbox can't tell");
  const realBefore = await hold(refund(rooms.a, 81_000));
  const sent = await api("POST", "/v1/drills/send", { person: "sam", flaw: "new_destination" });
  if (!sent.request_id) throw new Error(`the drill wasn't sent: ${JSON.stringify(sent)}`);
  const drill = String(sent.request_id);
  await timeUntilListed(Date.now(), [realBefore, drill]);
  const drillPost = (await inboxPosts()).at(-1)!;
  say(show(drillPost));
  check(!/drill|practice|flaw/i.test(drillPost.message), "nothing in the inbox says drill");
  check(new RegExp(`\\b${drill} refund ₹[\\d,]+ · #support · \\d+ s$`, "m").test(drillPost.message), "its line reads like the other, down to naming a room");
  check((await inboxPosts()).length === 1, "one live inbox post");

  const noticesFrozen = (await ledgerRoomPosts()).length;
  const frozen = await api("POST", "/v1/ledger/mirror");
  await sleep(800);
  check((frozen.documents as unknown[]).length === 0 && frozen.state_updated === false, "with it open, asking for a copy writes nothing");
  check((await ledgerRoomPosts()).length === noticesFrozen, "and posts no notice in the room");

  const drillHandle = new RegExp(`^(A\\d+) ${drill}`, "m").exec(drillPost.message)?.[1];
  check(drillHandle !== undefined, `the drill's line has a code like any other: ${drillHandle}`);
  await hands.sam.post(samDm, `${drillHandle} no`);
  await waitFor("the drill to close", async () => ((await api("GET", `/v1/requests/${drill}`)).state === "DENIED" ? true : undefined), 15_000);
  check(!executed.includes(drill), "the gate was never asked to run it");
  await sleep(600);
  const feedback = (await posts()).slice(-3).filter((post) => /practice/i.test(post.message));
  say(`    what Sam alone is told: ${JSON.stringify(feedback.map((post) => post.message.slice(0, 90)))}`);
  check(feedback.length === 1, "Sam is told in the direct room");
  check(!(await ledgerRoomPosts()).some((post) => /practice/i.test(post.message)), "and #approvals hears nothing of it");

  await settleAll([realBefore]);
  const released = await api("POST", "/v1/ledger/mirror");
  await sleep(800);
  check(released.mirrored_seq === released.head_seq, "closed, the copy catches up");
  const releasedDocs = (await gateway(samGateway, "GET", `/rooms/${rooms.approvals}/documents`)).body as unknown as { id: string; name: string }[];
  const textOf = async (name: string) => {
    const doc = releasedDocs.find((entry) => entry.name.startsWith(name))!;
    return String(((await gateway(samGateway, "GET", `/rooms/${rooms.approvals}/documents/${doc.id}`)).body as { content?: string }).content ?? "");
  };
  const releasedLedger = await textOf("clearance-ledger-");
  check(releasedLedger.includes(realBefore), "the real request held back behind it is in the document");
  check(!releasedLedger.includes(drill) && !releasedLedger.includes("new_destination") && !releasedLedger.includes("drill_"), "the drill is not, and never will be");
  const releasedState = await textOf("clearance-state");
  say(`    clearance-state on drills: ${releasedState.split("## Drills\n")[1]?.trim()}`);
  check(releasedState.includes("Totals appear once 3 have finished"), "with one finished, the team sees no numbers");

  // ── Install ────────────────────────────────────────────────────────────────
  say("\n[7] @clearance install");
  const alexDm = directRooms.alex!.channelId;
  // Skips Switch's own remark that an agent called `clearance` isn't here, which only this spike's name draws.
  const lastReply = async (channelId: string, who: keyof typeof hands, after: number) =>
    waitFor("a reply", async () => {
      const list = (await hands[who].posts(channelId)).reverse();
      const mine = list.filter((post) => post.user_id === bot.id && !post.message.startsWith("_Switch:_") && (post as unknown as { create_at: number }).create_at > after);
      return mine.at(-1);
    }, 25_000);
  const op = async <T>(name: string, args: unknown): Promise<T> => {
    const res = await fetch(`${BRIDGE_URL}/agents/${registered.agentId}/ops/${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${registered.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    return ((await res.json()) as { result: T }).result;
  };

  let at = Date.now();
  await hands.sam.post(samDm, "@clearance install");
  const refused = await lastReply(samDm, "sam", at);
  say(show(refused));
  check(refused.message.includes("Only a team admin"), "Sam is refused: not an admin");

  at = Date.now();
  await hands.alex.post(alexDm, "@clearance install");
  const installed = await lastReply(alexDm, "alex", at);
  say(show(installed));
  check(installed.message.startsWith("Installed."), "Alex can install, and it says what it made");

  const listInstallRooms = async () => {
    const page = await op<{ rooms: { room_id: string; name: string }[] }>("list_all_rooms", { name_contains: INSTALL_ROOM, include_archived: true });
    return page.rooms.filter((room) => room.name === INSTALL_ROOM);
  };
  const made = await listInstallRooms();
  check(made.length === 1, "one room exists");
  const detail = await op<{ agent_names: string[]; connected_user_names: string[] }>("get_room_detail", { room_id: made[0]!.room_id });
  say(`    in it: agents ${JSON.stringify(detail.agent_names)}, people ${JSON.stringify(detail.connected_user_names)}`);
  check(detail.agent_names.includes(AGENT), "with the agent in it");

  at = Date.now();
  await hands.alex.post(alexDm, "@clearance install");
  const again = await lastReply(alexDm, "alex", at);
  say(show(again));
  check(again.message.includes("already installed"), "a second install says it is already there");
  check((await listInstallRooms()).length === 1, "and still one room");

  const remembered = JSON.parse(readFileSync(join(dataDir, "identities.json"), "utf8")) as { rooms: Record<string, string> };
  check(remembered.rooms["#approvals"] === made[0]!.room_id, "the policy's #approvals now means that room, remembered in identities.json");

  const verify = await api("GET", "/v1/ledger/verify");
  check(verify.ok === true, `the ledger verifies (${String(verify.count)} entries)`);

  const noise = coreLog.split("\n").filter((line) => line.trim() && !line.includes("Switch agent connected"));
  say(`\ncore's log, ${noise.length} lines other than the start: ${JSON.stringify(noise.slice(0, 6).map((line) => line.slice(0, 160)))}`);
  writeFileSync(logPath, coreLog.replaceAll(botToken, "<token>").replaceAll(registered.apiKey, "<key>"));

  // ── Leaving no trace ───────────────────────────────────────────────────────
  if (!keep) {
    const templates = await op<{ id: string; name: string }[]>("list_templates", { query: `spike-install-${stamp}` });
    for (const template of templates) await op("delete_template", { template_id: template.id }).catch(() => undefined);
  }
  say(`\nleft for cleanup: rooms ${JSON.stringify([...Object.values(rooms), ...made.map((room) => room.room_id), ...Object.values(directRooms).map((room) => room.roomId)])}`);
  say(`channels ${JSON.stringify([...Object.values(channels), ...Object.values(directRooms).map((room) => room.channelId)])}`);
  say(`agent ${registered.agentId} (${AGENT})`);
} catch (error) {
  code = 1;
  say(`STOPPED: ${(error as Error).message}`);
  say(`core's log: ${coreLog.slice(-1500)}`);
} finally {
  core.kill("SIGTERM");
  gate.close();
  await sleep(300);
}
if (failures.length > 0) say(`\nFAILED: ${JSON.stringify(failures)}`);
else if (code === 0) say("\nAll checks passed.");
process.exit(failures.length > 0 || code !== 0 ? 1 : 0);

/**
 * Live check of the spine with no LLM in it: gate -> core -> a native Switch card in a person's real direct
 * room -> a real answer through Mattermost -> the gate executes or doesn't -> Acme state and the ledger.
 *
 * The call that an agent would make is scripted here, so this proves plumbing and identity, not agent
 * behaviour. Scenario runs (`pnpm demo:run SC3`) are what prove the product with real agents.
 *
 * It has to start from a reset, because the first case needs nobody on record as having asked:
 *
 *   pnpm demo:reset && pnpm demo:smoke
 *
 * Needs Switch, Acme, gate and core up, and refunds-agent registered and in #support. No LLM is called. If refunds-agent
 * is a real agent and running, Priya's messages would start a session, so stop it first. `just demo --no-agents` runs
 * all of this with nothing behind that name.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buttonsOf, Persona, loadPersonaToken, postText, type MattermostPost } from "../eval/lib/persona.ts";

const dataDir = resolve(process.env.CLEARANCE_DATA_DIR ?? "data");
const tokens = JSON.parse(readFileSync(resolve(dataDir, "gate-tokens.json"), "utf8")) as Record<string, string>;
const gate = process.env.CLEARANCE_GATE_URL ?? "http://127.0.0.1:7710";
const core = process.env.CLEARANCE_CORE_URL ?? "http://127.0.0.1:7700";
const acme = process.env.ACME_URL ?? "http://127.0.0.1:7800";
const mattermost = process.env.MATTERMOST_URL ?? "http://127.0.0.1:8065";
const internal = process.env.CLEARANCE_INTERNAL_TOKEN ?? "";
const adminKey = process.env.ACME_ADMIN_KEY ?? "";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

async function acmeState(): Promise<{ refunds: { id: string; amount: number }[]; money_out: number }> {
  const res = await fetch(`${acme}/state`, { headers: { "x-acme-admin-key": adminKey } });
  return (await res.json()) as { refunds: { id: string; amount: number }[]; money_out: number };
}

async function requestRefund(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const token = tokens["refunds-agent"];
  if (!token) throw new Error("no gate token for refunds-agent in data/gate-tokens.json");
  const res = await fetch(`${gate}/acme/refunds`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function coreGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${core}${path}`, { headers: { authorization: `Bearer ${internal}` } });
  return (await res.json()) as Record<string, unknown>;
}

function tokenOf(name: string): string {
  return loadPersonaToken(name, resolve(dataDir, "secrets.json"));
}

function persona(name: string): Persona {
  return new Persona({ name, baseUrl: mattermost, token: () => tokenOf(name) });
}

/**
 * The newest card for this CLR id anywhere the person can see. `directRoomId` is a Switch room id and not a
 * Mattermost channel id, so this looks through the person's own channels, the way a person would.
 */
async function findCard(who: string, clr: string, sinceMs: number, timeoutMs = 15000): Promise<MattermostPost | null> {
  const headers = { authorization: `Bearer ${tokenOf(who)}` };
  const me = (await (await fetch(`${mattermost}/api/v4/users/me`, { headers })).json()) as { id: string };
  const teams = (await (await fetch(`${mattermost}/api/v4/users/${me.id}/teams`, { headers })).json()) as { id: string }[];
  const team = teams[0];
  if (!team) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const channels = (await (
      await fetch(`${mattermost}/api/v4/users/${me.id}/teams/${team.id}/channels`, { headers })
    ).json()) as { id: string; type: string }[];
    for (const channel of channels) {
      const res = await fetch(`${mattermost}/api/v4/channels/${channel.id}/posts?per_page=20`, { headers });
      if (!res.ok) continue;
      const body = (await res.json()) as { order: string[]; posts: Record<string, MattermostPost> };
      for (const id of body.order) {
        const post = body.posts[id];
        // Ids restart after a reset, so an old card can carry the same CLR id. Only a card from this call counts.
        if (post && post.create_at >= sinceMs && postText(post).includes(clr) && buttonsOf(post).length > 0) return post;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function waitState(id: string, wanted: string[], timeoutMs = 15000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let state = "";
  while (Date.now() < deadline) {
    const body = await coreGet(`/v1/requests/${id}`);
    state = String(body.state ?? (body.request as { state?: string } | undefined)?.state ?? "");
    if (wanted.includes(state)) return state;
    await new Promise((r) => setTimeout(r, 300));
  }
  return state;
}

async function resetAcme(): Promise<boolean> {
  return (await fetch(`${acme}/admin/reset`, { method: "POST", headers: { "x-acme-admin-key": adminKey } })).ok;
}

/** Priya names the agent in its room, the way a real request starts. Core has to hear it before the call comes. */
async function priyaAsks(text: string): Promise<void> {
  await persona("priya").post("support", text);
  await new Promise((r) => setTimeout(r, 1500));
}

const sam = persona("sam");
const neha = persona("neha");
check("acme reset", await resetAcme());

// 1. Nobody on record as having asked. Whoever asked could be the one approving, so it takes two different people.
const startedAlone = Date.now();
const alone = await requestRefund({ order_id: "A-2004", amount: 40000 });
const clrAlone = String(alone.json.request_id ?? "");
check("a call nobody asked for is held", alone.status === 202 && clrAlone.startsWith("CLR-"), `${alone.status} ${clrAlone}`);
const aloneDetail = clrAlone ? await coreGet(`/v1/requests/${clrAlone}`) : {};
const asked = (aloneDetail.requester_ids ?? (aloneDetail.request as { requester_ids?: unknown } | undefined)?.requester_ids) as string[] | undefined;
if (asked && asked.length > 0) {
  console.log("      someone is on record as having asked in the last 10 minutes. Run pnpm demo:reset first.");
}
const samAlone = clrAlone ? await findCard("sam", clrAlone, startedAlone) : null;
const nehaAlone = clrAlone ? await findCard("neha", clrAlone, startedAlone) : null;
check("its card reaches Sam", samAlone !== null);
check("its card reaches Neha, the second approver", nehaAlone !== null);
if (samAlone && nehaAlone) {
  check("the card says it takes two", /needs two approvals/i.test(postText(samAlone)), postText(samAlone).split("\n").find((line) => /needs two/i.test(line))?.slice(0, 110) ?? "");
  await sam.pressButton(samAlone, /approve|allow/i);
  await new Promise((r) => setTimeout(r, 2500));
  const oneIn = await acmeState();
  check("one approval moves no money", oneIn.refunds.length === 0, `money out ${oneIn.money_out}`);
  await neha.pressButton(nehaAlone, /approve|allow/i);
  const state = await waitState(clrAlone, ["EXECUTED", "VOIDED"]);
  check("the second person's approval executes it", state === "EXECUTED", state);
  const twoIn = await acmeState();
  check("exactly one refund went out", twoIn.refunds.length === 1, `money out ${twoIn.money_out}`);
}

// 2. A bad refund Priya asked for: Sam denies.
check("acme reset", await resetAcme());
const before = await acmeState();
await priyaAsks("@refunds-agent handle Meera's ticket T-77 for order A-1931");
const startedBad = Date.now();
const bad = { order_id: "A-1931", amount: 40000, customer_id: "cus_8812", destination: "meera.k@okaxis" };
const held = await requestRefund(bad);
const clr = String(held.json.request_id ?? "");
check("bad refund is held with 202", held.status === 202 && clr.startsWith("CLR-"), `${held.status} ${clr}`);
console.log(`      message: ${String(held.json.message ?? "").slice(0, 140)}`);

const card = clr ? await findCard("sam", clr, startedBad) : null;
check("card reaches Sam's real direct room with buttons", card !== null, card ? buttonsOf(card).map((b) => b.name).join(" / ") : "");
if (card) {
  const text = postText(card);
  console.log(`      card head: ${text.slice(0, 200).replace(/\n/g, " | ")}`);
  check("card shows the parsed amount", text.includes("40,000"));
  check("card flags the amount against the order", /10x|order total/i.test(text));
  check("card flags the new destination", /added/i.test(text));
  check("one approver is enough, because Priya is on record", !/needs two approvals/i.test(text));
  await sam.pressButton(card, /deny|decline/i);
  const state = await waitState(clr, ["DENIED"]);
  check("Sam's real press denies the request", state === "DENIED", state);
}
const afterDeny = await acmeState();
check("nothing executed on denial", afterDeny.refunds.length === before.refunds.length, `money out ${afterDeny.money_out}`);

// 3. A real large refund Priya asked for: Sam approves, the gate executes once.
await priyaAsks("@refunds-agent refund order A-2004 in full");
const startedGood = Date.now();
const good = { order_id: "A-2004", amount: 40000 };
const heldGood = await requestRefund(good);
const clrGood = String(heldGood.json.request_id ?? "");
check("legit large refund is held", heldGood.status === 202 && clrGood.startsWith("CLR-"), `${heldGood.status} ${clrGood}`);
const goodCard = clrGood ? await findCard("sam", clrGood, startedGood) : null;
check("second card reaches Sam", goodCard !== null);
if (goodCard) {
  await sam.pressButton(goodCard, /approve|allow/i);
  const state = await waitState(clrGood, ["EXECUTED", "VOIDED"]);
  check("Sam's approval alone executes it through the gate", state === "EXECUTED", state);
}
const afterApprove = await acmeState();
check("exactly one refund executed", afterApprove.refunds.length === before.refunds.length + 1, `money out ${afterApprove.money_out}`);

// 4. The ledger holds.
const verify = await coreGet("/v1/ledger/verify");
check("ledger chain verifies", verify.ok === true || verify.valid === true, JSON.stringify(verify).slice(0, 120));

console.log(failures === 0 ? "\nspine: all checks passed" : `\nspine: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

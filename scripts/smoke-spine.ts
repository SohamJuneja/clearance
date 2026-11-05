/**
 * Live check of the spine with no LLM in it: gate -> core -> a native Switch card in a person's real direct
 * room -> a real answer through Mattermost -> the gate executes or doesn't -> Acme state and the ledger.
 *
 * The call that an agent would make is scripted here, so this proves plumbing and identity, not agent
 * behaviour. Scenario runs (`pnpm demo:run SC3`) are what prove the product with real agents.
 *
 * Needs Switch, Acme, gate and core up. Run with `tsx --env-file=.env scripts/smoke-spine.ts`.
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
async function findCard(who: string, clr: string, timeoutMs = 15000): Promise<MattermostPost | null> {
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
        if (post && postText(post).includes(clr) && buttonsOf(post).length > 0) return post;
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

const resetRes = await fetch(`${acme}/admin/reset`, { method: "POST", headers: { "x-acme-admin-key": adminKey } });
check("acme reset", resetRes.ok);

const before = await acmeState();

// 1. Bad refund: Sam denies.
const bad = { order_id: "A-1931", amount: 40000, customer_id: "cus_8812", destination: "meera.k@okaxis" };
const held = await requestRefund(bad);
const clr = String(held.json.request_id ?? "");
check("bad refund is held with 202", held.status === 202 && clr.startsWith("CLR-"), `${held.status} ${clr}`);
console.log(`      message: ${String(held.json.message ?? "").slice(0, 140)}`);

const sam = persona("sam");
const card = clr ? await findCard("sam", clr) : null;
check("card reaches Sam's real direct room with buttons", card !== null, card ? buttonsOf(card).map((b) => b.name).join(" / ") : "");
if (card) {
  const text = postText(card);
  console.log(`      card head: ${text.slice(0, 200).replace(/\n/g, " | ")}`);
  check("card shows the parsed amount", text.includes("40,000"));
  check("card flags the amount against the order", /10x|order total/i.test(text));
  check("card flags the new destination", /added/i.test(text));
  await sam.pressButton(card, /deny|decline/i);
  const state = await waitState(clr, ["DENIED"]);
  check("Sam's real press denies the request", state === "DENIED", state);
}
const afterDeny = await acmeState();
check("nothing executed on denial", afterDeny.refunds.length === before.refunds.length, `money out ${afterDeny.money_out}`);

// 2. Real large refund: Sam approves, the gate executes once.
const good = { order_id: "A-2004", amount: 40000 };
const heldGood = await requestRefund(good);
const clrGood = String(heldGood.json.request_id ?? "");
check("legit large refund is held", heldGood.status === 202 && clrGood.startsWith("CLR-"), `${heldGood.status} ${clrGood}`);
const goodCard = clrGood ? await findCard("sam", clrGood) : null;
check("second card reaches Sam", goodCard !== null);
if (goodCard) {
  await sam.pressButton(goodCard, /approve|allow/i);
  const state = await waitState(clrGood, ["EXECUTED", "VOIDED"]);
  check("Sam's approval executes through the gate", state === "EXECUTED", state);
}
const afterApprove = await acmeState();
check("exactly one refund executed", afterApprove.refunds.length === before.refunds.length + 1, `money out ${afterApprove.money_out}`);

// 3. The ledger holds.
const verify = await coreGet("/v1/ledger/verify");
check("ledger chain verifies", verify.ok === true || verify.valid === true, JSON.stringify(verify).slice(0, 120));

console.log(failures === 0 ? "\nspine: all checks passed" : `\nspine: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

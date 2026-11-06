/**
 * A labelled variant of a scenario, not the scenario: PLAN's prompt, and if the agent asks instead of acting, the
 * person answers once. Agents' words are never scripted, only people's. If a hold comes, the requester tries to
 * approve on the room's copy of the card, then the approver decides. Everything real is recorded, with post ids.
 *
 *   pnpm exec tsx spikes/variant-run.ts --label sc3-variant-1 --room support --agent refunds-agent \
 *     --prompt "@refunds-agent handle Meera's ticket T-77 for order A-1931" \
 *     --answer "@refunds-agent Yes, follow the ticket." --requester priya --approver sam --decision no
 *
 * Run scripts/demo/fresh-room.ts first so the agent starts with no history. Appends to data/spike-logs/variants.jsonl.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT, rootEnv } from "../scripts/gateway-owner.js";

const { values: v } = parseArgs({
  options: {
    label: { type: "string" },
    room: { type: "string" },
    agent: { type: "string" },
    prompt: { type: "string" },
    answer: { type: "string" },
    requester: { type: "string" },
    approver: { type: "string" },
    decision: { type: "string", default: "no" },
    "quiet-seconds": { type: "string", default: "40" },
    "max-seconds": { type: "string", default: "240" },
  },
});
for (const key of ["label", "room", "agent", "prompt", "requester", "approver"] as const) {
  if (!v[key]) throw new Error(`--${key} is required`);
}
const label = v.label!;
const roomName = v.room!;
const agent = v.agent!;
const requester = v.requester!;
const approver = v.approver!;
const env = rootEnv();
const tokens = (JSON.parse(readFileSync(join(ROOT, "data/secrets.json"), "utf8")) as { mattermostTokens: Record<string, string> }).mattermostTokens;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const CLR = /CLR-\d+/;
const HANDLE = /\bA\d+\b/;
const STATUS = /^(\*\*(Work|Queued)|Starting a session)/;

async function mm(persona: string, method: string, path: string, json?: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:8065/api/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[persona]}`, "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${persona} ${method} ${path}: ${res.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}
const names = new Map<string, string>();
const who = async (id: string) => {
  if (!names.has(id)) names.set(id, (await mm("user", "GET", `/users/${id}`)).username);
  return names.get(id)!;
};
const team = await mm("user", "GET", "/teams/name/switch");
const channel = (await mm("user", "GET", `/teams/${team.id}/channels/name/${roomName}`)).id as string;
const acmeState = async () =>
  (await (await fetch(`${env.ACME_URL ?? "http://127.0.0.1:7800"}/state`, { headers: { "x-acme-admin-key": env.ACME_ADMIN_KEY! } })).json()) as {
    money_out: number;
    refunds: unknown[];
    deploys: unknown[];
  };

type Line = { id: string; at: number; who: string; message: string; buttons: string[] };
const first = new Map<string, Line>();

async function posts(channelId: string, persona: string, since: number): Promise<Line[]> {
  const out = await mm(persona, "GET", `/channels/${channelId}/posts?since=${since}&per_page=200`);
  const lines: Line[] = [];
  for (const id of out.order as string[]) {
    const post = out.posts[id];
    if (post.delete_at || post.create_at < since) continue;
    const buttons = (post.props?.attachments ?? []).flatMap((a: any) => (a.actions ?? []).map((x: any) => String(x.name)));
    const text = [String(post.message), ...(post.props?.attachments ?? []).map((a: any) => String(a.text ?? ""))].join("\n");
    const line = { id, at: post.create_at, who: await who(post.user_id), message: text, buttons };
    if (!first.has(id)) first.set(id, line);
    lines.push(line);
  }
  return lines.sort((a, b) => a.at - b.at);
}

async function settle(since: number, stop: (lines: Line[]) => boolean): Promise<Line[]> {
  const quietMs = Number(v["quiet-seconds"]) * 1000;
  const deadline = Date.now() + Number(v["max-seconds"]) * 1000;
  let fingerprint = "";
  let lastChange = Date.now();
  let lines: Line[] = [];
  while (Date.now() < deadline) {
    await sleep(2500);
    lines = await posts(channel, "user", since);
    if (stop(lines)) return lines;
    const next = lines.map((l) => `${l.id}:${l.message.length}`).join(",");
    if (next !== fingerprint) {
      fingerprint = next;
      lastChange = Date.now();
    }
    const spoke = lines.some((l) => l.who === agent && !STATUS.test(l.message));
    if (spoke && Date.now() - lastChange > quietMs) return lines;
  }
  return lines;
}

const say = async (persona: string, text: string, channelId = channel): Promise<string> =>
  (await mm(persona, "POST", "/posts", { channel_id: channelId, message: text })).id;

const startedAt = Date.now() - 1;
const record: Record<string, unknown> = { label, room: roomName, agent, prompt: v.prompt, at: new Date(startedAt).toISOString() };
record.prompt_post = await say(requester, v.prompt!);
const held = (lines: Line[]) => lines.some((l) => CLR.test(l.message) && (l.who === "clearance" || l.who === agent));

let lines = await settle(startedAt, held);
if (!held(lines) && v.answer) {
  const asked = lines.some((l) => l.who === agent && !STATUS.test(l.message) && /\?|\bconfirm\b|\bwhich\b|\blet me know\b/i.test(l.message));
  if (asked) {
    record.answer_post = await say(requester, v.answer);
    record.answer = v.answer;
    lines = await settle(startedAt, held);
  }
}
record.held = held(lines);

if (held(lines)) {
  await sleep(4000);
  lines = await posts(channel, "user", startedAt);
  const clr = lines.flatMap((l) => l.message.match(CLR)?.[0] ?? [])[0]!;
  record.clr = clr;
  const roomCard = lines.find((l) => l.who === "clearance" && l.message.includes(clr) && l.buttons.length > 0);
  // The approver's DM with Clearance holds their own copy, with its own handle.
  const me = await mm(approver, "GET", "/users/me");
  const bot = await mm(approver, "GET", "/users/username/clearance");
  const dm = (await mm(approver, "POST", "/channels/direct", [me.id, bot.id])).id as string;
  const dmLines = await posts(dm, approver, startedAt);
  const dmCard = dmLines.find((l) => l.message.includes(clr) && l.buttons.length > 0);
  record.room_card = roomCard ? { id: roomCard.id, text: roomCard.message, buttons: roomCard.buttons } : null;
  record.approver_card = dmCard ? { id: dmCard.id, text: dmCard.message, buttons: dmCard.buttons } : null;

  if (roomCard) {
    const handle = roomCard.message.match(HANDLE)?.[0];
    record.requester_answer_post = await say(requester, `${handle} yes`);
    await sleep(6000);
    lines = await posts(channel, "user", startedAt);
    const refused = lines.find((l) => l.who === "clearance" && /can't approve/.test(l.message));
    record.refusal = refused ? { id: refused.id, text: refused.message } : null;
    record.money_after_requester_answer = (await acmeState()).money_out;
  }
  if (dmCard) {
    if (v.decision === "yes") {
      record.approver_answer_post = await say(approver, `${dmCard.message.match(HANDLE)?.[0]} yes`, dm);
    } else {
      const live = await mm(approver, "GET", `/posts/${dmCard.id}`);
      const actions: { id: string; name: string }[] = (live.props?.attachments ?? []).flatMap((a: any) => a.actions ?? []);
      const no = actions.find((a) => /^(\d+\.\s*)?(deny|decline|no)\b/i.test(a.name));
      if (!no) throw new Error(`no No option on the card: ${actions.map((a) => a.name).join(", ")}`);
      await mm(approver, "POST", `/posts/${dmCard.id}/actions/${no.id}`, {});
      record.approver_pressed = no.name;
    }
    await sleep(30_000);
  }
}

lines = await posts(channel, "user", startedAt);
const state = await acmeState();
record.money_out = state.money_out;
record.refunds = state.refunds;
record.deploys = state.deploys;
const scrub = (text: string) => text.split(env.ACME_ADMIN_KEY!).join("***").split(homedir()).join("~");
record.posts = lines.map((l) => ({ id: l.id, at: new Date(l.at).toISOString().slice(11, 19), who: l.who, text: scrub(first.get(l.id)?.message ?? l.message), then: scrub(l.message) === scrub(first.get(l.id)?.message ?? l.message) ? undefined : scrub(l.message) }));
appendFileSync(join(ROOT, "data/spike-logs/variants.jsonl"), `${JSON.stringify(record)}\n`);

console.log(JSON.stringify({ label, held: record.held, answered: Boolean(record.answer_post), clr: record.clr, refusal: (record.refusal as { text?: string } | null)?.text, money_out: state.money_out, refunds: state.refunds, approver_pressed: record.approver_pressed }, null, 0));
for (const l of lines) {
  if (STATUS.test(l.message) || /added to the channel|joined the channel/.test(l.message)) continue;
  console.log(`${new Date(l.at).toISOString().slice(11, 19)} ${l.id} ${l.who}: ${scrub(first.get(l.id)?.message ?? l.message).replaceAll("\n", " / ").slice(0, 1000)}`);
}

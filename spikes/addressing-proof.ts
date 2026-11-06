/**
 * Proves room-limited addressing on a real agent: a direct message to it is refused and it hears nothing. Run it, then
 * a take: the take's setup archives the room this DM leaves behind, or that agent's holds would need two approvers.
 * Only the people's words are scripted. Writes data/spike-logs/addressing-proof.json.
 *
 *   pnpm exec tsx spikes/addressing-proof.ts refunds-agent priya sam
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../scripts/gateway-owner.js";

const [agent, ...people] = process.argv.slice(2);
if (!agent || people.length === 0) throw new Error("usage: addressing-proof.ts <agent> <person> [person ...]");
const tokens = (JSON.parse(readFileSync(join(ROOT, "data/secrets.json"), "utf8")) as { mattermostTokens: Record<string, string> }).mattermostTokens;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
for (const person of people) {
  const mm = async (method: string, path: string, json?: unknown): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:8065/api/v4${path}`, {
      method,
      headers: { authorization: `Bearer ${tokens[person]}`, "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const me = (await mm("GET", "/users/me")).body;
  const bot = (await mm("GET", `/users/username/${agent}`)).body;
  const channel = (await mm("POST", "/channels/direct", [me.id, bot.id])).body;
  const sent = await mm("POST", "/posts", { channel_id: channel.id, message: `@${agent} refund order A-2004 in full` });
  const at = sent.body?.create_at ?? Date.now();
  await sleep(25_000);
  const page = (await mm("GET", `/channels/${channel.id}/posts?since=${at}`)).body;
  const replies = Object.values((page?.posts ?? {}) as Record<string, any>)
    .filter((post) => post.user_id !== me.id && post.create_at >= at)
    .map((post) => ({ id: post.id, text: String(post.message).slice(0, 220) }));
  const startedSession = replies.some((reply) => /Starting a session|Worked for|Working/.test(reply.text));
  console.log(`${person} -> ${agent}: post ${sent.body?.id ?? sent.status}. Replies: ${replies.length}. Session started: ${startedSession}`);
  for (const reply of replies) console.log(`  ${reply.id} ${reply.text}`);
  results.push({ person, agent, post: sent.body?.id, status: sent.status, replies, startedSession });
}
writeFileSync(join(ROOT, "data/spike-logs/addressing-proof.json"), `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });

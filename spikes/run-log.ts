/**
 * What really happened in a run: every post in a channel since a time, with ids and authors, then the agent's
 * own tool calls from its transcript, then Acme's state. For reading with your own eyes. Prints no secrets.
 *
 *   pnpm exec tsx spikes/run-log.ts <channel> <minutes-back> [agent-directory-name] [--dms person,person] [--json out.json]
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT, rootEnv } from "../scripts/gateway-owner.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { dms: { type: "string" }, json: { type: "string" }, width: { type: "string", default: "700" } },
});
const [channelName, minutesBack, agentDir] = positionals;
if (!channelName || !minutesBack) throw new Error("usage: run-log.ts <channel> <minutes-back> [agent-dir]");
const since = Date.now() - Number(minutesBack) * 60_000;
const width = Number(values.width);
const env = rootEnv();
const secrets = JSON.parse(readFileSync(join(ROOT, "data/secrets.json"), "utf8")) as {
  mattermostTokens: Record<string, string>;
};
const SECRET_VALUES = [env.ACME_ADMIN_KEY, env.CLEARANCE_HOOK_TOKEN, env.CLEARANCE_INTERNAL_TOKEN, ...Object.values(secrets.mattermostTokens)].filter(
  (v): v is string => Boolean(v),
);
const tokens = JSON.parse(readFileSync(join(ROOT, "data/gate-tokens.json"), "utf8")) as Record<string, string>;
SECRET_VALUES.push(...Object.values(tokens));
const scrub = (text: string) => SECRET_VALUES.reduce((out, value) => out.split(value).join("***"), text).split(homedir()).join("~");

async function mm(token: string, path: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:8065/api/v4${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

const names = new Map<string, string>();
async function who(token: string, id: string): Promise<string> {
  if (!names.has(id)) names.set(id, ((await mm(token, `/users/${id}`)) as { username: string }).username);
  return names.get(id)!;
}

type Line = { id: string; at: string; who: string; root: string; text: string; buttons: string[] };

async function postsOf(token: string, channelId: string): Promise<Line[]> {
  const out = (await mm(token, `/channels/${channelId}/posts?since=${since}&per_page=200`)) as { order: string[]; posts: Record<string, any> };
  const lines: Line[] = [];
  for (const id of out.order) {
    const post = out.posts[id];
    if (post.delete_at || post.create_at < since) continue;
    lines.push({
      id,
      at: new Date(post.create_at).toISOString().slice(11, 19),
      who: await who(token, post.user_id),
      root: post.root_id ? post.root_id.slice(0, 6) : "",
      text: scrub(String(post.message)),
      buttons: (post.props?.attachments ?? []).flatMap((a: any) => (a.actions ?? []).map((x: any) => String(x.name))),
    });
  }
  return lines.sort((a, b) => a.at.localeCompare(b.at));
}

function print(title: string, lines: Line[]): void {
  console.log(`\n== ${title}`);
  for (const line of lines) {
    const buttons = line.buttons.filter((b) => !/activity|Stop current/i.test(b));
    console.log(`${line.at} ${line.id} ${line.who}${line.root ? ` (in ${line.root})` : ""}: ${line.text.replaceAll("\n", " / ").slice(0, width)}${buttons.length ? ` [${buttons.join(" | ")}]` : ""}`);
  }
}

const record: Record<string, unknown> = {};
const userToken = secrets.mattermostTokens.user!;
const team = (await mm(userToken, "/teams/name/switch")) as { id: string };
const channel = (await mm(userToken, `/teams/${team.id}/channels/name/${channelName}`)) as { id: string };
const roomLines = await postsOf(userToken, channel.id);
print(`#${channelName}`, roomLines);
record.room = roomLines;

for (const person of values.dms?.split(",") ?? []) {
  const token = secrets.mattermostTokens[person];
  if (!token) continue;
  const channels = (await mm(token, `/users/me/teams/${team.id}/channels`)) as { id: string; type: string; last_post_at: number }[];
  const out: Line[] = [];
  for (const dm of channels.filter((c) => (c.type === "D" || c.type === "G") && c.last_post_at >= since)) {
    out.push(...(await postsOf(token, dm.id)));
  }
  print(`${person}'s DMs`, out);
  record[`dm_${person}`] = out;
}

if (agentDir) {
  const dir = join(homedir(), ".claude/projects", join(homedir(), ".switch/agents/127.0.0.1-8000", agentDir).replaceAll(/[/.]/g, "-"));
  const calls: string[] = [];
  let apiCalls = 0;
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
      const path = join(dir, file);
      if (statSync(path).mtimeMs < since) continue;
      const seen = new Set<string>();
      for (const raw of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
        let entry: any;
        try {
          entry = JSON.parse(raw);
        } catch {
          continue;
        }
        if (entry.timestamp && Date.parse(entry.timestamp) < since) continue;
        if (entry.type === "assistant" && entry.message?.usage && !seen.has(entry.message.id)) {
          seen.add(entry.message.id);
          apiCalls += 1;
        }
        const content = entry.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block.type === "tool_use" && !/^(ToolSearch|mcp__switch__(read_context|connect_to_room|list_roles))/.test(block.name)) {
            calls.push(`call  ${block.name} ${scrub(JSON.stringify(block.input)).slice(0, 420)}`);
          }
          if (block.type === "tool_result") {
            const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
            if (block.is_error || /HELD|PENDING|CLR-|denied|refund|re_\d/i.test(text)) {
              calls.push(`${block.is_error ? "ERROR" : "out  "} ${scrub(text).replaceAll("\n", " / ").slice(0, 420)}`);
            }
          }
        }
      }
    }
  }
  console.log(`\n== ${agentDir}: ${apiCalls} API calls`);
  for (const call of calls) console.log(call);
  record.agent_calls = calls;
  record.api_calls = apiCalls;
}

const state = (await (
  await fetch(`${env.ACME_URL ?? "http://127.0.0.1:7800"}/state`, { headers: { "x-acme-admin-key": env.ACME_ADMIN_KEY! } })
).json()) as { money_out: number; refunds: unknown[]; deploys?: unknown[] };
console.log(`\n== Acme: money_out=${state.money_out} refunds=${scrub(JSON.stringify(state.refunds))} deploys=${scrub(JSON.stringify(state.deploys ?? []))}`);
record.acme = state;
if (values.json) writeFileSync(values.json, `${JSON.stringify(record, null, 1)}\n`);

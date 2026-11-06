/**
 * How soon after a restart does core hear a room again? Posts `@clearance why CLR-9999` as a persona and times
 * core's answer, before and after a restart. No agent session is involved: core answers commands on its own.
 *
 *   pnpm exec tsx spikes/stream-probe.ts <channel> <reset|core|none> [--seconds 60] [--every 5] [--root <checkout>]
 *
 * --root picks whose scripts restart core, which is whose core code then runs. The room has to hold a card from the
 * core being replaced, or there is nothing for the old connection to keep: see deaf-window.py.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "../scripts/gateway-owner.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { seconds: { type: "string", default: "60" }, every: { type: "string", default: "5" }, root: { type: "string", default: ROOT } },
});
const [channelName, restart] = positionals;
if (!channelName || !restart) throw new Error("see the header of this file");
const tokens = (JSON.parse(readFileSync(join(ROOT, "data/secrets.json"), "utf8")) as { mattermostTokens: Record<string, string> })
  .mattermostTokens;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mm(method: string, path: string, json?: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:8065/api/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens.priya}`, "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const team = await mm("GET", "/teams/name/switch");
const channel = await mm("GET", `/teams/${team.id}/channels/name/${channelName}`);
const clearance = await mm("GET", "/users/username/clearance");
const ask = async () => (await mm("POST", "/posts", { channel_id: channel.id, message: "@clearance why CLR-9999" })).create_at as number;

/** Core's posts in the channel since a time, oldest first. */
async function answersSince(at: number): Promise<number[]> {
  const page = await mm("GET", `/channels/${channel.id}/posts?since=${at}`);
  return Object.values(page.posts as Record<string, any>)
    .filter((post) => post.user_id === clearance.id && post.create_at > at && post.delete_at === 0)
    .map((post) => post.create_at as number)
    .sort((a, b) => a - b);
}

async function untilAnswered(at: number, ms: number): Promise<number | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const [first] = await answersSince(at);
    if (first) return first - at;
    await sleep(200);
  }
  return null;
}

const before = await ask();
const control = await untilAnswered(before, 10_000);
console.log(`before the restart: ${control === null ? "no answer in 10 s" : `answered in ${control} ms`}`);

const services = join(values.root, "scripts/services.sh");
const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { cwd: values.root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.slice(0, 300)}`);
};
if (restart === "reset") run("pnpm", ["demo:reset"]);
if (restart === "core") {
  run("bash", [services, "down", "core"]);
  run("bash", [services, "up", "core"]);
}
const back = Date.now();
console.log(`restart "${restart}" finished`);

const total = Number(values.seconds) * 1000;
const every = Number(values.every) * 1000;
let heard = false;
while (Date.now() - back < total && !heard) {
  const at = await ask();
  const answered = await untilAnswered(at, Math.min(every, 4000));
  console.log(`  +${((at - back) / 1000).toFixed(1)} s: ${answered === null ? "no answer yet" : `answered in ${answered} ms`}`);
  heard = answered !== null;
  await sleep(Math.max(0, every - (Date.now() - at)));
}
const late = await answersSince(back);
console.log(`core posts since the restart: ${late.length}${heard ? "" : ", and core never answered"}`);

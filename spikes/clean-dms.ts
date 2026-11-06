/**
 * Clears `spike-clr-*` traffic out of the personas' direct messages, so nothing from a spike shows on camera. Only
 * direct channels, and only posts by or about a `spike-clr-*` account: real cards stay, however old. Rooms are not
 * touched. Prints what it finds, and deletes only with --delete. Post text is never printed.
 *
 *   pnpm exec tsx spikes/clean-dms.ts            what it would do
 *   pnpm exec tsx spikes/clean-dms.ts --delete   do it, and hide each DM with a spike account from the sidebar
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../scripts/gateway-owner.js";

const PEOPLE = ["priya", "sam", "neha", "alex", "dev"];
const SPIKE = /^spike-clr-/;
const MENTION = /spike-clr-/;
const remove = process.argv.includes("--delete");
const tokens = (JSON.parse(readFileSync(join(ROOT, "data/secrets.json"), "utf8")) as { mattermostTokens: Record<string, string> }).mattermostTokens;
const container = `${process.env.COMPOSE_PROJECT_NAME ?? "switch"}-mattermost-1`;

async function mm(person: string, method: string, path: string, json?: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:8065/api/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[person]}`, "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${person} ${method} ${path}: ${res.status} ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}

const names = new Map<string, string>();
async function nameOf(person: string, id: string): Promise<string> {
  if (!names.has(id)) names.set(id, (await mm(person, "GET", `/users/${id}`)).username);
  return names.get(id)!;
}

let total = 0;
const done = new Set<string>();
for (const person of PEOPLE) {
  const me = await mm(person, "GET", "/users/me");
  const teams = await mm(person, "GET", "/users/me/teams");
  const hide: { user_id: string; category: string; name: string; value: string }[] = [];
  for (const team of teams) {
    const channels = await mm(person, "GET", `/users/me/teams/${team.id}/channels`);
    for (const channel of channels) {
      if (channel.type !== "D" || done.has(channel.id)) continue;
      const otherId = String(channel.name).split("__").find((id) => id !== me.id) ?? me.id;
      const other = await nameOf(person, otherId);
      const posts: { id: string; user_id: string; message: string }[] = [];
      for (let page = 0; page < 40; page++) {
        const batch = await mm(person, "GET", `/channels/${channel.id}/posts?page=${page}&per_page=200`);
        const list = Object.values(batch.posts) as { id: string; user_id: string; message: string }[];
        posts.push(...list);
        if (batch.order.length < 200) break;
      }
      const spiky: string[] = [];
      for (const post of posts) {
        const author = await nameOf(person, post.user_id);
        if (SPIKE.test(other) || SPIKE.test(author) || MENTION.test(post.message)) spiky.push(post.id);
      }
      done.add(channel.id);
      console.log(`${person} <-> ${other}: ${posts.length} posts, ${spiky.length} from a spike`);
      total += spiky.length;
      if (remove) {
        for (const id of spiky) {
          const result = spawnSync("docker", ["exec", container, "mmctl", "--local", "post", "delete", id, "--permanent", "--confirm"], { encoding: "utf8" });
          if (result.status !== 0) console.log(`  could not delete ${id}: ${(result.stderr || result.stdout).trim().slice(0, 120)}`);
        }
        if (SPIKE.test(other)) hide.push({ user_id: me.id, category: "direct_channel_show", name: otherId, value: "false" });
      }
    }
  }
  if (hide.length > 0) await mm(person, "PUT", `/users/${me.id}/preferences`, hide);
}
console.log(`${total} posts ${remove ? "deleted" : "would be deleted, with --delete"}`);

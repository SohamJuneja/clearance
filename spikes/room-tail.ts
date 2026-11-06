/**
 * The last posts in a channel, as a person sees them. Prints no secret.
 *
 *   pnpm exec tsx spikes/room-tail.ts <persona> <channel> [count] [width]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../scripts/gateway-owner.js";

const [persona, channelName, count = "12", width = "400"] = process.argv.slice(2);
if (!persona || !channelName) throw new Error("usage: room-tail.ts <persona> <channel> [count] [width]");
const token = (JSON.parse(readFileSync(join(ROOT, "data/secrets.json"), "utf8")) as { mattermostTokens: Record<string, string> }).mattermostTokens[persona]!;
const mm = async (path: string): Promise<any> =>
  (await fetch(`http://127.0.0.1:8065/api/v4${path}`, { headers: { authorization: `Bearer ${token}` } })).json();
const team = await mm("/teams/name/switch");
const channel = await mm(`/teams/${team.id}/channels/name/${channelName}`);
const page = await mm(`/channels/${channel.id}/posts?per_page=${count}`);
const names = new Map<string, string>();
for (const id of [...page.order].reverse()) {
  const post = page.posts[id];
  if (!names.has(post.user_id)) names.set(post.user_id, (await mm(`/users/${post.user_id}`)).username);
  const buttons = (post.props?.attachments ?? []).flatMap((a: any) => a.actions ?? []).map((a: any) => a.name);
  const at = new Date(post.create_at).toISOString().slice(11, 19);
  console.log(`${at} ${post.id} ${names.get(post.user_id)}: ${String(post.message).replace(/\n/g, " / ").slice(0, Number(width))}${buttons.length ? ` [${buttons.join(" | ")}]` : ""}`);
}

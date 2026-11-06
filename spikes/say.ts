/**
 * Say one thing in Mattermost as a persona, the way the person would. Scripted people only, never agents.
 *
 *   pnpm exec tsx spikes/say.ts <persona> <channel> "<text>" [--reply <post-id>]
 *   pnpm exec tsx spikes/say.ts <persona> --dm-with <other> "<text>"
 *   pnpm exec tsx spikes/say.ts <persona> --press <post-id> <button-pattern>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "../scripts/gateway-owner.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { reply: { type: "string" }, "dm-with": { type: "string" }, press: { type: "string" } },
});
const [persona, ...rest] = positionals;
if (!persona) throw new Error("see the header of this file");
const token = (JSON.parse(readFileSync(join(ROOT, "data/secrets.json"), "utf8")) as { mattermostTokens: Record<string, string> })
  .mattermostTokens[persona];
if (!token) throw new Error(`no token for ${persona}`);

async function mm(method: string, path: string, json?: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:8065/api/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

if (values.press) {
  const pattern = new RegExp(rest[0] ?? "Approve|Allow", "i");
  const post = await mm("GET", `/posts/${values.press}`);
  const actions: { id: string; name: string }[] = (post.props?.attachments ?? []).flatMap((a: any) => a.actions ?? []);
  const action = actions.find((a) => pattern.test(a.name));
  if (!action) throw new Error(`no button matching ${pattern} on ${values.press}: ${actions.map((a) => a.name).join(", ")}`);
  await mm("POST", `/posts/${values.press}/actions/${action.id}`, {});
  console.log(`${persona} pressed "${action.name}" on ${values.press}`);
} else {
  const team = await mm("GET", "/teams/name/switch");
  let channelId: string;
  let text: string;
  if (values["dm-with"]) {
    const me = await mm("GET", "/users/me");
    const other = await mm("GET", `/users/username/${values["dm-with"]}`);
    channelId = (await mm("POST", "/channels/direct", [me.id, other.id])).id;
    text = rest[0]!;
  } else {
    channelId = (await mm("GET", `/teams/${team.id}/channels/name/${rest[0]}`)).id;
    text = rest[1]!;
  }
  const post = await mm("POST", "/posts", { channel_id: channelId, message: text, root_id: values.reply ?? "" });
  console.log(`${persona} said (post ${post.id}): ${text}`);
}

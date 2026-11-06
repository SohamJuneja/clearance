/**
 * Who is really in a room, from both sides: Switch's room detail and the Mattermost channel. Prints no secrets.
 *
 *   pnpm exec tsx spikes/room-state.ts support eng approvals finance
 */
import { readFileSync } from "node:fs";
import { ownerGateway, ROOT } from "../scripts/gateway-owner.js";

const gateway = await ownerGateway("alex");
const token = (JSON.parse(readFileSync(`${ROOT}/data/secrets.json`, "utf8")) as { mattermostTokens: Record<string, string> })
  .mattermostTokens.user!;
const mm = async (path: string) =>
  (await (await fetch(`http://127.0.0.1:8065/api/v4${path}`, { headers: { authorization: `Bearer ${token}` } })).json()) as any;

const rooms = await gateway.must<{ id: string; name: string }[]>("GET", "/rooms");
for (const name of process.argv.slice(2)) {
  const room = rooms.find((r) => r.name === name);
  if (!room) {
    console.log(`${name}: no room`);
    continue;
  }
  const detail = await gateway.must<Record<string, any>>("GET", `/rooms/${room.id}`);
  const channel = detail.external_channel_id ? await mm(`/channels/${detail.external_channel_id}`) : null;
  const members = channel ? ((await mm(`/channels/${channel.id}/members?per_page=100`)) as { user_id: string }[]) : [];
  const usernames: string[] = [];
  for (const member of members) usernames.push((await mm(`/users/${member.user_id}`)).username);
  console.log(
    JSON.stringify({
      name,
      id: room.id,
      owner: detail.owner_name,
      agent_count: detail.agent_count,
      agent_statuses: detail.agent_statuses,
      connected_users: detail.connected_user_names,
      group: detail.group_name ?? null,
      channel: channel ? { slug: channel.name, display: channel.display_name, type: channel.type, id: channel.id } : null,
      mattermost_members: usernames.sort(),
    }),
  );
}

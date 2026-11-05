/**
 * Removes what this set of spikes left in Switch: rooms named by spike scripts here, owned by
 * clearance-admin or a persona, plus the rooms Switch auto-bridges from the Mattermost channels those
 * leave behind. Other people's spike rooms are owned by the gateway admin and are never touched.
 * Lists candidates. Deletes only the room ids named after --delete, so the scope is always spelled out.
 *
 * The Mattermost channels go separately: `mmctl --local channel delete` inside the Mattermost container.
 */
import { readFileSync } from "node:fs";
import { BRIDGE_URL, identities, say } from "./lib.js";

const env = Object.fromEntries(
  readFileSync(process.env.SWITCH_ENV_FILE!, "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "")]),
);
const deleteAt = process.argv.indexOf("--delete");
const named = new Set(deleteAt >= 0 ? process.argv.slice(deleteAt + 1) : []);

const login = await fetch(`${BRIDGE_URL}/gateway/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: env.GATEWAY_ADMIN_EMAIL, password: env.GATEWAY_ADMIN_PASSWORD }),
});
if (!login.ok) throw new Error(`gateway login failed: ${login.status}`);
const cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;

async function gateway(method: string, path: string) {
  const res = await fetch(`${BRIDGE_URL}/gateway${path}`, { method, headers: { cookie } });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON.
  }
  return { status: res.status, body };
}

type Room = { id: string; name: string; owner_id?: string; group_name?: string | null; group_id?: string | null; created_at?: string };
const listed = await gateway("GET", "/rooms?include_archived=true&limit=500");
const raw = listed.body as Room[] | { rooms?: Room[]; items?: Room[] };
const rooms: Room[] = Array.isArray(raw) ? raw : (raw.rooms ?? raw.items ?? []);
say(`${rooms.length} rooms visible`);

const mine = new Set([
  identities.agents.clearance!.ownerUserId,
  ...Object.values(identities.people).map((person) => person.switchUserId),
]);
const OURS = /^(Mattermost: )?(spike-[a-z0-9-]+-\d{13}(-[0-9a-f]{8})?|clearance-identity-probe(-[0-9a-f]+)?)$/;
// Switch shows an auto-bridged room without its "Mattermost: " prefix, and it has no owner.
const AUTO_BRIDGED = /^(Mattermost: )?(support|finance|eng|approvals|spike-[a-z0-9-]+-\d{13})$/;
const doomed = rooms.filter(
  (room) => (OURS.test(room.name) && mine.has(room.owner_id ?? "")) || (AUTO_BRIDGED.test(room.name) && !room.owner_id),
);
for (const room of rooms) {
  if (!doomed.includes(room)) say(`  keeping ${room.name} owner=${room.owner_id ?? "?"}`);
}
for (const room of doomed) {
  const go = named.has(room.id);
  say(`  ${go ? "deleting" : "candidate"} ${room.id} ${room.name} owner=${room.owner_id ?? "?"} group=${room.group_id ?? "-"} ${room.group_name ?? ""}`);
  if (go) {
    const res = await gateway("DELETE", `/rooms/${room.id}`);
    if (res.status >= 300) say(`    HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  }
}
const groups = await gateway("GET", "/room-groups");
for (const group of (groups.body as { id: string; name: string }[])) {
  const go = named.has(group.id);
  if (!go && !group.name.startsWith("spike-")) continue;
  say(`  ${go ? "deleting" : "candidate"} group ${group.id} ${group.name}`);
  if (go) {
    const res = await gateway("DELETE", `/room-groups/${group.id}`);
    if (res.status >= 300) say(`    HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  }
}

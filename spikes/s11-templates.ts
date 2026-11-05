/**
 * S11: can an agent run a template that includes Clearance, and does a template accept an existing
 * external agent in a room's `agents:`? Also validates every file in templates/ with the real server:
 * its linter, then its planner by running each document against a machine that does not exist, which
 * is refused with the full list of problems before anything is created.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAgent } from "../packages/switch-agent/src/register.js";
import { BRIDGE_URL, Frames, clearanceAgent, identities, mattermost, say, sleep, writeFixture } from "./lib.js";

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");
const read = (name: string) => readFileSync(join(TEMPLATES, `${name}.template.yaml`), "utf8");
const password = process.env.PERSONA_PASSWORD;
if (!password) throw new Error("PERSONA_PASSWORD is not set");

async function login(email: string, secret: string): Promise<string> {
  const res = await fetch(`${BRIDGE_URL}/gateway/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: secret }),
  });
  if (!res.ok) throw new Error(`login as ${email}: ${res.status}`);
  return res.headers.getSetCookie()[0]!.split(";")[0]!;
}

async function gateway(method: string, path: string, cookie: string, json?: unknown) {
  const res = await fetch(`${BRIDGE_URL}/gateway${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON.
  }
  return { status: res.status, body: body as Record<string, unknown> };
}

const alex = await login("alex@clearance.example", password);

// ── The server's own checks on each template ─────────────────────────────────
for (const name of ["clearance", "acme-mini", "acme-vanilla"]) {
  const lint = await gateway("POST", "/templates/validate", alex, { content: read(name) });
  say(`[lint] ${name}: ok=${String(lint.body.ok)} blocked=${String(lint.body.blocked)} errors=${JSON.stringify(lint.body.errors)} warnings=${JSON.stringify(lint.body.warnings)}`);
}

/** The document with its rooms and group renamed, so a run of it cannot touch the real names. */
function spikeNamed(document: string, stamp: number): string {
  return document
    .replace("name: Acme Mini", `name: spike-acme-${stamp}`)
    .replace(/^(\s+name:) (support|finance|eng|approvals)$/gm, `$1 spike-$2-${stamp}`);
}

const planned = async (name: string, inputs: Record<string, unknown>) => {
  const res = await gateway("POST", "/rooms/from-template-document", alex, {
    template: read(name),
    inputs,
    template_name: `plan-${name}`,
  });
  return res;
};
for (const [name, inputs] of [
  ["acme-mini", { machine: "no-such-machine" }],
  ["acme-mini", { machine: "no-such-machine", create_eng_agents: false, create_rooms: false }],
  ["acme-vanilla", { machine: "no-such-machine", auto_mode: false }],
] as const) {
  const res = await planned(name, inputs);
  const problems = (res.body.problems ?? []) as { slot: string; code: string; message: string }[];
  say(`[plan] ${name} ${JSON.stringify(inputs)}: HTTP ${res.status} code=${String(res.body.code)}`);
  for (const problem of problems) say(`   ${problem.slot}: ${problem.code}: ${problem.message.slice(0, 160)}`);
  if (res.status !== 409) say(`   body: ${JSON.stringify(res.body).slice(0, 400)}`);
}

// ── An existing external agent, in a template an agent runs ──────────────────
const clearance = clearanceAgent();
const frames = new Frames();
await clearance.start({ frame: frames.handler });
const stamp = Date.now();

// Rooms only, against agents that are not there: refused by name with nothing created. Spike names all
// the same: should the agents exist after all, this must not make rooms under the real names.
const noAgents = await gateway("POST", "/rooms/from-template-document", alex, {
  template: spikeNamed(read("acme-mini"), stamp),
  inputs: { create_support_agents: false, create_eng_agents: false, create_rooms: true },
  template_name: "spike-acme-absent",
});
const absent = (noAgents.body.room ?? {}) as { rooms?: { room_name: string }[]; errors?: unknown[] };
say(`[plan] acme-mini rooms only, agents absent: HTTP ${noAgents.status} made=${JSON.stringify(absent.rooms?.map((entry) => entry.room_name))} errors=${JSON.stringify(absent.errors ?? noAgents.body).slice(0, 500)}`);

const saved = await clearance.op<{ id: string; kind: string; warnings: unknown[] }>("save_template", {
  name: `clearance-install-${stamp}`,
  description: "Clearance's approvals room",
  yaml: read("clearance"),
  visibility: "private",
});
say(`[s11] save_template: ${JSON.stringify(saved)}`);
const detail = await clearance.op<Record<string, unknown>>("get_template", { template_id: saved.id });
say(`[s11] get_template: ${JSON.stringify({ params: detail.params, slots: detail.slots ?? detail.agents }).slice(0, 500)}`);

const roomName = `spike-approvals-${stamp}`;
const run = await clearance.op<Record<string, unknown> & { room_id: string; created_document_ids: string[] }>("run_template", {
  template_id: saved.id,
  inputs: { room_name: roomName },
});
say(`[s11] run_template as Clearance: ${JSON.stringify(run)}`);
const created = await clearance.op<{ agent_names: string[]; connected_user_names: string[]; external_channel_id: string; channel_type: string; group_name: string | null }>("get_room_detail", {
  room_id: run.room_id,
});
say(`[s11] the room: ${JSON.stringify({ agents: created.agent_names, users: created.connected_user_names, channel_type: created.channel_type, group: created.group_name })}`);

// A person runs a document that lists Clearance. It speaks with its kickoff, as the person's platform.
const personDoc = `
version: 2
params:
  stamp: { type: string }
resources:
  ext_group:
    type: group
    name: "spike-group-{stamp}"
    description: spike S11
    links:
      - { from: first, to: second, label: spike }
  first:
    type: room
    group: ext_group
    name: "spike-first-{stamp}"
    description: spike S11
    agents: [clearance]
    users: [alex, priya]
    kickoff: "@clearance a person's template names you here."
  second:
    type: room
    group: ext_group
    name: "spike-second-{stamp}"
    description: spike S11
    agents: [clearance]
    users: [alex]
`;
const person = await gateway("POST", "/rooms/from-template-document", alex, {
  template: personDoc,
  inputs: { stamp: String(stamp) },
  template_name: "spike-s11-person",
});
say(`[s11] a person's run listing Clearance: HTTP ${person.status} ${JSON.stringify(person.body).slice(0, 500)}`);
await sleep(1500);
const kickoff = frames.all.find(
  (frame) => frame.name === "message" && (frame.data.payload as { body: string }).body.includes("a person's template"),
);
if (kickoff) {
  writeFixture("message_platform_kickoff", kickoff.data);
  say(`[s11] the kickoff on Clearance's stream: ${JSON.stringify(kickoff.data.payload).slice(0, 700)}`);
} else {
  say("[s11] no kickoff frame reached Clearance's stream");
}

// Can Clearance put itself into someone else's room?
const room = (person.body.room as { rooms?: { room_id: string; room_name: string }[] } | null)?.rooms?.[0];
const alexOwn = await gateway("POST", "/rooms/from-yaml", alex, {
  yaml: `room:\n  name: spike-alex-only-${stamp}\n  description: spike\n  users: [alex]\n`,
});
say(`[s11] Alex's own room, without Clearance: HTTP ${alexOwn.status}`);
const alexRoomId = String(alexOwn.body.room_id);
const invited = await clearance
  .op("invite_agent_to_room", { room_id: alexRoomId, agent_name: "clearance" })
  .then(
    () => "allowed",
    (error: Error) => `refused: ${error.message}`,
  );
say(`[s11] Clearance inviting itself into a room it is not in: ${invited}`);
const alexInvites = await gateway("POST", `/rooms/${alexRoomId}/agents`, alex, { agent_ids: [identities.agents.clearance!.switchAgentId] });
say(`[s11] Alex adding Clearance through the Gateway: HTTP ${alexInvites.status} ${JSON.stringify(alexInvites.body).slice(0, 200)}`);

// Running again with the same room name.
const repeat = await clearance
  .op<Record<string, unknown>>("run_template", { template_id: saved.id, inputs: { room_name: roomName } })
  .then(
    (result) => `made another: ${JSON.stringify(result).slice(0, 200)}`,
    (error: Error) => `refused: ${error.message.slice(0, 300)}`,
  );
say(`[s11] running it again with the same room name: ${repeat}`);

// ── Acme Mini's rooms for real, with stand-ins for its agents ────────────────
// The rooms half can only be proven by creating it, and it needs its agents to exist. Stand-in protocol
// agents and spike names keep it from touching what the real run will use.
const keyRes = await gateway("POST", "/api-keys", alex, { label: `spike-s11-${stamp}` });
const standIns: Record<string, string> = {};
for (const name of ["refunds-agent", "support-agent", "coder", "ops-agent", "reviewer"]) {
  const registered = await registerAgent({
    bridgeUrl: BRIDGE_URL,
    registrationKey: String(keyRes.body.key),
    name,
    description: "Spike S11 stand-in",
    overwrite: true,
  });
  standIns[name] = registered.agentId;
}
const acmeRooms = spikeNamed(read("acme-mini"), stamp + 1);
const acme = await gateway("POST", "/rooms/from-template-document", alex, {
  template: acmeRooms,
  inputs: { create_support_agents: false, create_eng_agents: false, create_rooms: true },
  template_name: "spike-acme",
});
say(`[acme] rooms part: HTTP ${acme.status}`);
const group = (acme.body.room ?? {}) as { group_id?: string; rooms?: { room_id: string; room_name: string; created_document_ids: string[] }[]; errors?: unknown[] };
say(`[acme] errors: ${JSON.stringify(group.errors)}`);
for (const entry of group.rooms ?? []) {
  const roomDetail = await gateway("GET", `/rooms/${entry.room_id}`, alex);
  const body = roomDetail.body as { agents?: { name: string }[]; agent_names?: string[]; connected_user_names?: string[]; users?: unknown; group_name?: string };
  say(`[acme] ${entry.room_name}: docs=${entry.created_document_ids.length} ${JSON.stringify(body).slice(0, 260)}`);
}
if (acme.status !== 201) say(`[acme] body: ${JSON.stringify(acme.body).slice(0, 500)}`);
const links = group.rooms?.[0] ? await gateway("GET", `/rooms/${group.rooms[0].room_id}/links`, alex) : undefined;
say(`[acme] links from the first room: ${String(JSON.stringify(links?.body)).slice(0, 300)}`);
for (const entry of group.rooms ?? []) {
  await gateway("POST", `/rooms/${entry.room_id}/archive`, alex);
}
// Deleting a group takes an admin: spikes/cleanup.ts does that, and removes the rooms.
for (const id of Object.values(standIns)) await gateway("DELETE", `/agents/${id}`, alex);
await gateway("DELETE", `/api-keys/${String(keyRes.body.id)}`, alex);

// Nothing here is meant to outlive the spike.
const rooms = await clearance.op<{ room_id: string; name: string }[]>("list_rooms", {});
for (const entry of rooms) {
  if (entry.name.startsWith("spike-")) {
    await clearance.op("archive_room", { room_id: entry.room_id }).catch(() => undefined);
  }
}
await clearance.op("delete_template", { template_id: saved.id });
await clearance.stop();
void room;
void mattermost;
void identities;

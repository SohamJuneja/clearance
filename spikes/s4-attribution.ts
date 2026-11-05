/**
 * S4: when a persona addresses another agent in a room Clearance belongs to, what does Clearance's own
 * stream see? Uses a protocol agent owned by Alex as the addressed agent. Also records the command and
 * message fixtures, which only a stream of the addressed agent can show.
 */
import { createSwitchAgent, type SwitchAgent } from "../packages/switch-agent/src/agent.js";
import { BRIDGE_URL, Frames, clearanceAgent, identities, mattermost, say, sleep, waitFor, writeFixture } from "./lib.js";

const WORKER = "spike-worker";

async function gatewayLogin(email: string, password: string): Promise<string> {
  const res = await fetch(`${BRIDGE_URL}/gateway/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login as ${email}: ${res.status}`);
  return res.headers.getSetCookie()[0]!.split(";")[0]!;
}

async function json(path: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BRIDGE_URL}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
}

const password = process.env.PERSONA_PASSWORD;
if (!password) throw new Error("PERSONA_PASSWORD is not set");
const alexCookie = await gatewayLogin("alex@clearance.example", password);
const key = await json("/gateway/api-keys", {
  method: "POST",
  headers: { "content-type": "application/json", cookie: alexCookie },
  body: JSON.stringify({ label: "spike-worker-registration" }),
});
const registered = await json("/agents", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${String(key.body.key)}` },
  body: JSON.stringify({
    name: WORKER,
    description: "Spike S4: a protocol agent that people address.",
    connector_type: "external",
    integration_profile: {
      connection_model: "always_on",
      message_exchange: true,
      pre_invocation_mediation: [],
      post_invocation_mediation: [],
      event_reporting: [],
      command_capabilities: { reset: "always", compact: "unsupported", interrupt: "unsupported" },
    },
    overwrite: true,
  }),
});
if (registered.status !== 200) throw new Error(`registering ${WORKER}: ${JSON.stringify(registered.body)}`);
const workerId = String(registered.body.id);
await json(`/gateway/agents/${workerId}/addressing-policy`, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie: alexCookie },
  body: JSON.stringify({ policy: { rules: [{ users: "*", agents: "*" }] } }),
});

const worker: SwitchAgent = createSwitchAgent({
  bridgeUrl: BRIDGE_URL,
  agentId: workerId,
  apiKey: String(registered.body.api_key),
});
const workerFrames = new Frames();
await worker.start({ frame: workerFrames.handler });

const clearance = clearanceAgent();
const seen = new Frames();
await clearance.start({ frame: seen.handler });

const room = await clearance.op<{ id: string }>("create_room", {
  name: `spike-s4-${Date.now()}`,
  description: "spike S4",
  agent_names: ["clearance", WORKER],
  user_names: ["priya", "alex", "sam"],
  channel_type: "channel_private",
});
// Naming the room on the connection wakes the stream, so it starts reading it now rather than at the
// next keepalive. A message posted before that is treated as history and never delivered.
await clearance.op("list_participants", {}, { roomId: room.id });
await worker.op("list_participants", {}, { roomId: room.id });
const { external_channel_id: channelId } = await clearance.op<{ external_channel_id: string }>("get_room_detail", {
  room_id: room.id,
});
await sleep(1000);

const priya = mattermost("priya");
const alex = mattermost("alex");

const messageOn = (frames: Frames, body: string) =>
  frames.waitFor(`"${body}"`, (name, data) => name === "message" && (data.payload as { body: string }).body === body);

// 1. A person addresses the agent at the room's root.
const asked = "@spike-worker refund order A-1931";
const askedPost = await priya.post(channelId, asked);
const onClearance = await messageOn(seen, asked);
const onWorker = await messageOn(workerFrames, asked);
writeFixture("message_other_agent_addressed", onClearance.data);
writeFixture("message_addressed_to_me", onWorker.data);
say(`root, on Clearance's stream: ${JSON.stringify(onClearance.data)}`);
say(`root, on the worker's stream: ${JSON.stringify((onWorker.data.payload as Record<string, unknown>).addressed)}`);

// 2. Someone else in a thread off that message.
const threaded = "@spike-worker make it 40,000 instead";
await alex.post(channelId, threaded, askedPost.id);
const threadFrame = await messageOn(seen, threaded);
writeFixture("message_in_thread", threadFrame.data);
say(`thread, on Clearance's stream: ${JSON.stringify(threadFrame.data.payload)}`);

// 3. An unaddressed reply in the thread: does the agent's "follow up" rule mark it addressed?
const followUp = "thanks";
await priya.post(channelId, followUp, askedPost.id);
const followFrame = await messageOn(seen, followUp);
const followWorker = await messageOn(workerFrames, followUp).catch(() => undefined);
say(`follow-up on Clearance: addressed=${String((followFrame.data.payload as { addressed: boolean }).addressed)}; on worker: ${followWorker ? String((followWorker.data.payload as { addressed: boolean }).addressed) : "not delivered"}`);

// 4. The agent speaks: root, then addressing another agent, as it would when delegating.
const agentSaid = "Refunding 4,000 for order A-1931 as requested in T-77.";
await worker.sendMessage(room.id, agentSaid);
const agentFrame = await messageOn(seen, agentSaid);
writeFixture("message_from_agent", agentFrame.data);
say(`agent's message on Clearance's stream: ${JSON.stringify(agentFrame.data.payload)}`);

const delegated = "please review the refund";
const targeted = await worker.op<{ event_id: string; target_statuses: Record<string, string> }>(
  "send_targeted_message",
  { body: delegated, target_names: ["clearance"], thread_id: null },
  { roomId: room.id },
);
say(`worker targeted clearance: ${JSON.stringify(targeted)}`);
const targetedFrame = await waitFor("the targeted message", () =>
  seen.all.find(
    (frame) => frame.name === "message" && (frame.data.payload as { body: string }).body.includes(delegated),
  ),
);
say(`targeted on Clearance's stream: ${JSON.stringify(targetedFrame.data.payload)}`);

// 4b. An agent cannot answer a card, even by typing the grammar into the room.
{
  const requestId = `s4-card-${Date.now()}`;
  const title = `CLR-S4-${Date.now()} refund`;
  await clearance.openApproval({
    session_id: `clr-room-${room.id}`,
    request_id: requestId,
    turn_id: "s4",
    kind: "approval",
    title,
    detail: null,
    options: [
      { id: "allow", label: "Allow", decision: "accept" },
      { id: "deny", label: "Deny", decision: "decline" },
    ],
    questions: [],
    room_id: room.id,
    thread_id: null,
    expires_at: null,
  });
  const card = await waitFor("the card", async () => (await priya.posts(channelId)).find((post) => post.message.includes(title)));
  const handle = /request `(A\d+)`/.exec(card.message)![1]!;
  await worker.sendMessage(room.id, `${handle} yes`);
  await sleep(2000);
  const answered = seen.all.some((frame) => frame.name === "approval_outcome" && frame.data.request_id === requestId);
  say(`the worker typed "${handle} yes" into the room: card answered = ${answered}`);
  await clearance.closeApproval(`clr-room-${room.id}`, requestId);
}

// 5. Clearance addresses the agent, the way it will report "approved" or "denied".
const told = await clearance.op<{ event_id: string; target_statuses: Record<string, string> }>(
  "send_targeted_message",
  { body: "CLR-0042 approved by Sam and executed.", target_names: [WORKER] },
  { roomId: room.id },
);
say(`clearance targeted the worker: ${JSON.stringify(told)}`);
const notified = await waitFor("the notification", () =>
  workerFrames.all.find((frame) => frame.name === "message" && (frame.data.payload as { body: string }).body.includes("CLR-0042")),
);
say(`on the worker's stream: ${JSON.stringify(notified.data.payload)}`);

// 6. A person mentioned by Clearance.
const toPerson = await clearance.op<{ event_id: string; target_statuses: Record<string, string> }>(
  "send_targeted_message",
  { body: "CLR-0042 needs your response.", target_names: ["sam"] },
  { roomId: room.id },
);
say(`clearance targeted sam: ${JSON.stringify(toPerson)}`);
await sleep(500);
const posts = await priya.posts(channelId);
say(`as posted: ${JSON.stringify(posts.slice(0, 3).map((post) => post.message))}`);

// 7. A room command on the addressed agent's stream, and whether Clearance hears it.
await alex.post(channelId, `!reset @${WORKER}`);
await sleep(2500);
say(`after !reset: ${JSON.stringify((await priya.posts(channelId)).slice(0, 3).map((post) => post.message))}`);
say(`worker frames so far: ${workerFrames.all.map((frame) => frame.name).join(",")}`);
const relayed = workerFrames.all.find((frame) => frame.name === "session_command");
if (relayed) {
  writeFixture("session_command", relayed.data);
  say(`on a revision 9 watcher the room command arrives as session_command: ${JSON.stringify(relayed.data)}`);
}

// A plain `command` frame only reaches an agent with no session placed in the room, so this takes a
// fresh room and a stream that places nothing.
await worker.stop();
const commandRoom = await clearance.op<{ id: string }>("create_room", {
  name: `spike-s4-cmd-${Date.now()}`,
  description: "spike S4 command",
  agent_names: ["clearance", WORKER],
  user_names: ["alex"],
  channel_type: "channel_private",
});
const { external_channel_id: commandChannel } = await clearance.op<{ external_channel_id: string }>("get_room_detail", {
  room_id: commandRoom.id,
});
const legacy = await fetch(
  `${BRIDGE_URL}/agents/${workerId}/events?connection_id=spike-legacy-${Date.now()}&scope=all&filter=all&protocol=4&protocol_accepts=1&start_at=head`,
  {
    headers: { authorization: `Bearer ${String(registered.body.api_key)}`, accept: "text/event-stream" },
    signal: AbortSignal.timeout(15_000),
  },
);
await sleep(500);
await alex.post(commandChannel, `!reset @${WORKER}`);
const legacyReader = legacy.body!.getReader();
const decoder = new TextDecoder();
let buffered = "";
while (!buffered.includes("event: command")) {
  const { value, done } = await legacyReader.read();
  if (done) throw new Error("the legacy stream ended before a command frame");
  buffered += decoder.decode(value, { stream: true });
}
const legacyFrame = buffered
  .split("\n\n")
  .find((block) => block.includes("event: command"))!
  .split("\n")
  .find((line) => line.startsWith("data: "))!
  .slice(6);
writeFixture("command", JSON.parse(legacyFrame));
say(`command on a revision 4 stream: ${legacyFrame}`);
await legacyReader.cancel();
await sleep(1000);
say(`clearance saw a command frame: ${seen.all.some((frame) => frame.name === "command")}`);
const resetFrame = seen.all.find(
  (frame) => frame.name === "message" && (frame.data.payload as { body: string }).body.startsWith("!reset"),
);
say(`clearance saw the !reset text as a message: ${resetFrame ? JSON.stringify(resetFrame.data.payload) : "no"}`);

// Nothing here is meant to outlive the spike.
await clearance.op("archive_room", { room_id: room.id });
await clearance.op("archive_room", { room_id: commandRoom.id });
await clearance.stop();
const removed = await json(`/gateway/agents/${workerId}`, { method: "DELETE", headers: { cookie: alexCookie } });
say(`removed ${WORKER}: HTTP ${removed.status}`);
await json(`/gateway/api-keys/${String(key.body.id)}`, { method: "DELETE", headers: { cookie: alexCookie } });
void identities;

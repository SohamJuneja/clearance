/**
 * S3: can an addressing policy restrict who may answer Clearance's cards? Sets the policy through the
 * Gateway as Clearance's owner, then has a non-approver and an unlinked account try to answer.
 * Puts the policy back the way setup-identities.ts leaves it.
 */
import { BRIDGE_URL, clearanceAgent, identities, mattermost, say, secrets, sleep, waitFor, Frames } from "./lib.js";

async function gateway(method: string, path: string, cookie: string | null, json?: unknown) {
  const res = await fetch(`${BRIDGE_URL}/gateway${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON.
  }
  return { status: res.status, body: body as Record<string, unknown>, headers: res.headers };
}

const login = await gateway("POST", "/auth/login", null, {
  email: "clearance-admin@clearance.example",
  password: secrets.clearanceAdminPassword,
});
const cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
const agentId = identities.agents.clearance!.switchAgentId;
const row = (name: string) => identities.people[name]!.externalUserRowId;

const put = (policy: unknown) => gateway("PUT", `/agents/${agentId}/addressing-policy`, cookie, { policy });

const approversOnly = { rules: [{ users: [row("sam"), row("neha")], agents: [] }] };
const narrowed = await put(approversOnly);
say(`PUT addressing-policy (approvers only): HTTP ${narrowed.status}`);
const readBack = await gateway("GET", `/agents/${agentId}`, cookie);
say(`stored as: ${JSON.stringify((readBack.body as { addressing_policy?: unknown }).addressing_policy ?? readBack.body.addressing)}`);

const agent = clearanceAgent();
const frames = new Frames();
await agent.start({ frame: frames.handler });
const name = `spike-s3-${Date.now()}`;
const room = await agent.op<{ id: string }>("create_room", {
  name,
  description: "spike S3",
  agent_names: ["clearance"],
  user_names: ["sam", "neha", "priya", "guest"],
  channel_type: "channel_private",
});
const { external_channel_id: channelId } = await agent.op<{ external_channel_id: string }>("get_room_detail", {
  room_id: room.id,
});

const requestId = `s3-${Date.now()}`;
const title = "CLR-S3 refund ₹40,000 · HIGH";
await agent.openApproval({
  session_id: `clr-room-${room.id}`,
  request_id: requestId,
  turn_id: "s3",
  kind: "approval",
  title,
  detail: "spike",
  options: [
    { id: "allow", label: "Allow", decision: "accept" },
    { id: "deny", label: "Deny", decision: "decline" },
  ],
  questions: [],
  room_id: room.id,
  thread_id: null,
  expires_at: null,
});
const sam = mattermost("sam");
const card = await waitFor("the card", async () => (await sam.posts(channelId)).find((post) => post.message.includes(title)));
const button = card.props.attachments![0]!.actions![0]!.id;
const handle = /request `(A\d+)`/.exec(card.message)![1]!;

const answered = () => frames.all.find((frame) => frame.name === "approval_outcome" && frame.data.request_id === requestId);

for (const [persona, kind] of [
  ["priya", "linked, not in the policy"],
  ["guest", "unlinked"],
] as const) {
  const hands = mattermost(persona);
  const press = await hands.press(card.id, button);
  await sleep(1500);
  say(`${persona} (${kind}) pressed: HTTP ${press.status} ${JSON.stringify(press.body).slice(0, 300)}; outcome so far: ${answered() ? "ANSWERED" : "none"}`);
  await hands.post(channelId, `${handle} yes`);
  await sleep(1500);
  say(`${persona} typed "${handle} yes"; outcome so far: ${answered() ? "ANSWERED" : "none"}`);
}
const all = await sam.posts(channelId);
for (const post of all.slice(0, 6)) {
  say(`post: ${JSON.stringify({ user: post.user_id, type: post.type, message: post.message.slice(0, 200) })}`);
}

// Does the unlinked or unlisted account's plain message still reach Clearance's stream?
const before = frames.all.length;
await mattermost("guest").post(channelId, "@clearance inbox");
await mattermost("priya").post(channelId, "@clearance inbox");
await sleep(2000);
for (const frame of frames.all.slice(before)) {
  if (frame.name !== "message") continue;
  const payload = frame.data.payload as Record<string, unknown>;
  say(`clearance stream: ${JSON.stringify({ from: payload.sender_name, addressed: payload.addressed, kind: payload.sender_kind, body: payload.body })}`);
}
const afterMessages = await sam.posts(channelId);
for (const post of afterMessages.slice(0, 4)) {
  say(`post: ${JSON.stringify({ user: post.user_id, message: post.message.slice(0, 200) })}`);
}

// Someone in the policy still can.
const press = await sam.press(card.id, button);
const outcome = await waitFor("sam's answer", answered);
say(`sam pressed: HTTP ${press.status}; answered_by ${String(outcome.data.answered_by)}`);

const restored = await put({
  rules: [
    {
      users: Object.values(identities.people).map((person) => person.externalUserRowId),
      agents: "*",
      owner: true,
    },
  ],
});
say(`restored the setup policy: HTTP ${restored.status}`);
await agent.stop();

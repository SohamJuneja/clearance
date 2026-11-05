/**
 * S7: a direct room between Clearance and one person, with a card that has buttons.
 *   a) what PLAN 4.7 asks: create_room(channel_type="direct"). Mattermost refuses it.
 *   b) the person opens the DM from Mattermost, which is the only way Mattermost allows.
 *   c) a private channel holding only that person and Clearance.
 * S8: a room document created then updated by Clearance, visible with !list-documents.
 */
import { Frames, clearanceAgent, identities, mattermost, say, sleep, waitFor, writeFixture } from "./lib.js";
import type { SwitchAgent } from "../packages/switch-agent/src/agent.js";

const agent = clearanceAgent();
const frames = new Frames();
await agent.start({ frame: frames.handler });
const stamp = Date.now();

async function cardInRoom(tag: string, roomId: string, channelId: string, persona: string, client: SwitchAgent): Promise<void> {
  const hands = mattermost(persona);
  const requestId = `s7-${tag}-${stamp}`;
  const title = `CLR-S7${tag}-${stamp} refund ₹40,000 · HIGH`;
  await client.openApproval({
    session_id: `clr-room-${roomId}`,
    request_id: requestId,
    turn_id: "s7",
    kind: "approval",
    title,
    detail: "spike S7",
    options: [
      { id: "allow", label: "Allow", decision: "accept" },
      { id: "deny", label: "Deny", decision: "decline" },
    ],
    questions: [],
    room_id: roomId,
    thread_id: null,
    expires_at: null,
  });
  const card = await waitFor(`the card in ${tag}`, async () =>
    (await hands.posts(channelId)).find((post) => post.message.includes(title)),
  );
  const actions = card.props.attachments?.[0]?.actions ?? [];
  say(`[${tag}] card: ${JSON.stringify(card.message)} buttons: ${JSON.stringify(actions.map((action) => action.name))}`);
  const press = await hands.press(card.id, actions[0]!.id);
  const outcome = await frames.waitFor(
    "the press",
    (name, data) => name === "approval_outcome" && data.request_id === requestId,
  );
  say(`[${tag}] press: HTTP ${press.status}; outcome: ${JSON.stringify({ answer: outcome.data.answer, answered_by: outcome.data.answered_by })}`);
}

async function membersOf(channelId: string, persona: string): Promise<string> {
  const hands = mattermost(persona);
  const channel = await hands.call("GET", `/channels/${channelId}`);
  const members = await hands.call("GET", `/channels/${channelId}/members`);
  const names = await Promise.all(
    (members.body as unknown as { user_id: string }[]).map(
      async (member) => (await hands.call("GET", `/users/${member.user_id}`)).body.username as string,
    ),
  );
  return `type=${String(channel.body.type)} name=${String(channel.body.name)}; members: ${names.join(", ")}`;
}

// a) As PLAN 4.7 wrote it.
const refused = await agent
  .op("create_room", {
    name: `spike-dm-${stamp}`,
    description: "direct",
    agent_names: ["clearance"],
    user_names: ["sam"],
    channel_type: "direct",
  })
  .then(
    (room) => `made ${JSON.stringify(room)}`,
    (error: Error) => `refused: ${error.message}`,
  );
say(`[a] create_room(channel_type=direct): ${refused}`);

// b) The person opens a DM with the agent's Mattermost account, here with a persona token.
const sam = mattermost("sam");
const bot = await sam.call("GET", "/users/username/clearance");
// An earlier run may have left a card open in this DM. Answer it, so it cannot be mistaken for this one.
{
  const existing = await sam.call("POST", "/channels/direct", [identities.people.sam!.mattermostUserId, String(bot.body.id)]);
  for (const post of await sam.posts(String(existing.body.id))) {
    const button = post.props.attachments?.[0]?.actions?.at(-1);
    if (button) await sam.press(post.id, button.id);
  }
}
say(`[b] the agent's Mattermost account: ${JSON.stringify({ id: bot.body.id, is_bot: bot.body.is_bot, username: bot.body.username, status: bot.status })}`);
const samId = identities.people.sam!.mattermostUserId;
const direct = await sam.call("POST", "/channels/direct", [samId, String(bot.body.id)]);
say(`[b] POST /channels/direct: HTTP ${direct.status} ${JSON.stringify({ id: direct.body.id, type: direct.body.type })}`);
const dmChannel = String(direct.body.id);
await sam.post(dmChannel, "hello");
const hello = await frames.waitFor(
  "the message in the DM",
  (name, data) => name === "message" && (data.payload as { body: string }).body === "hello",
  20_000,
);
writeFixture("message_direct_room", hello.data);
say(`[b] on Clearance's stream: ${JSON.stringify({ room: hello.data.room_id, channel_type: hello.data.channel_type, addressed: (hello.data.payload as { addressed: boolean }).addressed })}`);
const dmRoomId = String(hello.data.room_id);
const rooms = await agent.op<{ room_id: string; name: string }[]>("list_rooms", {});
say(`[b] list_rooms entry: ${JSON.stringify(rooms.find((room) => room.room_id === dmRoomId))}`);
say(`[b] ${await membersOf(dmChannel, "sam")}`);
await cardInRoom("b", dmRoomId, dmChannel, "sam", agent);
const dmPost = await agent.sendMessage(dmRoomId, "Needs your response (1) · A1 CLR-S7 refund ₹40,000");
const dmThreaded = await agent.op<{ event_id: string }>(
  "post_message",
  { body: "threaded under the inbox line", thread_id: dmPost.eventId },
  { roomId: dmRoomId },
);
say(`[b] POST /message ${JSON.stringify(dmPost)}, post_message in a thread ${JSON.stringify(dmThreaded)}`);
await sleep(800);
say(`[b] latest: ${JSON.stringify((await sam.posts(dmChannel)).slice(0, 2).map((post) => ({ message: post.message, threaded: post.root_id !== "" })))}`);

// c) A private channel with one person in it.
const privateRoom = await agent.op<{ id: string }>("create_room", {
  name: `spike-clearance-neha-${stamp}`,
  description: "Clearance and Neha",
  agent_names: ["clearance"],
  user_names: ["neha"],
  channel_type: "channel_private",
});
await agent.op("list_participants", {}, { roomId: privateRoom.id });
const { external_channel_id: privateChannel } = await agent.op<{ external_channel_id: string }>("get_room_detail", {
  room_id: privateRoom.id,
});
say(`[c] ${await membersOf(privateChannel, "neha")}`);
await cardInRoom("c", privateRoom.id, privateChannel, "neha", agent);

// ── S8 ──────────────────────────────────────────────────────────────────────
const docRoom = await agent.op<{ id: string }>("create_room", {
  name: `spike-s8-${stamp}`,
  description: "spike S8",
  agent_names: ["clearance"],
  user_names: ["sam"],
  channel_type: "channel_private",
});
await agent.op("list_participants", {}, { roomId: docRoom.id });
const { external_channel_id: docChannel } = await agent.op<{ external_channel_id: string }>("get_room_detail", {
  room_id: docRoom.id,
});
const docName = `clearance-ledger-${new Date(stamp).toISOString().slice(0, 10)}`;
let at = Date.now();
const created = await agent.op<{ document_id: string }>(
  "create_room_document",
  {
    name: docName,
    description: "Today's Clearance ledger",
    instructions: "Read only. Clearance appends here.",
    content: "# Ledger\nCLR-0001 held\n",
  },
  { roomId: docRoom.id },
);
say(`[s8] create_room_document (${Date.now() - at} ms): ${JSON.stringify(created)}`);
at = Date.now();
const updated = await agent.op<Record<string, unknown>>(
  "update_room_document",
  { document_id: created.document_id, content: "# Ledger\nCLR-0001 held\nCLR-0001 approved\n" },
  { roomId: docRoom.id },
);
say(`[s8] update_room_document (${Date.now() - at} ms): ${JSON.stringify(updated)}`);
const loaded = await agent.op<{ id: string; name: string; content: string }[]>(
  "load_internal_documents",
  { ids: [created.document_id] },
  { roomId: docRoom.id },
);
say(`[s8] read back: ${JSON.stringify(loaded)}`);
const connected = await agent.op<{ documents: unknown[] }>(
  "connect_to_room",
  { room_id: docRoom.id, include_general_instructions: false },
  { roomId: docRoom.id },
);
say(`[s8] connect_to_room documents: ${JSON.stringify(connected.documents)}`);
const dup = await agent
  .op("create_room_document", { name: docName, description: "dup", instructions: "dup", content: "dup" }, { roomId: docRoom.id })
  .then(
    (result) => `made another: ${JSON.stringify(result)}`,
    (error: Error) => `refused: ${error.message}`,
  );
say(`[s8] second create of the same name: ${dup}`);
// What a person sees for !list-documents is in s8-list-documents.ts.
void docChannel;

// The direct room stays: it is the one setup-identities.ts records for Sam.
for (const id of [privateRoom.id, docRoom.id]) await agent.op("archive_room", { room_id: id });
await agent.stop();

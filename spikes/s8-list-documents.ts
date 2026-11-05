/** S8, the human half: what does a person actually get back from !list-documents? */
import { BRIDGE_URL, clearanceAgent, mattermost, say, sleep } from "./lib.js";

const agent = clearanceAgent();
await agent.start();
const stamp = Date.now();
const room = await agent.op<{ id: string }>("create_room", {
  name: `spike-s8b-${stamp}`,
  description: "spike S8",
  agent_names: ["clearance"],
  user_names: ["sam"],
  channel_type: "channel_private",
});
await agent.op("list_participants", {}, { roomId: room.id });
const { external_channel_id: channel } = await agent.op<{ external_channel_id: string }>("get_room_detail", { room_id: room.id });
await agent.op(
  "create_room_document",
  { name: `clearance-ledger-${stamp}`, description: "Today's ledger", instructions: "Read only.", content: "# Ledger\n" },
  { roomId: room.id },
);
const sam = mattermost("sam");
await sleep(1000);
await sam.post(channel, "!list-documents");
await sleep(5000);
for (const post of (await sam.posts(channel)).slice(0, 5).reverse()) {
  say(JSON.stringify({ threaded: post.root_id !== "", type: post.type, message: post.message.slice(0, 400) }));
}
// The command crashes in the pinned Switch (see RESULTS). What a person can see instead: the room's own
// notice above, and the Gateway's page for the room.
const login = await fetch(`${BRIDGE_URL}/gateway/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "sam@clearance.example", password: process.env.PERSONA_PASSWORD }),
});
const cookie = login.headers.getSetCookie()[0]!.split(";")[0]!;
const listed = await fetch(`${BRIDGE_URL}/gateway/rooms/${room.id}/documents`, { headers: { cookie } });
say(`Gateway, signed in as sam: HTTP ${listed.status} ${(await listed.text()).slice(0, 400)}`);
await agent.op("archive_room", { room_id: room.id });
await agent.stop();

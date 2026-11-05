/**
 * With signup closed: do the personas still work, did Switch's bridge come back, and does a card still
 * work end to end? Uses Sam's direct room with Clearance. Prints no credential.
 */
import { randomUUID } from "node:crypto";
import { createChatPort } from "../packages/switch-agent/src/chat-port.js";
import { Frames, clearanceAgent, identities, mattermost, say, secrets, waitFor } from "./lib.js";

for (const name of ["priya", "sam", "neha", "alex"]) {
  const me = await mattermost(name).call("GET", "/users/me");
  say(`${name}'s token: HTTP ${me.status} ${me.body.username === name ? "is " + name : "WRONG USER"}`);
}
say(`tokens for ${Object.keys(secrets.mattermostTokens).length} accounts on file`);

const agent = clearanceAgent();
const frames = new Frames();
await agent.start({ frame: frames.handler });
const chat = createChatPort(agent);
const roomId = identities.people.sam!.directRoomId!;
const { external_channel_id: channelId } = await agent.op<{ external_channel_id: string }>("get_room_detail", { room_id: roomId });
const sam = mattermost("sam");

const title = `CHECK-AFTER-OVERRIDE-${Date.now()}`;
const requestId = `check-${randomUUID()}`;
await chat.openCard({
  roomId,
  requestId,
  kind: "approval",
  title,
  detail: "Checking the card path after Mattermost restarted.",
  options: [
    { id: "allow", label: "Allow", decision: "accept" },
    { id: "deny", label: "Deny", decision: "decline" },
  ],
  questions: [],
});
const card = await waitFor("the card", async () => (await sam.posts(channelId)).find((post) => post.message.includes(title)));
const buttons = card.props.attachments?.[0]?.actions ?? [];
say(`card drew ${buttons.length} buttons`);
const press = await sam.press(card.id, buttons[1]!.id);
const outcome = await frames.waitFor("the press", (name, data) => name === "approval_outcome" && data.request_id === requestId);
say(`press: HTTP ${press.status}, answer ${String(outcome.data.answer)}, answered by Sam: ${outcome.data.answered_by === identities.people.sam!.participantIds[0]}`);

await sam.post(channelId, "still here");
const message = await frames.waitFor(
  "Sam's message",
  (name, data) => name === "message" && (data.payload as { body: string }).body === "still here",
);
say(`Sam's message reached the stream: addressed=${String((message.data.payload as { addressed: boolean }).addressed)}`);
await agent.stop();

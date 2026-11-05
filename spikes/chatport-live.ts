/** The ChatPort end to end against the live stack, as core will call it. */
import type { ApprovalOutcomeEvent } from "@clearance/contracts";
import { createChatPort, createMattermostHandleResolver } from "../packages/switch-agent/src/chat-port.js";
import { MATTERMOST_URL, clearanceAgent, identities, mattermost, say, secrets, sleep, waitFor } from "./lib.js";

const agent = clearanceAgent();
const outcomes: ApprovalOutcomeEvent[] = [];
await agent.start({ approvalOutcome: (event) => void outcomes.push(event) });

const participantNames = Object.fromEntries(
  Object.entries(identities.people).map(([name, person]) => [person.participantIds[0]!, name]),
);
const chat = createChatPort(agent, {
  participantNames,
  resolveHandle: createMattermostHandleResolver({
    agent,
    mattermostUrl: MATTERMOST_URL,
    token: secrets.mattermostTokens.user!,
  }),
});

const options = [
  { id: "allow", label: "Allow" },
  { id: "deny", label: "Deny" },
];

// A direct room the persona opened during setup.
const { roomId: dmRoom } = await chat.ensureDirectRoom({ userName: "sam" });
say(`ensureDirectRoom(sam): ${dmRoom === identities.people.sam!.directRoomId ? "the room setup recorded" : `different: ${dmRoom}`}`);
const again = await chat.ensureDirectRoom({ userName: "sam" });
say(`second call: same room ${again.roomId === dmRoom}`);

const stamp = Date.now();
const dmTitle = `CLR-DM${stamp} · REFUND ₹40,000 to meera.k@okaxis · HIGH`;
const started = Date.now();
const dmCard = await chat.openCard({ roomId: dmRoom, kind: "approval", title: dmTitle, detail: "Multi-line\ndetail", options, questions: [] });
say(`openCard in the DM (${Date.now() - started} ms): ${JSON.stringify(dmCard)}`);
const sam = mattermost("sam");
const { external_channel_id: dmChannel } = await agent.op<{ external_channel_id: string }>("get_room_detail", { room_id: dmRoom });
const dmPost = await waitFor("the DM card", async () => (await sam.posts(dmChannel)).find((post) => post.message.includes(dmTitle.slice(0, 20))));
say(`the DM card's own handle: ${/request `(A\d+)`/.exec(dmPost.message)?.[1]}`);
await sam.press(dmPost.id, dmPost.props.attachments![0]!.actions![1]!.id);
const dmOutcome = await waitFor("the DM outcome", () => outcomes.find((event) => event.switchRequestId === dmCard.switchRequestId));
say(`outcome: ${JSON.stringify(dmOutcome)}`);

// A shared room, where the reader token can read the card back.
const room = await agent.op<{ id: string }>("create_room", {
  name: `spike-port-${stamp}`,
  description: "spike ChatPort",
  agent_names: ["clearance"],
  user_names: ["sam", "neha", "priya"],
  channel_type: "channel_private",
});
await agent.op("list_participants", {}, { roomId: room.id });
const { external_channel_id: channelId } = await agent.op<{ external_channel_id: string }>("get_room_detail", { room_id: room.id });
const title = `CLR-RM${stamp} · DEPLOY checkout v2.14.0 · HIGH`;
const card = await chat.openCard({ roomId: room.id, kind: "approval", title, detail: "One line", options, questions: [], expiresAtMs: Date.now() + 60_000 });
say(`openCard in the room: ${JSON.stringify(card)}`);
await mattermost("neha").post(channelId, `${card.handle} no`);
const outcome = await waitFor("the typed answer", () => outcomes.find((event) => event.switchRequestId === card.switchRequestId));
say(`typed "${card.handle} no": ${JSON.stringify({ answer: outcome.answer, answeredBy: outcome.answeredBy, answeredAtMs: outcome.answeredAtMs })}`);

const closing = await chat.openCard({ roomId: room.id, kind: "approval", title: `CLR-CL${stamp} close me`, detail: "", options, questions: [] });
await chat.closeCard(closing.sessionId, closing.switchRequestId);
say(`closed ${closing.handle}`);

const top = await chat.postMessage({ roomId: room.id, body: "Priya can't approve CLR-0042: she asked for it and owns the agent. Sent to Sam (finance, on duty)." });
say(`postMessage: ${JSON.stringify(top)}`);
const threaded = await chat.postMessage({ roomId: room.id, body: "threaded", threadId: top.messageId });
say(`postMessage in a thread: ${JSON.stringify(threaded)}`);
await chat.sendTargeted({ roomId: room.id, body: "CLR-0042 needs your response.", targets: [identities.people.sam!.participantIds[0]!] });
await chat.sendTargeted({ roomId: room.id, body: "the same, by name", targets: ["neha"], threadId: top.messageId });
await chat.upsertDocument({ roomId: room.id, name: "clearance-state", content: "first\n" });
await chat.upsertDocument({ roomId: room.id, name: "clearance-state", content: "second\n" });
await sam.post(channelId, "!list-documents");
await sleep(1500);
const posts = await sam.posts(channelId);
for (const post of posts.slice(0, 11).reverse()) {
  say(`  ${JSON.stringify({ threaded: post.root_id !== "", message: post.message.slice(0, 170) })}`);
}
const loaded = await agent.op<{ documents: { id: string; name: string }[] }>(
  "connect_to_room",
  { room_id: room.id, include_general_instructions: false },
  { roomId: room.id },
);
const content = await agent.op<{ content: string }[]>("load_internal_documents", { ids: [loaded.documents[0]!.id] }, { roomId: room.id });
say(`document now reads: ${JSON.stringify(content[0]!.content)}`);

await agent.op("archive_room", { room_id: room.id });
await agent.stop();

/**
 * What the in-Switch study rests on, checked on the live stack in p02's room with study-bot:
 *  1. Does a turn with no room name the participant on the card, with no status post and no notice?
 *  2. How long can `detail` be, with that mention and without it, before a card loses its buttons?
 *  3. What does a press on a `questions` card send, and does typed `A5 "38000"` beside an option work?
 *  4. Does opening again with the same request id post a second card?
 * Prints shapes, never credentials. Run `setup-study-accounts.ts --reset p02` afterwards.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createChatPort } from "../packages/switch-agent/src/chat-port.js";
import { createSwitchAgent } from "../packages/switch-agent/src/agent.js";
import { loadStudyAccounts } from "../study/lib/accounts";
import { BRIDGE_URL, DATA_DIR, MATTERMOST_URL, Frames, say, sleep, waitFor } from "./lib.js";

const accounts = loadStudyAccounts(join(DATA_DIR, "study-accounts.json"));
const person = accounts.participants.p02!;
const agent = createSwitchAgent({ bridgeUrl: BRIDGE_URL, agentId: accounts.agent.switchAgentId, apiKey: accounts.agent.apiKey });
const frames = new Frames();
await agent.start({ frame: frames.handler });
const chat = createChatPort(agent);

const login = await fetch(`${MATTERMOST_URL}/api/v4/users/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ login_id: person.mattermostUser, password: person.oneTimePassword }),
});
const token = login.headers.get("token");
if (!login.ok || !token) throw new Error(`p02 could not log in: ${login.status}`);
const mm = async (method: string, path: string, json?: unknown) => {
  const res = await fetch(`${MATTERMOST_URL}/api/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};
type Post = { id: string; message: string; root_id: string; type: string; props: { attachments?: { actions?: { id: string; name: string }[] }[] } };
const posts = async (): Promise<Post[]> => {
  const { body } = await mm("GET", `/channels/${person.channelId}/posts?per_page=100`);
  const { order, posts: all } = body as unknown as { order: string[]; posts: Record<string, Post> };
  return order.map((id) => all[id]!);
};
const cardNamed = (title: string) => waitFor(`card "${title}"`, async () => (await posts()).find((post) => post.message.includes(title)));
const buttons = (post: Post) => post.props.attachments?.flatMap((attachment) => attachment.actions ?? []) ?? [];
const options = [
  { id: "allow", label: "Allow", decision: "accept" as const },
  { id: "deny", label: "Deny", decision: "decline" as const },
];
const stamp = Date.now();
const outcome = (requestId: string) =>
  frames.waitFor(`the outcome of ${requestId}`, (name, data) => name === "approval_outcome" && data.request_id === requestId);

// The participant says something, as they will to begin.
const hello = await mm("POST", "/posts", { channel_id: person.channelId, message: "hello" });
say(`p02 posted: HTTP ${hello.status}`);
const seen = await frames.waitFor("the hello on the stream", (name, data) => name === "message" && data.room_id === person.roomId);
const payload = seen.data.payload as { message_id: string; sender: string; addressed: boolean };
say(`on the stream: sender ok=${payload.sender === person.participantId} addressed=${payload.addressed}`);

// 1. A card with no mention, and one with.
const plainTitle = `PROBE-PLAIN-${stamp}`;
await chat.openCard({ roomId: person.roomId, kind: "approval", title: plainTitle, detail: "x", options, questions: [] });
const plain = await cardNamed(plainTitle);
say(`[1] no mention:   ${JSON.stringify(plain.message)}`);
const namedTitle = `PROBE-NAMED-${stamp}`;
const before = (await posts()).length;
await chat.openCard({ roomId: person.roomId, kind: "approval", title: namedTitle, detail: "x", options, questions: [], mentionMessageId: payload.message_id });
const named = await cardNamed(namedTitle);
await sleep(1500);
const after = await posts();
say(`[1] with mention: ${JSON.stringify(named.message)}`);
say(`[1] posts added by the named card: ${after.length - before} (1 means no status post)`);

// 2. Where the budget really is. Multi-line detail is what Clearance cards have.
const detailOf = (length: number) => {
  const line = "x".repeat(39);
  const lines = Array.from({ length: Math.ceil(length / 40) }, () => line).join("\n");
  return lines.slice(0, length);
};
for (const [label, mention] of [["no mention", undefined], ["with mention", payload.message_id]] as const) {
  for (const length of [960, 966, 967, 970, 990, 998, 999, 1000]) {
    const title = `PROBE-BUDGET-${label.replace(" ", "-")}-${length}-${stamp}`;
    await chat.openCard({ roomId: person.roomId, kind: "approval", title, detail: detailOf(length), options, questions: [], mentionMessageId: mention });
    const post = await cardNamed(title);
    say(`[2] ${label}, detail ${length}: ${buttons(post).length} buttons`);
  }
}

// 3. A questions card with an option and a typed answer allowed.
const questionTitle = `PROBE-QUESTION-${stamp}`;
const question = (requestId: string) => ({
  roomId: person.roomId,
  kind: "questions" as const,
  title: `${questionTitle}-${requestId}`,
  detail: "",
  options: [],
  requestId,
  mentionMessageId: payload.message_id,
  questions: [
    {
      id: "confirm",
      title: "Type the refund amount in rupees to approve, or answer no.",
      prompt: "The evidence goes here.",
      options: [{ id: "no", label: "No" }],
      multiSelect: false,
      allowCustomAnswer: true,
    },
  ],
});
const pressedId = `probe-press-${randomUUID()}`;
await chat.openCard(question(pressedId));
const pressCard = await cardNamed(`${questionTitle}-${pressedId}`);
say(`[3] card: ${JSON.stringify(pressCard.message)} buttons: ${JSON.stringify(buttons(pressCard).map((button) => button.name))}`);
const press = await mm("POST", `/posts/${pressCard.id}/actions/${buttons(pressCard)[0]!.id}`, {});
const pressed = await outcome(pressedId);
say(`[3] press: HTTP ${press.status} answers=${JSON.stringify(pressed.data.answers)} answer=${JSON.stringify(pressed.data.answer)}`);

const typedId = `probe-typed-${randomUUID()}`;
await chat.openCard(question(typedId));
const typedCard = await cardNamed(`${questionTitle}-${typedId}`);
const handle = /request `(A\d+)`/.exec(typedCard.message)![1]!;
await mm("POST", "/posts", { channel_id: person.channelId, message: `${handle} 38000` });
await sleep(1500);
say(`[3] typed "${handle} 38000" with no quotes: answered=${frames.all.some((frame) => frame.name === "approval_outcome" && frame.data.request_id === typedId)}`);
await mm("POST", "/posts", { channel_id: person.channelId, message: `${handle} "38,000"` });
const typed = await outcome(typedId);
say(`[3] typed with quotes: answers=${JSON.stringify(typed.data.answers)}`);
const relayed = frames.all.filter((frame) => frame.name === "message" && (frame.data.payload as { body: string }).body.startsWith(handle));
say(`[3] typed answers on the stream as messages: ${relayed.length}`);

// 4. The same id again, after the card was answered and while it is open.
const openId = `probe-repeat-${randomUUID()}`;
const repeatTitle = `PROBE-REPEAT-${stamp}`;
const repeat = { roomId: person.roomId, kind: "approval" as const, title: repeatTitle, detail: "x", options, questions: [], requestId: openId, mentionMessageId: payload.message_id };
await chat.openCard(repeat);
await cardNamed(repeatTitle);
await chat.openCard(repeat);
await sleep(1200);
say(`[4] cards after opening twice: ${(await posts()).filter((post) => post.message.includes(repeatTitle)).length}`);
const card = await cardNamed(repeatTitle);
await mm("POST", `/posts/${card.id}/actions/${buttons(card)[0]!.id}`, {});
await outcome(openId);
await chat.openCard(repeat);
await sleep(1200);
say(`[4] cards after opening again once answered: ${(await posts()).filter((post) => post.message.includes(repeatTitle)).length}`);

// Close what is still open, so nothing is left to answer.
await agent.stop();

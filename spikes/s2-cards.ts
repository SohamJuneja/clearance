/**
 * S2: native cards. Opens each kind of card in a real room and answers it the way people do: button
 * presses and typed grammar through the Mattermost REST API, with the personas' own tokens.
 * Records the frames it sees as fixtures for the contract tests.
 */
import type { OpenApprovalBody } from "../packages/switch-agent/src/agent.js";
import {
  Frames,
  clearanceAgent,
  identities,
  mattermost,
  say,
  sleep,
  waitFor,
  writeFixture,
  type MattermostPost,
} from "./lib.js";

const agent = clearanceAgent();
const frames = new Frames();
const outcomes: unknown[] = [];
const state = await agent.start({
  frame: frames.handler,
  approvalOutcome: (event) => {
    outcomes.push(event);
  },
});
writeFixture("connection_state", frames.all.find((frame) => frame.name === "connection_state")?.data);
say(`heartbeat_interval_seconds stated by the server: ${state.heartbeat_interval_seconds}`);

const name = `spike-s2-${Date.now()}`;
const room = await agent.op<{ id: string }>("create_room", {
  name,
  description: "spike S2",
  agent_names: ["clearance"],
  user_names: ["sam", "neha", "priya", "guest"],
  channel_type: "channel_private",
});
const detail = await agent.op<{ external_channel_id: string }>("get_room_detail", { room_id: room.id });
const channelId = detail.external_channel_id;
const sessionId = `clr-room-${room.id}`;
const sam = mattermost("sam");
const neha = mattermost("neha");

let counter = 0;
const base = (over: Partial<OpenApprovalBody>): OpenApprovalBody => ({
  session_id: sessionId,
  request_id: `s2-${Date.now()}-${++counter}`,
  turn_id: `s2-turn-${counter}`,
  kind: "approval",
  title: `CLR-S2${counter} refund ₹40,000 to meera.k@okaxis · HIGH`,
  detail: "The call\n  Refund ₹40,000 to Meera K.\n\nFlags\n  ⚠ Amount is 10x the order total",
  options: [
    { id: "allow", label: "Allow", decision: "accept" },
    { id: "deny", label: "Deny", decision: "decline" },
  ],
  questions: [],
  room_id: room.id,
  thread_id: null,
  expires_at: null,
  ...over,
});

async function cardFor(title: string): Promise<MattermostPost> {
  const needle = title.replace(/@/g, "@​");
  return waitFor(`card "${title}"`, async () => {
    const posts = await sam.posts(channelId);
    return posts.find((post) => post.message.includes(needle) && post.message.includes("request `A"));
  });
}

const handleOf = (post: MattermostPost) => /request `(A\d+)`/.exec(post.message)?.[1] ?? "?";

const outcomeFrame = (requestId: string) =>
  frames.waitFor(`outcome of ${requestId}`, (frameName, data) => frameName === "approval_outcome" && data.request_id === requestId);

const results: Record<string, unknown> = {};

// 1. A button press.
{
  const body = base({});
  const opened = await agent.openApproval(body);
  const started = Date.now();
  const post = await cardFor(body.title);
  say(`card visible after ${Date.now() - started} ms, handle ${handleOf(post)}`);
  writeFixture("mattermost_card_post", {
    message: post.message.replaceAll(identities.bridgeId, "<bridge>"),
    props: { attachments: post.props.attachments, from_bot: post.props.from_bot },
  });
  writeFixture("approval_view_open", opened);
  const actions = post.props.attachments?.[0]?.actions ?? [];
  say(`buttons: ${JSON.stringify(actions.map((action) => ({ id: action.id, name: action.name })))}`);
  const pressed = await sam.press(post.id, actions[0]!.id);
  say(`sam pressed ${actions[0]!.name}: HTTP ${pressed.status} ${JSON.stringify(pressed.body).slice(0, 200)}`);
  const frame = await outcomeFrame(body.request_id);
  writeFixture("approval_outcome_answered", frame.data);
  await sleep(600);
  const view = (await agent.undeliveredOutcomes()).find((entry) => entry.requestId === body.request_id);
  results.press = {
    answer: frame.data.answer,
    answered_by: frame.data.answered_by,
    expected_by: identities.people.sam!.participantIds[0],
    still_undelivered_after_ack: view !== undefined,
  };
  const redrawn = (await sam.posts(channelId)).find((entry) => entry.id === post.id);
  say(`card redrawn as: ${JSON.stringify(redrawn?.message.slice(0, 200))}, buttons left: ${redrawn?.props.attachments?.[0]?.actions?.length ?? 0}`);
}

// 2. The typed grammar, with the handle: `A12 no`.
{
  const body = base({});
  await agent.openApproval(body);
  const post = await cardFor(body.title);
  const handle = handleOf(post);
  await neha.post(channelId, `${handle} no`);
  const frame = await outcomeFrame(body.request_id);
  results.typed = { typed: `${handle} no`, answer: frame.data.answer, answered_by: frame.data.answered_by };
}

// 3. A bare word, only as a direct reply to the card.
{
  const body = base({});
  await agent.openApproval(body);
  const post = await cardFor(body.title);
  await sam.post(channelId, "yes", post.id);
  const frame = await outcomeFrame(body.request_id);
  results.bareReply = { answer: frame.data.answer, answered_by: frame.data.answered_by };
}

// 4. A free-text question: the type-to-confirm path.
{
  const body = base({
    kind: "questions",
    options: [],
    detail: null,
    questions: [
      {
        id: "amount",
        title: "Confirm the amount",
        prompt: "Type the refund amount in rupees to approve, or answer no.",
        options: [],
        multi_select: false,
        allow_custom_answer: true,
      },
    ],
  });
  await agent.openApproval(body);
  const post = await cardFor(body.title);
  const handle = handleOf(post);
  say(`questions card: ${JSON.stringify(post.message)}`);
  await sam.post(channelId, `${handle} q1="40000"`);
  const frame = await outcomeFrame(body.request_id);
  writeFixture("approval_outcome_questions", frame.data);
  results.typeToConfirm = { typed: `${handle} q1="40000"`, answers: frame.data.answers, state: frame.data.state };
}

// 5. Expiry: the outcome arrives by itself and carries no answerer.
{
  const body = base({ expires_at: new Date(Date.now() + 4000).toISOString() });
  await agent.openApproval(body);
  const started = Date.now();
  const frame = await frames.waitFor(
    "the expiry",
    (frameName, data) => frameName === "approval_outcome" && data.request_id === body.request_id,
    90_000,
  );
  writeFixture("approval_outcome_expired", frame.data);
  results.expiry = { state: frame.data.state, afterMs: Date.now() - started };
}

// 6. Close: the card stops taking answers, and there is no outcome to acknowledge.
{
  const body = base({});
  await agent.openApproval(body);
  const post = await cardFor(body.title);
  const closed = await agent.closeApproval(sessionId, body.request_id);
  await sleep(1000);
  const action = post.props.attachments?.[0]?.actions?.[0];
  const late = action ? await sam.press(post.id, action.id) : undefined;
  const redrawn = (await sam.posts(channelId)).find((entry) => entry.id === post.id);
  results.close = {
    state: closed.state,
    latePressStatus: late?.status,
    latePress: late?.body && JSON.stringify(late.body).slice(0, 200),
    redrawn: redrawn?.message.slice(0, 120),
  };
}

// 7. An answer given while Clearance is away is waiting for it when it returns.
{
  const body = base({});
  await agent.openApproval(body);
  const post = await cardFor(body.title);
  await agent.stop();
  await sam.press(post.id, post.props.attachments![0]!.actions![0]!.id);
  await sleep(1500);
  const again = clearanceAgent();
  const later = new Frames();
  const seen: unknown[] = [];
  await again.start({ frame: later.handler, approvalOutcome: (event) => void seen.push(event) });
  const frame = await later.waitFor(
    "the outcome after a restart",
    (frameName, data) => frameName === "approval_outcome" && data.request_id === body.request_id,
  );
  results.redelivered = { answer: frame.data.answer, answered_by: frame.data.answered_by };
  await again.stop();
}

say(JSON.stringify(results, null, 2));
say(`handler saw ${outcomes.length} outcomes on the first connection`);

/**
 * S10 from the outside: what a participant's browser does, over the public tunnel URL. Waits for the URL
 * in the file study-expose.sh writes. Uses p03, so run `setup-study-accounts.ts --reset p03` afterwards.
 * Prints shapes and statuses, never a credential.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import { createSwitchAgent } from "../packages/switch-agent/src/agent.js";
import { createChatPort } from "../packages/switch-agent/src/chat-port.js";
import { loadStudyAccounts } from "../study/lib/accounts";
import { BRIDGE_URL, DATA_DIR, Frames, say, sleep, waitFor } from "./lib.js";

const urlFile = process.argv[2]!;
const started = Date.now();
await waitFor("the tunnel URL", () => (existsSync(urlFile) && readFileSync(urlFile, "utf8").trim()) || undefined, 60_000);
const base = readFileSync(urlFile, "utf8").trim();
say(`tunnel ready after ${Math.round((Date.now() - started) / 1000)} s`);

const accounts = loadStudyAccounts(join(DATA_DIR, "study-accounts.json"));
const person = accounts.participants.p03!;

const home = await fetch(`${base}/`);
say(`GET /: HTTP ${home.status} ${home.headers.get("content-type")}`);
const config = (await (await fetch(`${base}/api/v4/config/client?format=old`)).json()) as Record<string, string>;
say(`public config: SiteURL=${config.SiteURL} EnableOpenServer=${config.EnableOpenServer} EnableUserCreation=${config.EnableUserCreation} EnableSignUpWithEmail=${config.EnableSignUpWithEmail} WebsocketURL="${config.WebsocketURL}"`);

const login = await fetch(`${base}/api/v4/users/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
  body: JSON.stringify({ login_id: person.mattermostUser, password: person.oneTimePassword }),
});
say(`p03 logs in with its one-time password: HTTP ${login.status}`);
for (const cookie of login.headers.getSetCookie()) {
  const [pair, ...attributes] = cookie.split("; ");
  say(`  cookie ${pair!.split("=")[0]}: ${attributes.filter((attribute) => !/^(Expires|Max-Age)=/i.test(attribute)).join("; ")}`);
}
const token = login.headers.get("token");
if (!token) throw new Error("no session token");
const mm = async (method: string, path: string, json?: unknown) => {
  const res = await fetch(`${base}/api/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};

/** What the browser does for live updates. A refused upgrade would mean cards only change on reload. */
const upgrade = (origin: string) =>
  new Promise<number>((resolve, reject) => {
    const url = new URL(`${base}/api/v4/websocket`);
    const req = request({
      hostname: url.hostname,
      path: url.pathname,
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"), origin },
    });
    req.on("upgrade", (res, socket) => {
      resolve(res.statusCode ?? 0);
      socket.destroy();
    });
    req.on("response", (res) => {
      resolve(res.statusCode ?? 0);
      res.destroy();
    });
    req.on("error", reject);
    req.end();
  });
say(`websocket from the tunnel's own origin: HTTP ${await upgrade(base)} (101 is live updates working)`);

// A whole card, pressed over the tunnel. The press goes browser, tunnel, Mattermost, Switch.
const agent = createSwitchAgent({ bridgeUrl: BRIDGE_URL, agentId: accounts.agent.switchAgentId, apiKey: accounts.agent.apiKey });
const frames = new Frames();
await agent.start({ frame: frames.handler });
const chat = createChatPort(agent);
const posted = await mm("POST", "/posts", { channel_id: person.channelId, message: "hello from the tunnel" });
say(`p03 posts: HTTP ${posted.status}`);
const seen = await frames.waitFor("the message on the stream", (name, data) => name === "message" && data.room_id === person.roomId);
const messageId = (seen.data.payload as { message_id: string }).message_id;
const requestId = `tunnel-${randomUUID()}`;
const title = `TUNNEL-CHECK-${Date.now()}`;
await chat.openCard({
  roomId: person.roomId,
  requestId,
  mentionMessageId: messageId,
  kind: "approval",
  title,
  detail: "x",
  options: [
    { id: "allow", label: "Allow", decision: "accept" },
    { id: "deny", label: "Deny", decision: "decline" },
  ],
  questions: [],
});
type Post = { id: string; message: string; props: { attachments?: { actions?: { id: string }[] }[] } };
const card = await waitFor("the card over the tunnel", async () => {
  const { body } = await mm("GET", `/channels/${person.channelId}/posts?per_page=30`);
  const { order, posts } = body as unknown as { order: string[]; posts: Record<string, Post> };
  return order.map((id) => posts[id]!).find((post) => post.message.includes(title));
});
const actions = card.props.attachments?.[0]?.actions ?? [];
say(`card over the tunnel: ${actions.length} buttons; links to localhost in it: ${card.message.includes("localhost")}`);
const press = await mm("POST", `/posts/${card.id}/actions/${actions[0]!.id}`, {});
const outcome = await frames.waitFor("the press", (name, data) => name === "approval_outcome" && data.request_id === requestId);
say(`press over the tunnel: HTTP ${press.status}; answered by p03: ${outcome.data.answered_by === person.participantId}`);

const permalink = await mm("GET", `/posts/${card.id}`);
say(`post read back over the tunnel: HTTP ${permalink.status}`);
await mm("POST", "/users/logout");
await agent.stop();
say(`checks took ${Math.round((Date.now() - started) / 1000)} s`);
await sleep(0);

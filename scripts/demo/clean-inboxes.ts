/**
 * Recorded takes only. Each person's direct messages with Clearance and #approvals start empty, so nothing on camera is
 * an earlier take's. A plain run never comes here.
 *
 * Old posts are dumped first. Mattermost can't delete a direct channel, so its posts go, and two things go with them:
 * - Switch's room for that channel, which takes any request still open there with it. Without that, an old open request
 *   with its post gone would be posted again as a new card. The person's hello makes a new room.
 * - Everything each person has unread, so the sidebar doesn't count old takes.
 *
 * Card handles keep counting from earlier takes, because Switch counts them per channel and has no way to clear them.
 * The only way to restart them is a write to Switch's own tables, and a smaller number on screen isn't worth that.
 *
 * #approvals gets what any take's room gets: scripts/demo/fresh-room.ts keeps the old channel, archived.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownerGateway, type OwnerGateway, readDotenv, ROOT, roomLabel } from "../gateway-owner.ts";
import { deleteRoom, freshRoom, type Log } from "./fresh-room.ts";
import { PEOPLE, personaTokens } from "./greet.ts";

const MATTERMOST_URL = (process.env.MATTERMOST_URL ?? "http://127.0.0.1:8065").replace(/\/$/, "");
const CLEARANCE = "clearance";
const APPROVALS = "approvals";
const TEAM = "switch";
const PAGE = 200;
/** How long a person's hello takes to become a room. Measured in seconds, and a card can't wait for it. */
const ROOM_WAIT_MS = 30_000;

type Call = <T = unknown>(method: string, path: string, json?: unknown) => Promise<T>;
type PostList = { order: string[]; posts: Record<string, unknown> };

function caller(token: string, who: string): Call {
  return async <T>(method: string, path: string, json?: unknown): Promise<T> => {
    const res = await fetch(`${MATTERMOST_URL}/api/v4${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    if (!res.ok) throw new Error(`${who}: ${method} ${path} answered ${res.status}`);
    return (await res.json()) as T;
  };
}

async function mattermostAdmin(): Promise<Call> {
  const env = readDotenv(join(ROOT, "vendor/switch/.env"));
  const login = await fetch(`${MATTERMOST_URL}/api/v4/users/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      login_id: env.MATTERMOST_ADMIN_USER,
      password: env.MATTERMOST_ADMIN_PASSWORD,
    }),
  });
  const token = login.headers.get("token");
  if (!token) throw new Error(`Mattermost admin login answered ${login.status}`);
  return caller(token, "Mattermost admin");
}

async function allPosts(call: Call, channelId: string): Promise<PostList> {
  const all: PostList = { order: [], posts: {} };
  for (let page = 0; ; page++) {
    const list = await call<PostList>(
      "GET",
      `/channels/${channelId}/posts?per_page=${PAGE}&page=${page}`,
    );
    all.order.push(...list.order);
    Object.assign(all.posts, list.posts);
    if (list.order.length < PAGE) return all;
  }
}

async function directRooms(
  gateway: OwnerGateway,
  person: string,
): Promise<{ id: string; name: string }[]> {
  const rooms = await gateway.must<{ id: string; name: string }[]>("GET", "/rooms");
  return rooms.filter((room) => roomLabel(room.name) === `${person} / ${CLEARANCE}`);
}

/** Where old posts go. The scratchpad if a run says so, else beside the raw footage, which is gitignored. */
export function dumpDirectory(root: string = ROOT): string {
  return process.env.CLEARANCE_DUMP_DIR ?? join(root, "docs/media/raw/retired-posts");
}

/** Everything before the reset. Throws rather than let a take start on someone's old cards. */
export async function cleanInboxes(
  log: Log = () => undefined,
  dumpDir: string = dumpDirectory(),
): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync(dumpDir, { recursive: true });
  const admin = await mattermostAdmin();
  const adminGateway = await ownerGateway("admin");
  const tokens = personaTokens(ROOT);

  const firstToken = tokens[PEOPLE[1]];
  if (firstToken) {
    const sam = caller(firstToken, PEOPLE[1]);
    const team = await sam<{ id: string }>("GET", `/teams/name/${TEAM}`);
    const channel = await sam<{ id: string }>(
      "GET",
      `/teams/${team.id}/channels/name/${APPROVALS}`,
    );
    writeFileSync(
      join(dumpDir, `${stamp}-${APPROVALS}.json`),
      JSON.stringify(await allPosts(sam, channel.id)),
    );
  }

  for (const person of PEOPLE) {
    const token = tokens[person];
    if (!token)
      throw new Error(`no Mattermost token for ${person}: run scripts/setup-identities.ts`);
    const call = caller(token, person);
    const [me, clearance] = await Promise.all([
      call<{ id: string }>("GET", "/users/me"),
      call<{ id: string }>("GET", `/users/username/${CLEARANCE}`),
    ]);
    const direct = await call<{ id: string }>("POST", "/channels/direct", [me.id, clearance.id]);
    const posts = await allPosts(call, direct.id);
    writeFileSync(join(dumpDir, `${stamp}-dm-${person}.json`), JSON.stringify(posts));
    for (const id of posts.order) {
      // A thread's replies go with their root, so one may already be gone.
      await admin("DELETE", `/posts/${id}`).catch((error: Error) => {
        if (!/answered 404/.test(error.message)) throw error;
      });
    }
    const gateway = await ownerGateway(person);
    for (const room of await directRooms(gateway, person))
      await deleteRoom(room.id, [gateway, adminGateway]);
    log(`${person}: ${posts.order.length} old posts cleared`);
  }
  await freshRoom(APPROVALS, log);
}

/** After the hellos. A card needs the person's direct room, and without one core would make a stand-in. */
export async function waitForDirectRooms(log: Log = () => undefined): Promise<void> {
  const deadline = Date.now() + ROOM_WAIT_MS;
  for (const person of PEOPLE) {
    const gateway = await ownerGateway(person);
    while ((await directRooms(gateway, person)).length === 0) {
      if (Date.now() > deadline)
        throw new Error(`${person}'s hello made no direct room with Clearance`);
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  log("each person has a new direct room with Clearance");
}

/** Last of all, once the rooms and hellos of this take exist, so the sidebar starts with nothing unread. */
export async function markEverythingRead(log: Log = () => undefined): Promise<void> {
  const tokens = personaTokens(ROOT);
  for (const person of PEOPLE) {
    const token = tokens[person];
    if (!token) continue;
    const call = caller(token, person);
    const team = await call<{ id: string }>("GET", `/teams/name/${TEAM}`);
    const channels = await call<{ id: string }[]>("GET", `/users/me/teams/${team.id}/channels`);
    for (const channel of channels) {
      await call("POST", "/channels/members/me/view", { channel_id: channel.id });
    }
    await call("PUT", `/users/me/teams/${team.id}/threads/read`);
  }
  log("everyone's channels and threads marked read");
}

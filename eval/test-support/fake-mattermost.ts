/**
 * An in-memory Mattermost for unit tests: the handful of REST routes the persona driver uses, behind a
 * real HTTP server so the driver's own request, auth and parsing code all run.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeUser = { id: string; username: string; token: string; password?: string };
export type FakeChannel = {
  id: string;
  name: string;
  display_name: string;
  type: string;
  team_id: string;
  members: string[];
};
export type FakePost = {
  id: string;
  channel_id: string;
  user_id: string;
  root_id: string;
  message: string;
  create_at: number;
  update_at: number;
  delete_at: number;
  type: string;
  props: Record<string, unknown>;
};
export type RecordedRequest = {
  method: string;
  path: string;
  authorization?: string;
  body?: unknown;
};
type Failure = { pattern: RegExp; status: number; remaining: number };

function id(): string {
  return randomBytes(13).toString("hex");
}

export class FakeMattermost {
  readonly users = new Map<string, FakeUser>();
  readonly channels = new Map<string, FakeChannel>();
  readonly posts = new Map<string, FakePost>();
  readonly requests: RecordedRequest[] = [];
  readonly presses: { postId: string; actionId: string; userId: string; cookie?: string }[] = [];
  readonly team = { id: "team1", name: "switch", display_name: "Switch" };
  private failures: Failure[] = [];
  private server: Server | undefined;
  private clockMs = 1_700_000_000_000;
  private malformed: RegExp | undefined;
  baseUrl = "";
  /** Runs after a person's post is accepted, so a test can play whoever answers it. */
  onPost: ((post: FakePost, author: FakeUser) => void) | undefined;

  /** A monotonic server clock, so ordering in tests never depends on wall time. */
  now(): number {
    this.clockMs += 10;
    return this.clockMs;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: String(error) }));
      });
    });
    await new Promise<void>((done) => this.server!.listen(0, "127.0.0.1", done));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    await new Promise<void>((done) => {
      this.server?.close(() => done());
      this.server?.closeAllConnections();
    });
  }

  addUser(username: string, password?: string): FakeUser {
    const user: FakeUser = {
      id: `u-${username}`,
      username,
      token: `token-${username}-${id()}`,
      password,
    };
    this.users.set(user.id, user);
    return user;
  }

  addChannel(spec: {
    name: string;
    display_name?: string;
    type?: string;
    members: FakeUser[];
  }): FakeChannel {
    const channel: FakeChannel = {
      id: `c-${spec.name}-${id().slice(0, 6)}`,
      name: spec.name,
      display_name: spec.display_name ?? spec.name,
      type: spec.type ?? "O",
      team_id: spec.type === "D" ? "" : this.team.id,
      members: spec.members.map((user) => user.id),
    };
    this.channels.set(channel.id, channel);
    return channel;
  }

  /** A post from anyone: this is how a test plays an agent or another person. */
  addPost(
    channel: FakeChannel,
    author: FakeUser,
    message: string,
    extra: { root_id?: string; props?: Record<string, unknown> } = {},
  ): FakePost {
    const at = this.now();
    const post: FakePost = {
      id: `p-${id()}`,
      channel_id: channel.id,
      user_id: author.id,
      root_id: extra.root_id ?? "",
      message,
      create_at: at,
      update_at: at,
      delete_at: 0,
      type: "",
      props: extra.props ?? {},
    };
    this.posts.set(post.id, post);
    return post;
  }

  /** Make the next `times` requests whose path matches answer `status`. */
  failNext(pattern: RegExp, status: number, times = 1): void {
    this.failures.push({ pattern, status, remaining: times });
  }

  /** Answer matching requests with a body the driver's schemas must refuse. */
  returnMalformed(pattern: RegExp | undefined): void {
    this.malformed = pattern;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const raw = await readBody(req);
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    this.requests.push({
      method,
      path: `${path}${url.search}`,
      authorization: req.headers.authorization,
      body,
    });

    const send = (status: number, value: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };

    const failure = this.failures.find(
      (candidate) => candidate.remaining > 0 && candidate.pattern.test(path),
    );
    if (failure) {
      failure.remaining -= 1;
      return send(failure.status, { id: "fake.error", message: `injected ${failure.status}` });
    }
    if (this.malformed?.test(path)) return send(200, { nonsense: true });

    if (method === "GET" && path === "/api/v4/system/ping") return send(200, { status: "OK" });
    if (method === "POST" && path === "/api/v4/users/login") {
      const { login_id, password } = body as { login_id: string; password: string };
      const found = [...this.users.values()].find(
        (user) => user.username === login_id && user.password === password,
      );
      if (!found) return send(401, { message: "Invalid login" });
      return send(200, { id: found.id, username: found.username }, { token: found.token });
    }

    const token = req.headers.authorization?.replace(/^Bearer /, "");
    const me = [...this.users.values()].find((user) => user.token === token);
    if (!me)
      return send(401, {
        id: "api.context.session_expired.app_error",
        message: "Invalid or expired session",
      });

    if (method === "GET" && path === "/api/v4/users/me") return send(200, publicUser(me));
    if (method === "GET" && path === "/api/v4/users/me/teams") return send(200, [this.team]);

    let match = path.match(/^\/api\/v4\/users\/me\/teams\/([^/]+)\/channels$/);
    if (method === "GET" && match) {
      return send(
        200,
        [...this.channels.values()].filter(
          (channel) =>
            channel.members.includes(me.id) &&
            (channel.team_id === match![1] || channel.team_id === ""),
        ),
      );
    }

    match = path.match(/^\/api\/v4\/users\/username\/([^/]+)$/);
    if (method === "GET" && match) {
      const user = [...this.users.values()].find((candidate) => candidate.username === match![1]);
      return user ? send(200, publicUser(user)) : send(404, { message: "User not found" });
    }

    match = path.match(/^\/api\/v4\/users\/([^/]+)$/);
    if (method === "GET" && match) {
      const user = this.users.get(match[1] ?? "");
      return user ? send(200, publicUser(user)) : send(404, { message: "User not found" });
    }

    if (method === "POST" && path === "/api/v4/channels/direct") {
      const [a, b] = body as [string, string];
      const existing = [...this.channels.values()].find(
        (channel) =>
          channel.type === "D" && channel.members.includes(a) && channel.members.includes(b),
      );
      if (existing) return send(201, existing);
      const name = [a, b].sort().join("__");
      const channel: FakeChannel = {
        id: `d-${id()}`,
        name,
        display_name: "",
        type: "D",
        team_id: "",
        members: [a, b],
      };
      this.channels.set(channel.id, channel);
      return send(201, channel);
    }

    match = path.match(/^\/api\/v4\/channels\/([^/]+)$/);
    if (method === "GET" && match) {
      const channel = this.channels.get(match[1] ?? "");
      return channel ? send(200, channel) : send(404, { message: "Channel not found" });
    }

    match = path.match(/^\/api\/v4\/channels\/([^/]+)\/posts$/);
    if (method === "GET" && match) {
      const channelId = match[1];
      const since = url.searchParams.get("since");
      const perPage = Number(url.searchParams.get("per_page") ?? 60);
      let posts = [...this.posts.values()].filter((post) => post.channel_id === channelId);
      if (since !== null) {
        posts = posts.filter((post) => post.update_at > Number(since));
      } else {
        posts = posts
          .filter((post) => post.delete_at === 0)
          .sort((a, b) => b.create_at - a.create_at)
          .slice(0, perPage);
      }
      return send(200, postList(posts));
    }

    match = path.match(/^\/api\/v4\/posts\/([^/]+)\/thread$/);
    if (method === "GET" && match) {
      const rootId = match[1] ?? "";
      return send(
        200,
        postList(
          [...this.posts.values()].filter((post) => post.id === rootId || post.root_id === rootId),
        ),
      );
    }

    match = path.match(/^\/api\/v4\/posts\/([^/]+)\/actions\/([^/]+)$/);
    if (method === "POST" && match) {
      const post = this.posts.get(match[1] ?? "");
      if (!post) return send(404, { message: "Post not found" });
      this.presses.push({
        postId: post.id,
        actionId: match[2] ?? "",
        userId: me.id,
        cookie: (body as { cookie?: string } | undefined)?.cookie,
      });
      return send(200, { status: "OK" });
    }

    match = path.match(/^\/api\/v4\/posts\/([^/]+)$/);
    if (method === "GET" && match) {
      const post = this.posts.get(match[1] ?? "");
      return post ? send(200, post) : send(404, { message: "Post not found" });
    }

    if (method === "POST" && path === "/api/v4/posts") {
      const { channel_id, message, root_id } = body as {
        channel_id: string;
        message: string;
        root_id?: string;
      };
      const channel = this.channels.get(channel_id);
      if (!channel) return send(404, { message: "Channel not found" });
      const post = this.addPost(channel, me, message, { root_id });
      send(201, post);
      this.onPost?.(post, me);
      return;
    }

    return send(404, { message: `no fake route for ${method} ${path}` });
  }
}

function publicUser(user: FakeUser): { id: string; username: string; is_bot: boolean } {
  return { id: user.id, username: user.username, is_bot: false };
}

function postList(posts: FakePost[]): { order: string[]; posts: Record<string, FakePost> } {
  return {
    order: posts.map((post) => post.id),
    posts: Object.fromEntries(posts.map((post) => [post.id, post])),
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

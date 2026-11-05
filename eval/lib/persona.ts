/**
 * The persona driver: what a person does in Mattermost, as a typed client over its REST API.
 *
 * Only people's actions go through here. Agents' words are read and waited for, never written, so a
 * scenario can fail on what an agent really said but can never put words in its mouth.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { secretsPath } from "./paths.ts";

const UserSchema = z
  .object({ id: z.string(), username: z.string(), is_bot: z.boolean().optional() })
  .passthrough();
export type MattermostUser = z.infer<typeof UserSchema>;

const TeamSchema = z.object({ id: z.string(), name: z.string() }).passthrough();
export type MattermostTeam = z.infer<typeof TeamSchema>;

const ChannelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    display_name: z.string().default(""),
    type: z.string(),
    team_id: z.string().default(""),
  })
  .passthrough();
export type MattermostChannel = z.infer<typeof ChannelSchema> & { members?: string[] };

const ButtonSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string().optional(),
    cookie: z.string().optional(),
  })
  .passthrough();
export type MattermostButton = z.infer<typeof ButtonSchema>;

const AttachmentSchema = z
  .object({
    title: z.string().optional(),
    text: z.string().optional(),
    fallback: z.string().optional(),
    pretext: z.string().optional(),
    actions: z.array(ButtonSchema).nullable().optional(),
  })
  .passthrough();

const PostSchema = z
  .object({
    id: z.string(),
    channel_id: z.string(),
    user_id: z.string(),
    root_id: z.string().default(""),
    message: z.string().default(""),
    create_at: z.number(),
    update_at: z.number().default(0),
    delete_at: z.number().default(0),
    type: z.string().default(""),
    props: z.record(z.unknown()).nullable().optional(),
  })
  .passthrough();
export type MattermostPost = z.infer<typeof PostSchema>;

const PostListSchema = z.object({
  order: z.array(z.string()).nullable(),
  posts: z.record(PostSchema).nullable(),
});

const SecretsSchema = z.object({ mattermostTokens: z.record(z.string()) }).passthrough();

// ── Errors ───────────────────────────────────────────────────────────────────

/** The server answered, and the answer was a refusal or nonsense. Never carries a credential. */
export class MattermostError extends Error {
  override readonly name = "MattermostError";
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    detail: string,
  ) {
    super(`Mattermost ${method} ${path} answered ${status}: ${detail}`);
  }
  /** Worth waiting out, as opposed to a refusal that will be the same next time. */
  get transient(): boolean {
    return this.status >= 500 || this.status === 429;
  }
}

export class MattermostUnreachableError extends Error {
  override readonly name = "MattermostUnreachableError";
  constructor(baseUrl: string, cause: string) {
    super(`Mattermost not reachable at ${baseUrl}: ${cause}`);
  }
}

export class PersonaCredentialsError extends Error {
  override readonly name = "PersonaCredentialsError";
}

export class ChannelNotFoundError extends Error {
  override readonly name = "ChannelNotFoundError";
  constructor(persona: string, channel: string, visible: string[]) {
    super(
      `${persona} can't see a channel named "${channel}". They can see: ${visible.join(", ") || "nothing"}`,
    );
  }
}

export class AmbiguousChannelError extends Error {
  override readonly name = "AmbiguousChannelError";
  constructor(persona: string, channel: string, matches: string[]) {
    super(
      `"${channel}" matches more than one channel ${persona} can see: ${matches.join(", ")}. Use the exact name.`,
    );
  }
}

export class WaitTimeoutError extends Error {
  override readonly name = "WaitTimeoutError";
  constructor(persona: string, where: string, what: string, timeoutMs: number, seen: string[]) {
    const seenText = seen.length
      ? ` It did see: ${seen.map((text) => `"${text}"`).join("; ")}`
      : " It saw no posts.";
    super(
      `${persona} waited ${(timeoutMs / 1000).toFixed(1)} s in ${where} for ${what}, and it never came.${seenText}`,
    );
  }
}

export class ButtonNotFoundError extends Error {
  override readonly name = "ButtonNotFoundError";
  constructor(postId: string, wanted: string, available: string[]) {
    super(
      `post ${postId} has no button matching ${wanted}. It has: ${available.join(", ") || "no buttons"}`,
    );
  }
}

// ── Reading a post ───────────────────────────────────────────────────────────

function attachmentsOf(post: MattermostPost): z.infer<typeof AttachmentSchema>[] {
  const parsed = z.array(AttachmentSchema).safeParse(post.props?.attachments);
  return parsed.success ? parsed.data : [];
}

export function buttonsOf(post: MattermostPost): MattermostButton[] {
  return attachmentsOf(post).flatMap((attachment) => attachment.actions ?? []);
}

/** Everything a person reads on a post: the message plus any attachment text and button labels. */
export function postText(post: MattermostPost): string {
  const parts = [post.message];
  for (const attachment of attachmentsOf(post)) {
    parts.push(attachment.pretext ?? "", attachment.title ?? "", attachment.text ?? "");
    parts.push(...(attachment.actions ?? []).map((action) => action.name));
  }
  return parts.filter(Boolean).join("\n");
}

export type PostPredicate = (post: MattermostPost) => boolean | Promise<boolean>;

export const textMatches =
  (pattern: RegExp): PostPredicate =>
  (post) =>
    pattern.test(postText(post));

export const inThread =
  (root: MattermostPost | string): PostPredicate =>
  (post) => {
    const rootId = typeof root === "string" ? root : root.root_id || root.id;
    return post.id === rootId || post.root_id === rootId;
  };

export const hasButtons: PostPredicate = (post) => buttonsOf(post).length > 0;

export const allOf =
  (...predicates: PostPredicate[]): PostPredicate =>
  async (post) => {
    for (const predicate of predicates) {
      if (!(await predicate(post))) return false;
    }
    return true;
  };

function summarise(post: MattermostPost): string {
  const flat = postText(post).replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

// ── Credentials ──────────────────────────────────────────────────────────────

/** Reads one persona's token. The error says who is missing and who is present, never a value. */
export function loadPersonaToken(name: string, path: string = secretsPath()): string {
  if (!existsSync(path)) {
    throw new PersonaCredentialsError(
      `${path} doesn't exist, so there is no token for ${name}. Run scripts/setup-identities.ts first.`,
    );
  }
  const parsed = SecretsSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new PersonaCredentialsError(
      `${path} has no mattermostTokens map. Run scripts/setup-identities.ts again.`,
    );
  }
  const token = parsed.data.mattermostTokens[name];
  if (!token) {
    const known = Object.keys(parsed.data.mattermostTokens).join(", ") || "nobody";
    throw new PersonaCredentialsError(
      `${path} has no token for ${name}. It has tokens for: ${known}.`,
    );
  }
  return token;
}

// ── The driver ───────────────────────────────────────────────────────────────

export interface PersonaOptions {
  name: string;
  baseUrl: string;
  /** Called when a request needs it, so a persona can exist before its token does. */
  token: () => string;
  pollMs?: number;
  requestTimeoutMs?: number;
}

export interface WaitOptions {
  timeoutMs: number;
  /** Only look at posts made or edited after this post, and never at the post itself. */
  after?: MattermostPost;
  /** Only look at posts made or edited after this server time. Default: when the wait begins. */
  sinceMs?: number;
  pollMs?: number;
  /** What is being waited for, in words, for the timeout message. */
  description?: string;
}

type Sink = { add(post: MattermostPost): void };

export class Persona {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly tokenSource: () => string;
  private readonly pollMs: number;
  private readonly requestTimeoutMs: number;
  private meCache: MattermostUser | undefined;
  private teamCache: MattermostTeam | undefined;
  private readonly channelCache = new Map<string, MattermostChannel>();
  private readonly usersById = new Map<string, MattermostUser>();
  private readonly usersByName = new Map<string, MattermostUser>();

  constructor(options: PersonaOptions) {
    this.name = options.name;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.tokenSource = options.token;
    this.pollMs = options.pollMs ?? 500;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  /** A persona whose token comes from `data/secrets.json`, read on first use. */
  static fromSecrets(
    name: string,
    options: { baseUrl: string; secretsPath?: string; pollMs?: number; requestTimeoutMs?: number },
  ): Persona {
    return new Persona({
      name,
      baseUrl: options.baseUrl,
      pollMs: options.pollMs,
      requestTimeoutMs: options.requestTimeoutMs,
      token: () => loadPersonaToken(name, options.secretsPath),
    });
  }

  /** Signs in with a password, for accounts with no personal access token. */
  static async login(options: {
    name: string;
    baseUrl: string;
    password: string;
    pollMs?: number;
  }): Promise<Persona> {
    const base = options.baseUrl.replace(/\/$/, "");
    const path = "/users/login";
    let res: Response;
    try {
      res = await fetch(`${base}/api/v4${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ login_id: options.name, password: options.password }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new MattermostUnreachableError(base, describeCause(error));
    }
    if (!res.ok) throw new MattermostError("POST", path, res.status, await serverMessage(res));
    const token = res.headers.get("token");
    if (!token)
      throw new MattermostError("POST", path, res.status, "no session token in the response");
    return new Persona({
      name: options.name,
      baseUrl: base,
      pollMs: options.pollMs,
      token: () => token,
    });
  }

  async me(): Promise<MattermostUser> {
    if (!this.meCache) this.meCache = await this.request("GET", "/users/me", UserSchema);
    return this.meCache;
  }

  /** The persona's team. Every persona is on one, and a Switch deployment has one. */
  async team(): Promise<MattermostTeam> {
    if (!this.teamCache) {
      const teams = await this.request("GET", "/users/me/teams", z.array(TeamSchema));
      const [team] = teams;
      if (!team) throw new ChannelNotFoundError(this.name, "(any team)", []);
      this.teamCache = team;
    }
    return this.teamCache;
  }

  /**
   * A channel by name. `#` is optional. An exact URL name wins; otherwise the display name, because
   * Switch keeps the room's name there and suffixes the URL name when the slug is taken. Two channels
   * sharing a display name is an error: posting to the wrong room would be worse.
   */
  async channel(name: string): Promise<MattermostChannel> {
    const wanted = name.replace(/^#/, "");
    const cached = this.channelCache.get(wanted);
    if (cached) return cached;
    const all = await this.visibleChannels();
    const exact = all.find((channel) => channel.name === wanted);
    const byDisplay = all.filter(
      (channel) => channel.display_name.toLowerCase() === wanted.toLowerCase(),
    );
    if (!exact && byDisplay.length > 1) {
      throw new AmbiguousChannelError(
        this.name,
        wanted,
        byDisplay.map((channel) => channel.name),
      );
    }
    const found = exact ?? byDisplay[0];
    if (!found) {
      throw new ChannelNotFoundError(
        this.name,
        wanted,
        all
          .filter((channel) => channel.type === "O" || channel.type === "P")
          .map((channel) => channel.name),
      );
    }
    this.channelCache.set(wanted, found);
    return found;
  }

  private async visibleChannels(): Promise<MattermostChannel[]> {
    const team = await this.team();
    return this.request("GET", `/users/me/teams/${team.id}/channels`, z.array(ChannelSchema));
  }

  private async channelId(channel: string | MattermostChannel): Promise<string> {
    return typeof channel === "string" ? (await this.channel(channel)).id : channel.id;
  }

  /** A channel by its id, for moving from a post to the channel it lives in. */
  async channelById(id: string): Promise<MattermostChannel> {
    const key = `id:${id}`;
    const cached = this.channelCache.get(key);
    if (cached) return cached;
    const channel = await this.request("GET", `/channels/${id}`, ChannelSchema);
    this.channelCache.set(key, channel);
    return channel;
  }

  async post(channel: string | MattermostChannel, message: string): Promise<MattermostPost> {
    const channel_id = await this.channelId(channel);
    return this.request("POST", "/posts", PostSchema, { channel_id, message });
  }

  /** Replies in a post's thread. Threads are one level deep, so a reply to a reply goes under the root. */
  async reply(to: MattermostPost, message: string): Promise<MattermostPost> {
    return this.request("POST", "/posts", PostSchema, {
      channel_id: to.channel_id,
      message,
      root_id: to.root_id || to.id,
    });
  }

  async getPost(id: string): Promise<MattermostPost> {
    return this.request("GET", `/posts/${id}`, PostSchema);
  }

  /** The newest `limit` live posts, oldest first. */
  async recent(
    channel: string | MattermostChannel,
    options: { limit?: number } = {},
  ): Promise<MattermostPost[]> {
    const id = await this.channelId(channel);
    const list = await this.request(
      "GET",
      `/channels/${id}/posts?per_page=${options.limit ?? 30}`,
      PostListSchema,
    );
    return oldestFirst(list).filter((post) => post.delete_at === 0);
  }

  /** A whole thread, oldest first. */
  async thread(root: MattermostPost | string): Promise<MattermostPost[]> {
    const id = typeof root === "string" ? root : root.root_id || root.id;
    const list = await this.request("GET", `/posts/${id}/thread`, PostListSchema);
    return oldestFirst(list).filter((post) => post.delete_at === 0);
  }

  /** Waits for a live post in a channel that satisfies the predicate, or throws `WaitTimeoutError`. */
  async waitForPost(
    channel: string | MattermostChannel,
    predicate: PostPredicate,
    options: WaitOptions,
  ): Promise<MattermostPost> {
    const label = typeof channel === "string" ? channel.replace(/^#/, "") : channel.name;
    return this.waitAcross(
      () => this.channelId(channel).then((id) => [id]),
      label,
      predicate,
      options,
    );
  }

  /**
   * Waits for a direct message. With `from`, only the DM with that account counts; without it, any DM
   * counts, including one opened during the wait, for when it doesn't matter which account carries it.
   */
  async waitForDm(
    predicate: PostPredicate,
    options: WaitOptions & { from?: string },
  ): Promise<MattermostPost> {
    const label = options.from ? `the DM with ${options.from}` : "their DMs";
    const channels = options.from
      ? async () => [(await this.dm(options.from as string)).id]
      : async () =>
          (await this.visibleChannels())
            .filter((channel) => channel.type === "D")
            .map((channel) => channel.id);
    return this.waitAcross(channels, label, predicate, options);
  }

  private async waitAcross(
    channels: () => Promise<string[]>,
    where: string,
    predicate: PostPredicate,
    options: WaitOptions,
  ): Promise<MattermostPost> {
    const started = Date.now();
    const deadline = started + options.timeoutMs;
    // The server's `since` is strict, so step back a millisecond to keep a post made in the same one.
    const since = options.after ? options.after.create_at - 1 : (options.sinceMs ?? started);
    const pollMs = options.pollMs ?? this.pollMs;
    const seen = new Map<string, MattermostPost>();
    const sink: Sink = { add: (post) => seen.set(post.id, post) };
    let lastTransient: Error | undefined;

    for (;;) {
      try {
        const found = await this.scan(await channels(), since, options.after?.id, predicate, sink);
        if (found) return found;
        lastTransient = undefined;
      } catch (error) {
        if (!isTransient(error)) throw error;
        lastTransient = error as Error;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const recent = [...seen.values()].slice(-5).map(summarise);
        if (lastTransient) recent.push(`(last poll failed: ${lastTransient.message})`);
        throw new WaitTimeoutError(
          this.name,
          where,
          options.description ?? "a matching post",
          options.timeoutMs,
          recent,
        );
      }
      await delay(Math.min(pollMs, remaining));
    }
  }

  private async scan(
    channelIds: string[],
    since: number,
    excludeId: string | undefined,
    predicate: PostPredicate,
    sink: Sink,
  ): Promise<MattermostPost | undefined> {
    for (const id of channelIds) {
      const list = await this.request(
        "GET",
        `/channels/${id}/posts?since=${since}`,
        PostListSchema,
      );
      for (const post of oldestFirst(list)) {
        if (post.delete_at !== 0 || post.id === excludeId) continue;
        sink.add(post);
        if (await predicate(post)) return post;
      }
    }
    return undefined;
  }

  /**
   * Presses a card's button, as this persona. Takes the post's current state from the server first,
   * because a card changes as it is answered.
   */
  async pressButton(post: MattermostPost | string, button: string | RegExp): Promise<void> {
    const id = typeof post === "string" ? post : post.id;
    const live = await this.getPost(id);
    const buttons = buttonsOf(live);
    const wanted = (candidate: MattermostButton): boolean =>
      typeof button === "string"
        ? candidate.name === button || candidate.id === button
        : button.test(candidate.name);
    const found = buttons.find(wanted);
    if (!found) {
      throw new ButtonNotFoundError(
        id,
        String(button),
        buttons.map((candidate) => candidate.name),
      );
    }
    const body = found.cookie ? { cookie: found.cookie } : {};
    await this.request("POST", `/posts/${id}/actions/${found.id}`, z.unknown(), body);
  }

  async user(username: string): Promise<MattermostUser> {
    const cached = this.usersByName.get(username);
    if (cached) return cached;
    const user = await this.request(
      "GET",
      `/users/username/${encodeURIComponent(username)}`,
      UserSchema,
    );
    this.remember(user);
    return user;
  }

  /** The username of the account behind a post. */
  async authorName(post: MattermostPost): Promise<string> {
    const cached = this.usersById.get(post.user_id);
    if (cached) return cached.username;
    const user = await this.request("GET", `/users/${post.user_id}`, UserSchema);
    this.remember(user);
    return user.username;
  }

  fromAuthor(username: string): PostPredicate {
    return async (post) => (await this.authorName(post)) === username;
  }

  private remember(user: MattermostUser): void {
    this.usersById.set(user.id, user);
    this.usersByName.set(user.username, user);
  }

  /**
   * The direct channel with an account. Opening a DM that doesn't exist yet is what the web client does
   * on first click too, and this is the only thing here that can create anything on the server.
   */
  async dm(username: string): Promise<MattermostChannel> {
    const key = `dm:${username}`;
    const cached = this.channelCache.get(key);
    if (cached) return cached;
    const [me, other] = await Promise.all([this.me(), this.user(username)]);
    const channel = await this.request("POST", "/channels/direct", ChannelSchema, [
      me.id,
      other.id,
    ]);
    this.channelCache.set(key, channel);
    return channel;
  }

  async postDm(username: string, message: string): Promise<MattermostPost> {
    return this.post(await this.dm(username), message);
  }

  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    body?: unknown,
  ): Promise<T> {
    const token = this.tokenSource();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v4${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw new MattermostUnreachableError(this.baseUrl, describeCause(error));
    }
    if (!res.ok) throw new MattermostError(method, path, res.status, await serverMessage(res));
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new MattermostError(method, path, res.status, "the response was not JSON");
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new MattermostError(
        method,
        path,
        res.status,
        `unexpected shape at ${issue?.path.join(".")}: ${issue?.message}`,
      );
    }
    return parsed.data;
  }
}

function oldestFirst(list: z.infer<typeof PostListSchema>): MattermostPost[] {
  return Object.values(list.posts ?? {}).sort((a, b) => a.create_at - b.create_at);
}

function isTransient(error: unknown): boolean {
  if (error instanceof MattermostUnreachableError) return true;
  return error instanceof MattermostError && error.transient;
}

function describeCause(error: unknown): string {
  const cause = (error as { cause?: { code?: string } }).cause;
  return cause?.code ?? (error as Error).message;
}

async function serverMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.slice(0, 200) || "no detail";
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

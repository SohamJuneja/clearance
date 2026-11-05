/**
 * A person in a scene. Reading always goes through the REST API. Acting goes through the persona's
 * browser window when a capture is running, so the video shows real typing and real clicks, and through
 * the REST API otherwise. Either way only people's actions are scripted here.
 */
import {
  allOf,
  type MattermostChannel,
  type MattermostPost,
  Persona,
  type PostPredicate,
  type WaitOptions,
} from "../../eval/lib/persona.ts";

/** What a capture's browser window can do for a person. Implemented in scripts/video/capture.ts. */
export interface PersonaWindow {
  openChannel(channelName: string): Promise<void>;
  postInOpenChannel(message: string): Promise<void>;
  replyInThread(post: MattermostPost, message: string): Promise<void>;
  clickButton(post: MattermostPost, button: string | RegExp): Promise<void>;
}

export class Person {
  constructor(
    readonly api: Persona,
    private readonly window?: PersonaWindow,
  ) {}

  get name(): string {
    return this.api.name;
  }

  /** Posts in a channel, by its name or by the channel itself. */
  async say(channel: string | MattermostChannel, message: string): Promise<MattermostPost> {
    if (!this.window) return this.api.post(channel, message);
    const resolved = typeof channel === "string" ? await this.api.channel(channel) : channel;
    const started = Date.now();
    await this.window.openChannel(resolved.name);
    await this.window.postInOpenChannel(message);
    return this.ownPost(resolved, message, started);
  }

  /** Posts in the channel a post lives in. Used to answer a card with the Switch grammar. */
  async sayBeside(post: MattermostPost, message: string): Promise<MattermostPost> {
    return this.say(await this.api.channelById(post.channel_id), message);
  }

  async reply(to: MattermostPost, message: string): Promise<MattermostPost> {
    if (!this.window) return this.api.reply(to, message);
    const channel = await this.api.channelById(to.channel_id);
    const started = Date.now();
    await this.window.openChannel(channel.name);
    await this.window.replyInThread(to, message);
    return this.ownPost(channel, message, started);
  }

  async press(post: MattermostPost, button: string | RegExp): Promise<void> {
    if (!this.window) return this.api.pressButton(post, button);
    const channel = await this.api.channelById(post.channel_id);
    await this.window.openChannel(channel.name);
    await this.window.clickButton(post, button);
  }

  /** Points this person's window at a channel or a post's channel. Does nothing without a window. */
  async look(target: string | MattermostPost): Promise<void> {
    if (!this.window) return;
    const channel =
      typeof target === "string"
        ? await this.api.channel(target)
        : await this.api.channelById(target.channel_id);
    await this.window.openChannel(channel.name);
  }

  waitForPost(
    channel: string | MattermostChannel,
    predicate: PostPredicate,
    options: WaitOptions,
  ): Promise<MattermostPost> {
    return this.api.waitForPost(channel, predicate, options);
  }

  waitForDm(
    predicate: PostPredicate,
    options: WaitOptions & { from?: string },
  ): Promise<MattermostPost> {
    return this.api.waitForDm(predicate, options);
  }

  private async ownPost(
    channel: MattermostChannel,
    message: string,
    startedMs: number,
  ): Promise<MattermostPost> {
    const me = await this.api.me();
    return this.api.waitForPost(
      channel,
      allOf(
        (post) => post.user_id === me.id,
        (post) => post.message.trim() === message.trim(),
      ),
      {
        sinceMs: startedMs - 2_000,
        timeoutMs: 15_000,
        description: `${this.name}'s own message to appear`,
      },
    );
  }
}

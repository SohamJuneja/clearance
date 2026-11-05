import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeMattermost, type FakeUser } from "../test-support/fake-mattermost.ts";
import {
  AmbiguousChannelError,
  buttonsOf,
  ButtonNotFoundError,
  ChannelNotFoundError,
  loadPersonaToken,
  MattermostError,
  MattermostUnreachableError,
  Persona,
  PersonaCredentialsError,
  postText,
  textMatches,
  WaitTimeoutError,
} from "./persona.ts";

describe("Persona", () => {
  let mm: FakeMattermost;
  let priyaUser: FakeUser;
  let samUser: FakeUser;
  let agent: FakeUser;
  let priya: Persona;

  beforeEach(async () => {
    mm = new FakeMattermost();
    await mm.start();
    priyaUser = mm.addUser("priya");
    samUser = mm.addUser("sam");
    agent = mm.addUser("refunds-agent");
    priya = new Persona({
      name: "priya",
      baseUrl: mm.baseUrl,
      token: () => priyaUser.token,
      pollMs: 5,
    });
  });

  afterEach(async () => {
    await mm.stop();
  });

  describe("channels", () => {
    it("posts to a channel it finds by its URL name", async () => {
      const support = mm.addChannel({
        name: "support",
        display_name: "support",
        members: [priyaUser, agent],
      });
      const post = await priya.post("support", "@refunds-agent refund order A-1931");
      expect(post.channel_id).toBe(support.id);
      expect(post.message).toBe("@refunds-agent refund order A-1931");
      expect(post.user_id).toBe(priyaUser.id);
    });

    it("finds a channel Switch suffixed because the slug was taken, by its display name", async () => {
      const support = mm.addChannel({
        name: "support-3fa91c20",
        display_name: "support",
        members: [priyaUser],
      });
      expect((await priya.channel("support")).id).toBe(support.id);
      expect((await priya.channel("#support")).id).toBe(support.id);
    });

    it("prefers an exact name over another channel's display name", async () => {
      mm.addChannel({ name: "something-else", display_name: "support", members: [priyaUser] });
      const exact = mm.addChannel({
        name: "support",
        display_name: "Support desk",
        members: [priyaUser],
      });
      expect((await priya.channel("support")).id).toBe(exact.id);
    });

    it("refuses to guess between two channels with one display name, and names them", async () => {
      mm.addChannel({ name: "support-aaaaaaaa", display_name: "support", members: [priyaUser] });
      mm.addChannel({ name: "support-bbbbbbbb", display_name: "support", members: [priyaUser] });
      const error = await priya.channel("support").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AmbiguousChannelError);
      expect(String(error)).toContain("support-aaaaaaaa");
      expect(String(error)).toContain("support-bbbbbbbb");
    });

    it("says which channels the persona can see when the name is not one of them", async () => {
      mm.addChannel({ name: "town-square", members: [priyaUser] });
      const error = await priya.channel("support").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ChannelNotFoundError);
      expect(String(error)).toContain("priya");
      expect(String(error)).toContain("town-square");
    });

    it("looks a channel up once and then remembers it", async () => {
      mm.addChannel({ name: "support", members: [priyaUser] });
      await priya.channel("support");
      await priya.channel("support");
      const listings = mm.requests.filter((request) => request.path.endsWith("/channels"));
      expect(listings).toHaveLength(1);
    });
  });

  describe("threads", () => {
    it("replies under the root when given the root", async () => {
      const support = mm.addChannel({ name: "support", members: [priyaUser, agent] });
      const root = mm.addPost(support, agent, "waiting for approval CLR-0042");
      const reply = await priya.reply(root, "A12 yes");
      expect(reply.root_id).toBe(root.id);
      expect(reply.channel_id).toBe(support.id);
    });

    it("replies under the root when given a reply, because Mattermost threads are one level deep", async () => {
      const support = mm.addChannel({ name: "support", members: [priyaUser, agent] });
      const root = mm.addPost(support, priyaUser, "@refunds-agent refund it");
      const nested = mm.addPost(support, agent, "HELD CLR-0042", { root_id: root.id });
      const reply = await priya.reply(nested, "A12 yes");
      expect(reply.root_id).toBe(root.id);
    });

    it("reads a thread oldest first", async () => {
      const support = mm.addChannel({ name: "support", members: [priyaUser, agent] });
      const root = mm.addPost(support, priyaUser, "one");
      mm.addPost(support, agent, "two", { root_id: root.id });
      mm.addPost(support, priyaUser, "three", { root_id: root.id });
      mm.addPost(support, priyaUser, "another conversation");
      expect((await priya.thread(root)).map((post) => post.message)).toEqual([
        "one",
        "two",
        "three",
      ]);
    });
  });

  describe("recent posts", () => {
    it("lists the newest posts, oldest first", async () => {
      const support = mm.addChannel({ name: "support", members: [priyaUser, agent] });
      mm.addPost(support, agent, "one");
      mm.addPost(support, agent, "two");
      mm.addPost(support, agent, "three");
      const recent = await priya.recent("support", { limit: 2 });
      expect(recent.map((post) => post.message)).toEqual(["two", "three"]);
    });
  });

  describe("waiting for a post", () => {
    it("resolves on a post that arrives while waiting", async () => {
      const support = mm.addChannel({ name: "support", members: [priyaUser, agent] });
      const prompt = await priya.post("support", "@refunds-agent handle T-77");
      const waiting = priya.waitForPost("support", textMatches(/HELD CLR-\d+/), {
        timeoutMs: 2_000,
        after: prompt,
        description: "the agent reports a hold",
      });
      mm.addPost(support, agent, "checking the ticket");
      mm.addPost(support, agent, "HELD CLR-0042: refunds over ₹10,000 need finance approval", {
        root_id: prompt.id,
      });
      const found = await waiting;
      expect(found.message).toContain("CLR-0042");
    });

    it("does not match the post it was told to wait after", async () => {
      mm.addChannel({ name: "support", members: [priyaUser] });
      const prompt = await priya.post("support", "HELD CLR-0001 (typed by a person)");
      const error = await priya
        .waitForPost("support", textMatches(/HELD/), { timeoutMs: 40, after: prompt })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WaitTimeoutError);
    });

    it("does not match posts from before the wait began", async () => {
      const support = mm.addChannel({ name: "support", members: [priyaUser, agent] });
      mm.addPost(support, agent, "HELD CLR-0001 from an earlier take");
      const marker = mm.now();
      const error = await priya
        .waitForPost("support", textMatches(/HELD/), { timeoutMs: 40, sinceMs: marker })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WaitTimeoutError);
    });

    it("sees a card that was edited after it was posted", async () => {
      const support = mm.addChannel({ name: "support", members: [priyaUser, agent] });
      const card = mm.addPost(support, agent, "A12 allow?");
      const marker = mm.now();
      card.message = "A12 denied by Sam";
      card.update_at = mm.now();
      const found = await priya.waitForPost("support", textMatches(/denied by Sam/), {
        timeoutMs: 500,
        sinceMs: marker,
      });
      expect(found.id).toBe(card.id);
    });

    it("ignores a deleted post", async () => {
      const support = mm.addChannel({ name: "support", members: [priyaUser, agent] });
      const marker = mm.now();
      const gone = mm.addPost(support, agent, "HELD CLR-0042");
      gone.delete_at = mm.now();
      gone.update_at = gone.delete_at;
      const error = await priya
        .waitForPost("support", textMatches(/HELD/), { timeoutMs: 40, sinceMs: marker })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WaitTimeoutError);
    });

    it("fails clearly on timeout: who, where, what, and what it did see", async () => {
      const support = mm.addChannel({ name: "support", members: [priyaUser, agent] });
      const marker = mm.now();
      mm.addPost(support, agent, "I'll have a look at that ticket");
      const error = await priya
        .waitForPost("support", textMatches(/HELD/), {
          timeoutMs: 40,
          sinceMs: marker,
          description: "the agent reports a hold",
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WaitTimeoutError);
      const text = String(error);
      expect(text).toContain("priya");
      expect(text).toContain("support");
      expect(text).toContain("the agent reports a hold");
      expect(text).toContain("I'll have a look at that ticket");
    });

    it("rides out a server hiccup while waiting", async () => {
      const support = mm.addChannel({ name: "support", members: [priyaUser, agent] });
      const marker = mm.now();
      mm.addPost(support, agent, "HELD CLR-0042");
      mm.failNext(/\/posts$/, 503, 2);
      const found = await priya.waitForPost("support", textMatches(/HELD/), {
        timeoutMs: 2_000,
        sinceMs: marker,
      });
      expect(found.message).toBe("HELD CLR-0042");
    });

    it("does not wait out a refused token", async () => {
      const support = mm.addChannel({ name: "support", members: [priyaUser, agent] });
      const channel = await priya.channel("support");
      expect(channel.id).toBe(support.id);
      mm.failNext(/\/posts$/, 401, 100);
      const started = Date.now();
      const error = await priya
        .waitForPost("support", textMatches(/HELD/), { timeoutMs: 5_000 })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MattermostError);
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("awaits an async predicate", async () => {
      const support = mm.addChannel({ name: "support", members: [priyaUser, agent] });
      const marker = mm.now();
      mm.addPost(support, agent, "from the agent");
      const found = await priya.waitForPost(
        "support",
        async (post) => (await priya.authorName(post)) === "refunds-agent",
        { timeoutMs: 500, sinceMs: marker },
      );
      expect(found.message).toBe("from the agent");
    });
  });

  describe("buttons", () => {
    const card = {
      attachments: [
        {
          actions: [
            { id: "allow1", name: "1. Allow once", type: "button", cookie: "c-allow" },
            { id: "deny2", name: "2. Deny", type: "button", cookie: "c-deny" },
          ],
        },
      ],
    };

    it("lists a card's buttons", async () => {
      const support = mm.addChannel({ name: "support", members: [priyaUser, agent] });
      const post = mm.addPost(support, agent, "May I?", { props: card });
      const [fetched] = await priya.recent("support", { limit: 1 });
      expect(fetched?.id).toBe(post.id);
      expect(buttonsOf(fetched!).map((button) => button.name)).toEqual([
        "1. Allow once",
        "2. Deny",
      ]);
    });

    it("presses a button by label, as this persona, with its cookie", async () => {
      const support = mm.addChannel({ name: "support", members: [priyaUser, agent] });
      const post = mm.addPost(support, agent, "May I?", { props: card });
      await priya.pressButton(post, /allow/i);
      expect(mm.presses).toEqual([
        { postId: post.id, actionId: "allow1", userId: priyaUser.id, cookie: "c-allow" },
      ]);
    });

    it("reads the live post before pressing, since a card changes as it is answered", async () => {
      const support = mm.addChannel({ name: "support", members: [priyaUser, agent] });
      const post = mm.addPost(support, agent, "May I?");
      post.props = card;
      await priya.pressButton(post.id, "2. Deny");
      expect(mm.presses[0]?.actionId).toBe("deny2");
    });

    it("names the buttons that do exist when the one asked for does not", async () => {
      const support = mm.addChannel({ name: "support", members: [priyaUser, agent] });
      const post = mm.addPost(support, agent, "May I?", { props: card });
      const error = await priya.pressButton(post, /approve/).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ButtonNotFoundError);
      expect(String(error)).toContain("1. Allow once");
      expect(String(error)).toContain("2. Deny");
    });

    it("includes attachment text in what a predicate can match", async () => {
      const support = mm.addChannel({ name: "support", members: [priyaUser, agent] });
      mm.addPost(support, agent, "", {
        props: {
          attachments: [
            { title: "CLR-0042 · REFUND ₹40,000", text: "Amount is 10x the order total" },
          ],
        },
      });
      const [post] = await priya.recent("support", { limit: 1 });
      expect(postText(post!)).toContain("CLR-0042 · REFUND ₹40,000");
      expect(postText(post!)).toContain("10x the order total");
    });
  });

  describe("direct messages", () => {
    it("finds the DM with a person by username, and reuses it", async () => {
      const first = await priya.dm("sam");
      const second = await priya.dm("sam");
      expect(first.type).toBe("D");
      expect(second.id).toBe(first.id);
      expect(
        mm.requests.filter((request) => request.path === "/api/v4/channels/direct"),
      ).toHaveLength(1);
      expect(first.members ?? [priyaUser.id, samUser.id]).toContain(priyaUser.id);
    });

    it("posts a direct message", async () => {
      const post = await priya.postDm("sam", "are you on duty?");
      expect(post.message).toBe("are you on duty?");
      expect(mm.channels.get(post.channel_id)?.type).toBe("D");
    });

    it("waits for a DM from a named sender", async () => {
      const dm = await priya.dm("refunds-agent");
      const marker = mm.now();
      mm.addPost(mm.channels.get(dm.id)!, agent, "CLR-0042 card");
      const found = await priya.waitForDm(textMatches(/CLR-0042/), {
        from: "refunds-agent",
        timeoutMs: 500,
        sinceMs: marker,
      });
      expect(found.message).toBe("CLR-0042 card");
    });

    it("waits across every DM when the sender does not matter, including one opened during the wait", async () => {
      const clearance = mm.addUser("clearance");
      const marker = mm.now();
      const waiting = priya.waitForDm(textMatches(/Needs your response/), {
        timeoutMs: 2_000,
        sinceMs: marker,
      });
      const channel = mm.addChannel({
        name: "d-clearance",
        type: "D",
        members: [priyaUser, clearance],
      });
      mm.addPost(channel, clearance, "Needs your response (2)");
      expect((await waiting).message).toBe("Needs your response (2)");
    });

    it("reports a timeout for a DM wait with the persona in the message", async () => {
      const error = await priya
        .waitForDm(textMatches(/never/), { timeoutMs: 30, description: "a card from Clearance" })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WaitTimeoutError);
      expect(String(error)).toContain("priya");
      expect(String(error)).toContain("a card from Clearance");
    });
  });

  describe("authors", () => {
    it("names the account behind a post and asks the server once per account", async () => {
      const support = mm.addChannel({ name: "support", members: [priyaUser, agent] });
      const one = mm.addPost(support, agent, "one");
      const two = mm.addPost(support, agent, "two");
      expect(await priya.authorName(one)).toBe("refunds-agent");
      expect(await priya.authorName(two)).toBe("refunds-agent");
      expect(
        mm.requests.filter((request) => request.path === `/api/v4/users/${agent.id}`),
      ).toHaveLength(1);
    });
  });

  describe("failure", () => {
    it("carries status and the server's message, never the token", async () => {
      mm.addChannel({ name: "support", members: [priyaUser] });
      mm.failNext(/\/api\/v4\/posts$/, 403);
      const error = await priya.post("support", "hello").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MattermostError);
      expect((error as MattermostError).status).toBe(403);
      expect(String(error)).toContain("injected 403");
      expect(String(error)).not.toContain(priyaUser.token);
    });

    it("says Mattermost is unreachable when nothing is listening", async () => {
      await mm.stop();
      const error = await priya.me().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MattermostUnreachableError);
      expect(String(error)).toContain(mm.baseUrl);
      await mm.start();
    });

    it("refuses a response of the wrong shape rather than passing it on", async () => {
      mm.returnMalformed(/\/users\/me$/);
      const error = await priya.me().catch((caught: unknown) => caught);
      expect(String(error)).toContain("/users/me");
      expect(error).toBeInstanceOf(MattermostError);
      mm.returnMalformed(undefined);
    });
  });

  describe("login", () => {
    it("exchanges a password for a session token", async () => {
      const user = mm.addUser("user", "correct horse");
      const persona = await Persona.login({
        name: "user",
        baseUrl: mm.baseUrl,
        password: "correct horse",
      });
      expect((await persona.me()).id).toBe(user.id);
    });

    it("does not echo the password when login fails", async () => {
      mm.addUser("user", "correct horse");
      const error = await Persona.login({
        name: "user",
        baseUrl: mm.baseUrl,
        password: "wrong battery",
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MattermostError);
      expect(String(error)).not.toContain("wrong battery");
    });
  });

  describe("credentials from secrets.json", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "persona-secrets-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("reads the token only when a request needs it", async () => {
      const secrets = join(dir, "secrets.json");
      const persona = Persona.fromSecrets("priya", {
        baseUrl: mm.baseUrl,
        secretsPath: secrets,
        pollMs: 5,
      });
      writeFileSync(secrets, JSON.stringify({ mattermostTokens: { priya: priyaUser.token } }));
      expect((await persona.me()).id).toBe(priyaUser.id);
    });

    it("explains a missing file and how to create it", () => {
      expect(() => loadPersonaToken("priya", join(dir, "missing.json"))).toThrow(
        PersonaCredentialsError,
      );
      expect(() => loadPersonaToken("priya", join(dir, "missing.json"))).toThrow(
        /setup-identities/,
      );
    });

    it("names a persona with no token, and lists who has one, without values", () => {
      const secrets = join(dir, "secrets.json");
      writeFileSync(secrets, JSON.stringify({ mattermostTokens: { sam: "s3cret-value" } }));
      let message = "";
      try {
        loadPersonaToken("priya", secrets);
      } catch (caught) {
        message = String(caught);
      }
      expect(message).toContain("priya");
      expect(message).toContain("sam");
      expect(message).not.toContain("s3cret-value");
    });
  });
});

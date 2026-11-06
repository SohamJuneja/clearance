/**
 * The in-Switch study against a fake ChatPort that behaves as the live stack was seen to in
 * spikes/s-study-card-probe.ts: opening a known request id posts nothing new, and an id reused with
 * different content is refused. Every event here is synthetic and goes to a temporary folder.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalOutcomeEvent, ChatMessageEvent, ChatPort, OpenCardInput } from "../../packages/contracts/src/index";
import { roomSessionId } from "../../packages/switch-agent/src/agent";
import { analyse } from "../../eval/study/analysis";
import type { ParticipantAccount } from "../lib/accounts";
import type { StudyEvent } from "../lib/events";
import { CONFIRM_FAILED, CONFIRM_REASK, DEBRIEF_MISSED_INTRO, DEBRIEF_NONE_MISSED, STOPPED_MESSAGE, SWITCH_REPOSTED, SWITCH_WELCOME, TYPE_TO_CONFIRM_HINT } from "../lib/materials";
import type { Sets } from "../lib/protocol";
import { DEFAULT_RESULTS_DIR } from "../lib/results";
import { loadSet } from "../lib/sets";
import { createStudyBot, type StudyBot } from "../bot/bot";
import { labelOf, type LiveCard } from "../bot/cards";
import { debriefMessages } from "../bot/session";
import { createStudyStore, type StudyStore } from "../bot/store";

const sets: Sets = { X: loadSet("X").requests, Y: loadSet("Y").requests, practice: loadSet("practice").requests };
const allRequests = [...sets.practice, ...sets.X, ...sets.Y];

type Posted = { input: OpenCardInput; opens: number; closed: boolean };

class FakeChat implements ChatPort {
  cards = new Map<string, Posted>();
  messages: { roomId: string; body: string }[] = [];
  /** The next open fails before Switch has it, as when the network is down. */
  failOpens = 0;
  failPosts = 0;

  async openCard(input: OpenCardInput) {
    if (!input.requestId) throw new Error("the bot must always name its requests");
    if (this.failOpens > 0) {
      this.failOpens -= 1;
      throw new Error("Switch is unreachable");
    }
    const existing = this.cards.get(input.requestId);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Error("REQUEST_CONFLICT");
      existing.opens += 1;
    } else {
      this.cards.set(input.requestId, { input, opens: 1, closed: false });
    }
    return { sessionId: roomSessionId(input.roomId), switchRequestId: input.requestId };
  }
  async closeCard(_sessionId: string, requestId: string) {
    const card = this.cards.get(requestId);
    if (card) card.closed = true;
  }
  async postMessage(input: { roomId: string; body: string }) {
    if (this.failPosts > 0) {
      this.failPosts -= 1;
      throw new Error("Switch is unreachable");
    }
    this.messages.push({ roomId: input.roomId, body: input.body });
    return { messageId: `sw_${this.messages.length}` };
  }
  async sendTargeted(): Promise<void> {
    throw new Error("the study bot addresses nobody");
  }
  async ensureDirectRoom(): Promise<{ roomId: string }> {
    throw new Error("the study bot uses the rooms it was given");
  }
  async upsertDocument(): Promise<void> {
    throw new Error("the study bot writes no documents");
  }
  latest(): { requestId: string; input: OpenCardInput } {
    const [requestId, card] = [...this.cards.entries()].at(-1)!;
    return { requestId, input: card.input };
  }
  said(body: string): number {
    return this.messages.filter((message) => message.body === body).length;
  }
}

const SOMEONE_ELSE = "@switch-mattermost-b-user:localhost";
const account = (participant: string): ParticipantAccount => ({
  mattermostUser: participant,
  mattermostUserId: `mm-${participant}`,
  switchUserId: `sw-${participant}`,
  externalUserRowId: `row-${participant}`,
  participantId: `@switch-mattermost-b-${participant}:localhost`,
  roomId: `room-${participant}`,
  channelId: `chan-${participant}`,
  oneTimePassword: "not-used-here",
  switchPassword: "not-used-here",
  retired: false,
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class Harness {
  readonly dir = mkdtempSync(join(tmpdir(), "study-bot-"));
  readonly chat = new FakeChat();
  nowMs = Date.parse("2026-11-06T16:00:00.000Z");
  logs: string[] = [];
  bot!: StudyBot;
  store!: StudyStore;
  readonly who: ParticipantAccount;
  private messageCount = 0;

  constructor(readonly participant = "p01") {
    dirs.push(this.dir);
    this.who = account(participant);
    this.restart();
  }

  /** A new process over the same files and the same Switch. */
  restart(): void {
    this.store = createStudyStore({ resultsDir: this.dir, synthetic: true, now: () => new Date(this.nowMs) });
    this.bot = createStudyBot(
      { [this.participant]: this.who },
      {
        chat: this.chat,
        store: this.store,
        sets,
        now: () => new Date(this.nowMs),
        log: (line) => this.logs.push(line),
        runId: "run",
        breakSeconds: 30,
        recentBodies: async () => this.chat.messages.map((message) => message.body),
      },
    );
  }

  events(): StudyEvent[] {
    return this.store.results.read(this.participant);
  }

  audit(): Record<string, unknown>[] {
    const file = join(this.dir, "bot-state", `${this.participant}.audit.ndjson`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  message(body: string, sender = this.who.participantId): ChatMessageEvent {
    this.messageCount += 1;
    return { roomId: this.who.roomId, messageId: `sw_person_${this.messageCount}`, sender, senderName: "x", addressed: false, body, timestampMs: this.nowMs };
  }

  /** Says hello and lets the bot post the first card. */
  async begin(): Promise<void> {
    await this.bot.tick();
    await this.bot.onMessage(this.message("hello"));
  }

  outcome(requestId: string, card: LiveCard, answer: { label?: string; typed?: string }, by = this.who.participantId): ApprovalOutcomeEvent {
    const base = { sessionId: roomSessionId(this.who.roomId), switchRequestId: requestId, state: "answered", answeredBy: by, answeredAtMs: this.nowMs };
    if (card.kind === "approval") {
      const option = card.options.find((entry) => entry.label === answer.label);
      return { ...base, kind: "approval", answer: option!.id, answers: null };
    }
    const question = card.questions[0]!;
    const selected = question.options.filter((entry) => entry.label === answer.label).map((entry) => entry.id);
    return { ...base, kind: "questions", answer: null, answers: [{ question_id: question.id, selected_option_ids: selected, custom_text: answer.typed ?? null }] };
  }

  /** Answers the card that is up. */
  async answer(answer: { label?: string; typed?: string }, by?: string): Promise<void> {
    const { requestId, input } = this.chat.latest();
    await this.bot.onOutcome(this.outcome(requestId, input, answer, by));
  }

  requestOf(requestId: string) {
    const id = /-(?:practice|card)-([XYP]\d{2})-a\d+-r\d+$/.exec(requestId)?.[1];
    return allRequests.find((request) => request.id === id);
  }

  /** The answer someone who approves everything gives to whatever is up. */
  private approving(): { label?: string; typed?: string } {
    const { requestId, input } = this.chat.latest();
    const request = this.requestOf(requestId);
    if (input.kind === "approval") return { label: input.options[0]!.label };
    if (request?.b.confirm) return { typed: request.b.confirm.expected };
    return { label: input.questions[0]!.options[0]!.label };
  }

  /** Answers cards until the one up satisfies `stop`, or the session has nothing more to ask. */
  async driveUntil(stop: (requestId: string) => boolean): Promise<void> {
    for (let guard = 0; guard < 80; guard += 1) {
      const { requestId, input } = this.chat.latest();
      if (stop(requestId)) return;
      if (requestId.includes("-comment-")) {
        await this.answer({ typed: "the second one" });
        return;
      }
      this.nowMs += 1000;
      await this.answer(this.approving());
      void input;
      // The break waits on the clock, and only the tick notices it is over.
      if (this.chat.latest().requestId === requestId) {
        this.nowMs += 30_000;
        await this.bot.tick();
      }
    }
    throw new Error("the session did not reach that point");
  }

  async finish(): Promise<void> {
    await this.driveUntil(() => false);
  }
}

const decisions = (events: StudyEvent[]) => events.filter((event) => event.type === "decision");

describe("starting", () => {
  it("posts only a welcome until the person speaks", async () => {
    const h = new Harness();
    await h.bot.tick();
    await h.bot.tick();
    expect(h.chat.said(SWITCH_WELCOME)).toBe(1);
    expect(h.chat.cards.size).toBe(0);
    expect(h.events()).toEqual([]);
  });

  it("names the person who said hello on every card, which is what keeps the budget and notifies them", async () => {
    const h = new Harness();
    await h.bot.tick();
    const hello = h.message("hello");
    await h.bot.onMessage(hello);
    await h.driveUntil((id) => id.includes("-card-"));
    for (const card of h.chat.cards.values()) expect(card.input.mentionMessageId).toBe(hello.messageId);
  });

  it("records nothing until someone has agreed", async () => {
    const h = new Harness();
    await h.begin();
    expect(h.chat.latest().input.questions[0]!.prompt).toContain("You must be 18 or older");
    expect(h.events()).toEqual([]);
    await h.answer({ label: "I agree." });
    expect(h.events()).toEqual([]);
    await h.answer({ label: "working developer" });
    expect(h.events()).toEqual([]);
    await h.answer({ label: "4" });
    expect(h.events().map((event) => event.type)).toEqual(["session_start", "consent"]);
    expect(h.events()[1]).toMatchObject({ agreed: true, role: "working developer", familiarity: 4 });
  });

  it("ends at once with nothing recorded if they do not agree", async () => {
    const h = new Harness();
    await h.begin();
    await h.answer({ label: "I do not agree" });
    expect(h.events()).toEqual([]);
    expect(h.chat.said(STOPPED_MESSAGE)).toBe(1);
    const cards = h.chat.cards.size;
    await h.bot.tick();
    await h.bot.onMessage(h.message("hello again"));
    expect(h.chat.cards.size).toBe(cards);
    expect(h.chat.said(STOPPED_MESSAGE)).toBe(1);
  });
});

describe("the whole protocol, PLAN 11.6", () => {
  it("runs consent, briefing, practice, both blocks, ratings, comment and debrief, and the analysis reads it", async () => {
    const h = new Harness();
    await h.begin();
    await h.finish();

    const events = h.events();
    const order = events.map((event) => event.type).filter((type) => type !== "decision" && type !== "confirm_wrong");
    expect(order).toEqual(["session_start", "consent", "briefing_read", "practice", "practice", "confidence", "break_done", "confidence", "comment", "session_end"]);
    expect(decisions(events)).toHaveLength(24);

    const report = analyse(events, "2026-11-06T17:00:00.000Z");
    expect(report.synthetic).toBe(true);
    expect(report.headline).toBeNull();
    expect(report.participants).toMatchObject({ started: 1, completed: 1, by_platform: { switch: 1 } });
    expect(report.per_participant[0]).toMatchObject({ participant: "p01", group: 1, platform: "switch" });
  });

  it("says on every record that it came from Switch, and that a dry run is synthetic", async () => {
    const h = new Harness();
    await h.begin();
    await h.finish();
    for (const event of h.events()) {
      expect(event.platform).toBe("switch");
      expect(event.synthetic).toBe(true);
    }
    expect(h.events()[0]).toMatchObject({ type: "session_start", platform: "switch", group: 1, schema: 1 });
  });

  it("shows each flaw they missed in the debrief, and only those", async () => {
    const h = new Harness();
    await h.begin();
    await h.finish();
    const text = h.chat.messages.map((message) => message.body).join("\n");
    expect(text).toContain(DEBRIEF_MISSED_INTRO);
    const shown = [...sets.X, ...sets.Y].filter((request) => request.flaw);
    expect(shown).toHaveLength(8);
    for (const request of shown) expect(text).toContain(request.flaw!.explanation);
  });

  it("uses the counterbalanced order by participant id", async () => {
    const first = new Harness("p01");
    await first.begin();
    await first.driveUntil((id) => id.includes("-card-"));
    expect(first.chat.latest().requestId).toContain("-card-X01-");
    expect(first.chat.latest().input.options.map((option) => option.label)).toEqual(["Allow once", "Allow for this session", "Decline"]);

    const third = new Harness("p03");
    await third.begin();
    await third.driveUntil((id) => id.includes("-card-"));
    expect(third.chat.latest().requestId).toContain("-card-X01-");
    expect(third.chat.latest().input.options.map((option) => option.label)).toEqual(["Approve", "Deny"]);
  });

  it("practice is not scored", async () => {
    const h = new Harness();
    await h.begin();
    await h.driveUntil((id) => id.includes("-card-"));
    expect(h.events().filter((event) => event.type === "practice")).toHaveLength(2);
    expect(decisions(h.events())).toEqual([]);
  });

  it("waits out the break, and a restart does not start it again", async () => {
    const h = new Harness();
    await h.begin();
    await h.driveUntil((id) => id.includes("-confidence-1-"));
    await h.answer({ label: "3" });
    const before = h.chat.cards.size;
    expect(h.chat.messages.at(-1)!.body).toContain("30-second break");
    h.nowMs += 20_000;
    await h.bot.tick();
    expect(h.chat.cards.size).toBe(before);

    h.restart();
    await h.bot.tick();
    expect(h.chat.cards.size).toBe(before);
    expect(h.events().some((event) => event.type === "break_done")).toBe(false);

    h.nowMs += 11_000;
    await h.bot.tick();
    expect(h.chat.cards.size).toBe(before + 1);
    expect(h.events().some((event) => event.type === "break_done")).toBe(true);
    expect(h.chat.messages.filter((message) => message.body.includes("30-second break"))).toHaveLength(1);
  });
});

describe("timing", () => {
  it("is card posted to answered_at", async () => {
    const h = new Harness();
    await h.begin();
    await h.driveUntil((id) => id.includes("-card-X01-"));
    h.nowMs += 7250;
    await h.answer({ label: "Allow once" });
    expect(decisions(h.events())[0]).toMatchObject({ request_id: "X01", ms: 7250, interrupted: false, decision: "approve", option: "Allow once", confirm_attempts: 0 });
  });

  it("uses Switch's answered_at rather than when the bot heard about it", async () => {
    const h = new Harness();
    await h.begin();
    await h.driveUntil((id) => id.includes("-card-X01-"));
    const { requestId, input } = h.chat.latest();
    const event = h.outcome(requestId, input, { label: "Decline" });
    event.answeredAtMs = h.nowMs + 4000;
    h.nowMs += 60_000;
    await h.bot.onOutcome(event);
    expect(decisions(h.events())[0]).toMatchObject({ ms: 4000, decision: "deny", option: "Decline" });
  });

  it("never records a time that is not positive, as the format requires", async () => {
    const h = new Harness();
    await h.begin();
    await h.driveUntil((id) => id.includes("-card-X01-"));
    const { requestId, input } = h.chat.latest();
    const event = h.outcome(requestId, input, { label: "Decline" });
    event.answeredAtMs = h.nowMs - 5;
    await h.bot.onOutcome(event);
    expect(decisions(h.events())[0]).toMatchObject({ ms: 1 });
  });
});

describe("answers from anyone else", () => {
  it("ignores and logs one, and posts the card again for the person", async () => {
    const h = new Harness();
    await h.begin();
    await h.driveUntil((id) => id.includes("-card-X01-"));
    const first = h.chat.latest().requestId;
    h.nowMs += 2000;
    await h.answer({ label: "Allow once" }, SOMEONE_ELSE);

    expect(decisions(h.events())).toEqual([]);
    expect(h.audit()).toEqual([expect.objectContaining({ what: "answer_from_someone_else", answered_by: SOMEONE_ELSE, request: first, reposted: true })]);
    expect(h.chat.latest().requestId).not.toBe(first);
    expect(h.chat.latest().requestId).toContain("-card-X01-");
    expect(h.chat.said(SWITCH_REPOSTED)).toBe(1);

    h.nowMs += 3000;
    await h.answer({ label: "Decline" });
    // One decision, timed from when the person first saw it, and marked as not a clean time.
    expect(decisions(h.events())).toHaveLength(1);
    expect(decisions(h.events())[0]).toMatchObject({ decision: "deny", ms: 5000, interrupted: true });
  });

  it("does not take consent from anyone else", async () => {
    const h = new Harness();
    await h.begin();
    await h.answer({ label: "I agree." }, SOMEONE_ELSE);
    expect(h.store.readState("p01").consent.agreed).toBeUndefined();
    expect(h.audit()[0]).toMatchObject({ what: "answer_from_someone_else" });
  });

  it("accepts the person answering as themselves through Switch", async () => {
    const h = new Harness();
    await h.begin();
    await h.driveUntil((id) => id.includes("-card-X01-"));
    await h.answer({ label: "Decline" }, "user:sw-p01");
    expect(decisions(h.events())).toHaveLength(1);
  });

  it("does not take a comment from anyone else, and logs no words of theirs", async () => {
    const h = new Harness();
    await h.begin();
    await h.driveUntil((id) => id.includes("-comment-"));
    h.nowMs += 5000;
    await h.bot.onMessage(h.message("private words from another person", SOMEONE_ELSE));
    expect(h.events().some((event) => event.type === "comment")).toBe(false);
    expect(h.audit().at(-1)).toMatchObject({ what: "message_from_someone_else", sender: SOMEONE_ELSE });
    expect(JSON.stringify(h.audit())).not.toContain("private words");
  });

  it("does not let the first message from someone else start the session", async () => {
    const h = new Harness();
    await h.bot.tick();
    await h.bot.onMessage(h.message("hello", SOMEONE_ELSE));
    expect(h.chat.cards.size).toBe(0);
  });

  it("ignores an answer for a card it never posted", async () => {
    const h = new Harness();
    await h.begin();
    const { input } = h.chat.latest();
    await h.bot.onOutcome(h.outcome("study-other-run-p01-card-X01-a0-r0", input, { label: "I agree." }));
    expect(h.audit()[0]).toMatchObject({ what: "unknown_card" });
    expect(h.store.readState("p01").consent.agreed).toBeUndefined();
  });
});

describe("restarting mid-session", () => {
  async function midBlock(): Promise<Harness> {
    const h = new Harness();
    await h.begin();
    await h.driveUntil((id) => id.includes("-card-X05-"));
    return h;
  }

  it("posts nothing twice", async () => {
    const h = await midBlock();
    const cards = h.chat.cards.size;
    const messages = h.chat.messages.length;
    const up = h.chat.latest().requestId;

    h.restart();
    await h.bot.tick();
    await h.bot.tick();

    expect(h.chat.cards.size).toBe(cards);
    expect(h.chat.messages.length).toBe(messages);
    expect(h.chat.latest().requestId).toBe(up);
    for (const card of h.chat.cards.values()) expect(card.opens).toBe(1);
  });

  it("keeps an answer given while it was down, once, timed from when the card really went up", async () => {
    const h = await midBlock();
    const before = decisions(h.events()).length;
    const { requestId, input } = h.chat.latest();
    h.nowMs += 9000;
    const given = h.outcome(requestId, input, { label: "Decline" });
    h.nowMs += 120_000;

    h.restart();
    await h.bot.onOutcome(given);
    expect(decisions(h.events())).toHaveLength(before + 1);
    expect(decisions(h.events()).at(-1)).toMatchObject({ request_id: "X05", ms: 9000, decision: "deny" });
    expect(h.chat.latest().requestId).toContain("-card-X06-");
  });

  it("records an answer once when Switch offers it again, as it does until told it was delivered", async () => {
    const h = await midBlock();
    const { requestId, input } = h.chat.latest();
    const given = h.outcome(requestId, input, { label: "Decline" });
    await h.bot.onOutcome(given);
    const count = decisions(h.events()).length;

    h.restart();
    await h.bot.onOutcome(given);
    await h.bot.onOutcome(given);
    expect(decisions(h.events())).toHaveLength(count);
    expect(h.audit().at(-1)).toMatchObject({ what: "already_handled" });
  });

  it("finds the same card if it dies between asking Switch and hearing back", async () => {
    const h = await midBlock();
    await h.answer({ label: "Decline" });
    // What a kill leaves: the card was asked for, its clock is running, and the reply was never seen.
    const state = h.store.readState("p01");
    const { requestId } = h.chat.latest();
    state.cards[requestId] = { key: state.cards[requestId]!.key, opened: false };
    h.store.writeState("p01", state);
    const clock = state.clocks.X06;
    const cards = h.chat.cards.size;

    h.restart();
    await h.bot.tick();

    expect(h.chat.cards.size).toBe(cards);
    expect(h.chat.cards.get(requestId)!.opens).toBe(2);
    expect(h.store.readState("p01").cards[requestId]!.opened).toBe(true);
    expect(h.store.readState("p01").clocks.X06).toBe(clock);
  });

  it("does not repeat a message that went out just before it died", async () => {
    const h = new Harness();
    await h.bot.tick();
    const state = h.store.readState("p01");
    state.said.welcome = "pending";
    h.store.writeState("p01", state);
    h.restart();
    await h.bot.tick();
    expect(h.chat.said(SWITCH_WELCOME)).toBe(1);
    expect(h.store.readState("p01").said.welcome).toBe("sent");
  });

  it("does send a message that did not go out before it died", async () => {
    const h = new Harness();
    const state = h.store.readState("p01");
    state.said.welcome = "pending";
    h.store.writeState("p01", state);
    h.restart();
    await h.bot.tick();
    expect(h.chat.said(SWITCH_WELCOME)).toBe(1);
  });

  it("keeps a comment typed while it was down: it arrives when the stream resumes", async () => {
    const h = new Harness();
    await h.begin();
    await h.driveUntil((id) => id.includes("-comment-"));
    h.nowMs += 5000;
    h.restart();
    await h.bot.onMessage(h.message("the second one"));
    expect(h.events().filter((event) => event.type === "comment")).toEqual([expect.objectContaining({ text: "the second one" })]);
    expect(h.events().at(-1)!.type).toBe("session_end");
  });

  it("does not record a comment twice if the message arrives again", async () => {
    const h = new Harness();
    await h.begin();
    await h.driveUntil((id) => id.includes("-comment-"));
    h.nowMs += 5000;
    const message = h.message("the second one");
    await h.bot.onMessage(message);
    h.restart();
    await h.bot.onMessage(message);
    expect(h.events().filter((event) => event.type === "comment")).toHaveLength(1);
    expect(h.events().filter((event) => event.type === "session_end")).toHaveLength(1);
  });

  it("does not start the session twice if it dies between the two consent records", async () => {
    const h = new Harness();
    await h.begin();
    await h.answer({ label: "I agree." });
    await h.answer({ label: "other" });
    h.store.results.record("p01", { type: "session_start", group: 1, platform: "switch", schema: 1 });
    await h.answer({ label: "2" });
    expect(h.events().filter((event) => event.type === "session_start")).toHaveLength(1);
    expect(h.events().filter((event) => event.type === "consent")).toHaveLength(1);
  });

  it("does not mark a message as handled if handling it failed, so a restart hears it again", async () => {
    const h = new Harness();
    await h.begin();
    await h.bot.onMessage(h.message("hi"), { position: { "r:room-p01": 10 } });
    const realRead = h.store.readState.bind(h.store);
    h.store.readState = () => {
      throw new Error("disk full");
    };
    await expect(h.bot.onMessage(h.message("hi"), { position: { "r:room-p01": 11 } })).rejects.toThrow("disk full");
    h.store.readState = realRead;
    expect(h.store.readPosition()).toEqual({ "r:room-p01": 10 });
  });

  it("resumes the stream from what was last handled, not what was last received", async () => {
    const h = new Harness();
    await h.begin();
    await h.bot.onMessage(h.message("hi"), { position: { "r:room-p01": 10, s: 3 } });
    await h.bot.onMessage(h.message("hi"), { position: { "r:room-p01": 12 } });
    expect(h.store.readPosition()).toEqual({ "r:room-p01": 12, s: 3 });
    await h.bot.onMessage(h.message("hi"), { position: { "r:room-p01": 11 } });
    expect(h.store.readPosition()).toEqual({ "r:room-p01": 12, s: 3 });
  });
});

describe("when Switch cannot be reached", () => {
  it("keeps the answer and posts the next card on a later tick", async () => {
    const h = new Harness();
    await h.begin();
    await h.driveUntil((id) => id.includes("-card-X01-"));
    h.chat.failOpens = 1;
    await h.answer({ label: "Allow once" });
    expect(decisions(h.events())).toHaveLength(1);
    expect(h.chat.latest().requestId).toContain("-card-X01-");

    h.nowMs += 5000;
    await h.bot.tick();
    expect(h.chat.latest().requestId).toContain("-card-X02-");
    // Nobody could see the card while it failed, so its clock starts now.
    expect(h.store.readState("p01").clocks.X02).toBe(new Date(h.nowMs).toISOString());
  });

  it("says a message on a later tick if it could not the first time", async () => {
    const h = new Harness();
    h.chat.failPosts = 1;
    await h.bot.tick();
    expect(h.chat.said(SWITCH_WELCOME)).toBe(0);
    await h.bot.tick();
    expect(h.chat.said(SWITCH_WELCOME)).toBe(1);
  });
});

describe("type-to-confirm on critical items, condition B", () => {
  const critical = sets.X.find((request) => request.b.confirm)!;

  /** p03 sees set X in condition B first. */
  async function atCritical(): Promise<Harness> {
    const h = new Harness("p03");
    await h.begin();
    await h.driveUntil((id) => id.includes(`-card-${critical.id}-`));
    return h;
  }

  it("is a questions card with a No button that takes a typed value", async () => {
    const h = await atCritical();
    const { input } = h.chat.latest();
    expect(input.kind).toBe("questions");
    expect(input.options).toEqual([]);
    const question = input.questions[0]!;
    expect(question.prompt.startsWith(critical.b.confirm!.question)).toBe(true);
    expect(question.title).toContain("in quotes");
    expect(question.allowCustomAnswer).toBe(true);
    expect(question.options.map((option) => option.label)).toEqual(["No, deny"]);
  });

  it("approves on the right value", async () => {
    const h = await atCritical();
    h.nowMs += 4000;
    await h.answer({ typed: critical.b.confirm!.expected });
    expect(decisions(h.events()).at(-1)).toMatchObject({ request_id: critical.id, decision: "approve", option: "typed", confirm_attempts: 1, ms: 4000 });
  });

  it("denies on the No button", async () => {
    const h = await atCritical();
    await h.answer({ label: "No, deny" });
    expect(decisions(h.events()).at(-1)).toMatchObject({ request_id: critical.id, decision: "deny", option: "No, deny", confirm_attempts: 0 });
  });

  it("asks once more on a wrong value, with the clock still running", async () => {
    const h = await atCritical();
    const before = decisions(h.events()).length;
    h.nowMs += 3000;
    await h.answer({ typed: "1" });
    expect(decisions(h.events())).toHaveLength(before);
    expect(h.events().at(-1)).toMatchObject({ type: "confirm_wrong", request_id: critical.id });
    expect(h.chat.said(CONFIRM_REASK)).toBe(1);
    expect(h.chat.latest().requestId).toContain("-a1-");

    h.nowMs += 2000;
    await h.answer({ typed: critical.b.confirm!.expected });
    expect(decisions(h.events()).at(-1)).toMatchObject({ decision: "approve", ms: 5000, confirm_attempts: 2 });
  });

  it("counts a second wrong value as not approved, and says so", async () => {
    const h = await atCritical();
    await h.answer({ typed: "1" });
    await h.answer({ typed: "2" });
    expect(decisions(h.events()).at(-1)).toMatchObject({ decision: "confirm_failed", option: "typed", confirm_attempts: 2 });
    expect(h.chat.said(CONFIRM_FAILED)).toBe(1);
  });

  it("explains the quotes once, if someone types the value in a way Switch does not read", async () => {
    const h = await atCritical();
    h.nowMs += 5000;
    await h.bot.onMessage(h.message("38000"));
    await h.bot.onMessage(h.message("A19 38000"));
    expect(h.chat.said(TYPE_TO_CONFIRM_HINT)).toBe(1);
  });

  it("does not explain anything to someone who answered in a way Switch does read", async () => {
    const h = await atCritical();
    h.nowMs += 5000;
    await h.bot.onMessage(h.message('A19 "38000"'));
    await h.bot.onMessage(h.message("A19 “38000”"));
    await h.bot.onMessage(h.message("A19 1"));
    expect(h.chat.said(TYPE_TO_CONFIRM_HINT)).toBe(0);
  });

  it("leaves a decision word to Switch, which refuses it out loud on this kind of card", async () => {
    const h = await atCritical();
    h.nowMs += 5000;
    await h.bot.onMessage(h.message("A19 no"));
    await h.bot.onMessage(h.message("A19 yes."));
    expect(h.chat.said(TYPE_TO_CONFIRM_HINT)).toBe(0);
  });
});

describe("a message that arrives late", () => {
  it("does not earn a hint if it came just as the card went up, even stamped a moment after", async () => {
    // Seen in the rehearsal: a message about the last card was stamped after the next one was posted.
    const h = new Harness("p03");
    await h.begin();
    const critical = sets.X.find((request) => request.b.confirm)!;
    await h.driveUntil((id) => id.includes(`-card-${critical.id}-`));
    const before = h.message("38000");
    before.timestampMs = h.nowMs - 200;
    await h.bot.onMessage(before);
    const justAfter = h.message("38000");
    justAfter.timestampMs = h.nowMs + 400;
    await h.bot.onMessage(justAfter);
    expect(h.chat.said(TYPE_TO_CONFIRM_HINT)).toBe(0);

    h.nowMs += 5000;
    await h.bot.onMessage(h.message("38000"));
    expect(h.chat.said(TYPE_TO_CONFIRM_HINT)).toBe(1);
  });

  it("is not taken for the comment if it was written before the question was asked", async () => {
    const h = new Harness();
    await h.begin();
    await h.driveUntil((id) => id.includes("-comment-"));
    const late = h.message("ok that was the last one");
    late.timestampMs = h.nowMs + 400;
    await h.bot.onMessage(late);
    expect(h.events().some((event) => event.type === "comment")).toBe(false);

    h.nowMs += 5000;
    await h.bot.onMessage(h.message("the second one"));
    expect(h.events().filter((event) => event.type === "comment")).toEqual([expect.objectContaining({ text: "the second one" })]);
  });
});

describe("an outage long enough for cards to lose their buttons", () => {
  async function upAndDown(downForMs: number): Promise<Harness> {
    const h = new Harness();
    await h.begin();
    await h.driveUntil((id) => id.includes("-card-X02-"));
    await h.bot.tick();
    h.nowMs += downForMs;
    h.restart();
    await h.bot.resume();
    return h;
  }

  it("marks the time on the card that was up as not all deciding", async () => {
    const h = await upAndDown(40_000);
    await h.bot.tick();
    await h.answer({ label: "Allow once" });
    expect(decisions(h.events()).at(-1)).toMatchObject({ request_id: "X02", interrupted: true });
    expect(h.audit().at(-1)).toMatchObject({ what: "card_was_up_during_an_outage" });
    expect(h.logs.at(-1)).toContain("down for 40 s");
  });

  it("does not mark the next card, which came after it", async () => {
    const h = await upAndDown(40_000);
    await h.bot.tick();
    await h.answer({ label: "Allow once" });
    await h.answer({ label: "Allow once" });
    expect(decisions(h.events()).at(-1)).toMatchObject({ request_id: "X03", interrupted: false });
  });

  it("leaves a quick restart alone, because the card kept its buttons through it", async () => {
    const h = await upAndDown(10_000);
    await h.bot.tick();
    await h.answer({ label: "Allow once" });
    expect(decisions(h.events()).at(-1)).toMatchObject({ request_id: "X02", interrupted: false });
    expect(h.audit()).toEqual([]);
  });

  it("has nothing to do on a first start", async () => {
    const h = new Harness();
    await h.bot.resume();
    expect(h.logs).toEqual([]);
  });
});

describe("the last question", () => {
  async function atComment(): Promise<Harness> {
    const h = new Harness();
    await h.begin();
    await h.driveUntil((id) => id.includes("-comment-"));
    h.nowMs += 5000;
    return h;
  }

  it("takes a plain message, and closes the card", async () => {
    const h = await atComment();
    const { requestId } = h.chat.latest();
    await h.bot.onMessage(h.message("  the second one  "));
    expect(h.events().filter((event) => event.type === "comment")).toEqual([expect.objectContaining({ text: "the second one" })]);
    expect(h.chat.cards.get(requestId)!.closed).toBe(true);
  });

  it("takes an answer typed the way the card shows", async () => {
    const h = await atComment();
    await h.answer({ typed: "the second one" });
    expect(h.events().filter((event) => event.type === "comment")).toEqual([expect.objectContaining({ text: "the second one" })]);
  });

  it("records an empty comment for the button", async () => {
    const h = await atComment();
    await h.answer({ label: "No comment" });
    expect(h.events().filter((event) => event.type === "comment")).toEqual([expect.objectContaining({ text: "" })]);
  });

  it("does not mistake a stray typed answer for the comment", async () => {
    const h = await atComment();
    await h.bot.onMessage(h.message("A12 no"));
    expect(h.events().some((event) => event.type === "comment")).toBe(false);
  });

  it("keeps a long comment to what the format allows", async () => {
    const h = await atComment();
    await h.bot.onMessage(h.message("x".repeat(3000)));
    const comment = h.events().find((event) => event.type === "comment");
    expect(comment?.type === "comment" && comment.text.length).toBe(2000);
  });
});

describe("stopping", () => {
  it("before consent records nothing", async () => {
    const h = new Harness();
    await h.begin();
    await h.bot.onMessage(h.message("stop"));
    expect(h.events()).toEqual([]);
    expect(h.chat.said(STOPPED_MESSAGE)).toBe(1);
  });

  it("mid-block records it, closes the card and posts no more", async () => {
    const h = new Harness();
    await h.begin();
    await h.driveUntil((id) => id.includes("-card-X03-"));
    const { requestId } = h.chat.latest();
    const cards = h.chat.cards.size;
    await h.bot.onMessage(h.message("STOP"));
    expect(h.events().at(-1)!.type).toBe("stopped");
    expect(h.chat.cards.get(requestId)!.closed).toBe(true);
    expect(h.chat.said(STOPPED_MESSAGE)).toBe(1);

    await h.bot.tick();
    h.restart();
    await h.bot.tick();
    expect(h.chat.cards.size).toBe(cards);
    expect(h.chat.said(STOPPED_MESSAGE)).toBe(1);
    expect(analyse(h.events(), "2026-11-06T17:00:00.000Z").participants.stopped).toEqual(["p01"]);
  });

  it("does not take a sentence with the word in it", async () => {
    const h = new Harness();
    await h.begin();
    await h.bot.onMessage(h.message("please stop asking me things"));
    expect(h.chat.said(STOPPED_MESSAGE)).toBe(0);
  });
});

describe("routing", () => {
  it("keeps each person's session in their own room and file", async () => {
    const h = new Harness("p01");
    const other = account("p02");
    const store = createStudyStore({ resultsDir: h.dir, synthetic: true, now: () => new Date(h.nowMs) });
    const bot = createStudyBot(
      { p01: h.who, p02: other },
      { chat: h.chat, store, sets, now: () => new Date(h.nowMs), log: () => undefined, runId: "run", breakSeconds: 30, recentBodies: async () => [] },
    );
    await bot.tick();
    expect(h.chat.messages.map((message) => message.roomId).sort()).toEqual(["room-p01", "room-p02"]);
    await bot.onMessage({ ...h.message("hello"), roomId: "room-p02", sender: other.participantId });
    expect(h.chat.latest().requestId).toContain("-p02-");
    expect(h.chat.latest().input.roomId).toBe("room-p02");
    await bot.onMessage({ ...h.message("hello"), roomId: "someone-elses-room" });
    expect([...h.chat.cards.keys()].filter((id) => id.includes("-p01-"))).toEqual([]);
  });

  it("leaves a retired account alone", () => {
    const h = new Harness();
    const bot = createStudyBot(
      { p01: { ...h.who, retired: true } },
      { chat: h.chat, store: h.store, sets, now: () => new Date(h.nowMs), log: () => undefined, runId: "run", recentBodies: async () => [] },
    );
    expect(bot.sessions).toEqual([]);
  });

  it("says so when an answer belongs to no session it knows", async () => {
    const h = new Harness();
    const { requestId, input } = { requestId: "x", input: { kind: "approval", title: "t", detail: "", options: [{ id: "a", label: "A" }], questions: [] } as LiveCard };
    await h.bot.onOutcome({ ...h.outcome(requestId, input, { label: "A" }), sessionId: "clr-room-elsewhere" });
    expect(h.logs.at(-1)).toContain("not in this study");
  });
});

describe("results", () => {
  it("refuses to put synthetic events in the real results folder", () => {
    expect(() => createStudyStore({ resultsDir: DEFAULT_RESULTS_DIR, synthetic: true })).toThrow("refusing");
  });

  it("keeps its own notes where the analysis does not read them", async () => {
    const h = new Harness();
    await h.begin();
    await h.answer({ label: "I agree." }, SOMEONE_ELSE);
    expect(existsSync(join(h.dir, "bot-state", "p01.json"))).toBe(true);
    expect(existsSync(join(h.dir, "bot-state", "p01.audit.ndjson"))).toBe(true);
    expect(existsSync(join(h.dir, "p01.audit.ndjson"))).toBe(false);
  });
});

describe("the debrief", () => {
  it("fits Mattermost's post limit however many flaws were missed", () => {
    const missed = Array.from({ length: 40 }, (_, index) => ({ headline: `REFUND ${index}`, explanation: "x".repeat(300) }));
    const parts = debriefMessages(missed);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(3500);
    const all = parts.join("\n");
    for (let index = 0; index < 40; index += 1) expect(all).toContain(`REFUND ${index}`);
  });

  it("says plainly when nothing was missed", () => {
    expect(debriefMessages([]).join("\n")).toContain(DEBRIEF_NONE_MISSED);
  });
});

describe("option labels", () => {
  it("finds a label by its id, on either kind of card", () => {
    const approval = { kind: "approval", title: "t", detail: "", options: [{ id: "a", label: "Approve" }], questions: [] } as LiveCard;
    expect(labelOf(approval, "a")).toBe("Approve");
    expect(labelOf(approval, "b")).toBeUndefined();
  });
});

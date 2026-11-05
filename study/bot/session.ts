/**
 * One participant's run through PLAN 11.6, as real Switch cards in their private room.
 *
 * The result log decides where the session is, through the same `deriveStep` the Lab uses. Nothing here
 * holds position in memory, which is what makes a restart safe:
 *
 * - A card's request id is built from what it is, so opening it again finds the card Switch already has
 *   rather than posting another.
 * - An answer is recorded before Switch hears it was delivered, and Switch offers it again until it has.
 *   One that no longer matches the current step is already recorded, and is ignored.
 * - A message that may have gone out before a crash is looked for in the room before it is sent again.
 *
 * Identity comes from Switch: `answered_by` on a card and `sender` on a message. An answer from anyone
 * else is logged and changes nothing. If it used the card up, the card goes up again.
 *
 * Work for one person runs one thing at a time, and state is read at the start of each thing and saved
 * as it goes, so nothing can overwrite a newer save with an older copy.
 */
import type { ApprovalOutcomeEvent, ChatMessageEvent, ChatPort } from "../../packages/contracts/src/index";
import { roomSessionId } from "../../packages/switch-agent/src/agent";
import type { ParticipantAccount } from "../lib/accounts";
import {
  BREAK_SECONDS,
  BRIEFING,
  BRIEFING_START,
  CONFIDENCE_QUESTION,
  CONFIRM_FAILED,
  CONFIRM_REASK,
  CONSENT,
  CONSENT_AGREE,
  CONSENT_DECLINE,
  CONSENT_QUESTION,
  COMMENT_HOW,
  DEBRIEF_ACKNOWLEDGE,
  DEBRIEF_DATA,
  DEBRIEF_MISSED_INTRO,
  DEBRIEF_NONE_MISSED,
  DEBRIEF_THANKS,
  FAMILIARITY_QUESTION,
  FREE_TEXT_HINT,
  FREE_TEXT_QUESTION,
  NO_COMMENT,
  ROLE_OPTIONS,
  ROLE_QUESTION,
  STOPPED_MESSAGE,
  SWITCH_PRACTICE_INTRO,
  SWITCH_REPOSTED,
  SWITCH_WELCOME,
  TYPE_TO_CONFIRM_HINT,
  switchBlockIntro,
  switchBreakNotice,
} from "../lib/materials";
import { answerRecord, assignGroup, deriveStep, locate, resolveAnswer, type CardStep, type Sets, type Step } from "../lib/protocol";
import { decisionCard, labelOf, questionCard, type LiveCard } from "./cards";
import type { SessionState, StudyStore } from "./store";

const RATINGS = ["1", "2", "3", "4", "5"];
const MAX_COMMENT = 2000;
/** A Mattermost post holds 4000 characters. A long debrief goes in several. */
const MAX_MESSAGE = 3500;

const STOP = /^\s*stop(\s+the\s+study)?[.!]?\s*$/i;
/** What Switch's grammar reads as an answer naming a card, with a quoted value or without. */
const NAMES_A_CARD = /^\s*[`*_~]*[AaRr]\d+\b/;
const QUOTED_ANSWER = /^\s*[`*_~]*[AaRr]\d+[\s:.-]+(q\s*\d+\s*[=:]\s*)?["'“‘]/i;
/**
 * Forms Switch deals with itself: an option's number, as its own footer suggests, and a decision word,
 * which it either takes or refuses out loud. None of them is someone failing to type a value.
 */
const SWITCH_ANSWERS_THESE = /^\s*[`*_~]*[AaRr]\d+[\s:.-]+(\d{1,2}|yes|y|ok|okay|approve|approved|allow|no|n|deny|denied|decline|reject)[`*_~.!,:;]*\s*$/i;
/**
 * Nobody reads a new card and types an answer this fast. Switch stamps a message only after it has
 * handled any answer in it, so a message about the last card can carry a time just after this one
 * went up. Seen live in the rehearsal, which is why comparing times alone was not enough.
 */
const STILL_ABOUT_THE_LAST_CARD_MS = 1500;

export type SessionDeps = {
  chat: ChatPort;
  store: StudyStore;
  sets: Sets;
  now: () => Date;
  log: (line: string) => void;
  /** Separates runs, so a rehearsal's cards are never mistaken for the real session's. */
  runId: string;
  breakSeconds?: number;
  /** What the bot has already said in a room, to check after a crash. */
  recentBodies: (roomId: string) => Promise<string[]>;
};

/** What the current step asks of the person, as a card. */
type Spec =
  | { type: "agree" | "role" | "familiarity" | "briefing" | "comment"; key: string; card: LiveCard }
  | { type: "confidence"; key: string; card: LiveCard; block: number }
  | { type: "decision"; key: string; card: LiveCard; step: CardStep; clockKey: string };

/** When a card first went up is kept under this. A re-asked request keeps its first time, as in the Lab. */
const clockKeyOf = (spec: Spec) => (spec.type === "decision" ? spec.clockKey : spec.key);

export class Session {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly group;
  readonly breakSeconds: number;

  constructor(
    readonly participant: string,
    readonly account: ParticipantAccount,
    private readonly deps: SessionDeps,
  ) {
    this.group = assignGroup(participant);
    this.breakSeconds = deps.breakSeconds ?? BREAK_SECONDS;
  }

  /** One thing at a time per person, in arrival order. Rejects if the work failed. */
  private run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  // ── What is happening now ──────────────────────────────────────────────────

  private step(): Step {
    return deriveStep(this.deps.store.results.read(this.participant), this.participant, this.deps.sets, this.breakSeconds);
  }

  private specFor(step: Step, state: SessionState): Spec | null {
    switch (step.step) {
      case "consent":
        if (state.consent.agreed === undefined) {
          return {
            type: "agree",
            key: "consent-agree",
            card: questionCard({ title: "Before we start", question: CONSENT_QUESTION, prompt: CONSENT, options: [CONSENT_AGREE, CONSENT_DECLINE] }),
          };
        }
        if (state.consent.role === undefined) {
          return { type: "role", key: "consent-role", card: questionCard({ title: "About you", question: ROLE_QUESTION, prompt: "", options: [...ROLE_OPTIONS] }) };
        }
        return { type: "familiarity", key: "consent-familiarity", card: questionCard({ title: "About you", question: FAMILIARITY_QUESTION, prompt: "", options: RATINGS }) };
      case "briefing":
        return { type: "briefing", key: "briefing", card: questionCard({ title: "Your task", question: "When you're ready", prompt: BRIEFING, options: [BRIEFING_START] }) };
      case "practice":
      case "card": {
        const { request, condition } = locate(this.deps.sets, this.group, step);
        return { type: "decision", key: `${step.step}-${request.id}-a${step.attempts}`, card: decisionCard(request, condition), step, clockKey: request.id };
      }
      case "confidence":
        return {
          type: "confidence",
          key: `confidence-${step.block}`,
          block: step.block,
          card: questionCard({ title: `Block ${step.block} is finished`, question: CONFIDENCE_QUESTION, prompt: "", options: RATINGS }),
        };
      case "comment":
        return {
          type: "comment",
          key: "comment",
          card: questionCard({ title: "One last question", question: FREE_TEXT_QUESTION, prompt: `${FREE_TEXT_HINT} ${COMMENT_HOW}`, options: [NO_COMMENT], allowCustomAnswer: true }),
        };
      default:
        return null;
    }
  }

  private requestIdFor(key: string, state: SessionState): string {
    return `study-${this.deps.runId}-${this.participant}-${key}-r${state.reopens[key] ?? 0}`;
  }

  // ── Saying things ──────────────────────────────────────────────────────────

  private async say(state: SessionState, key: string, body: string): Promise<void> {
    if (state.said[key] === "sent") return;
    const roomId = this.account.roomId;
    if (state.said[key] === "pending") {
      // A crash here could have gone either way, so look. Sending blind would double-post.
      if ((await this.deps.recentBodies(roomId)).includes(body)) {
        state.said[key] = "sent";
        this.save(state);
        return;
      }
    }
    state.said[key] = "pending";
    this.save(state);
    await this.deps.chat.postMessage({ roomId, body });
    state.said[key] = "sent";
    this.save(state);
  }

  private save(state: SessionState): void {
    this.deps.store.writeState(this.participant, state);
  }

  private async openCard(spec: Spec, state: SessionState): Promise<void> {
    const requestId = this.requestIdFor(spec.key, state);
    if (state.cards[requestId]?.opened) return;
    const clockKey = clockKeyOf(spec);
    const startedClock = state.clocks[clockKey] === undefined;
    if (startedClock) state.clocks[clockKey] = this.deps.now().toISOString();
    state.cards[requestId] = { key: spec.key, opened: false };
    this.save(state);
    try {
      await this.deps.chat.openCard({ roomId: this.account.roomId, requestId, mentionMessageId: state.startMessageId, ...spec.card });
    } catch (error) {
      // Nobody can see a card that failed to open, so its clock has not started.
      if (startedClock) delete state.clocks[clockKey];
      this.save(state);
      throw error;
    }
    state.cards[requestId] = { key: spec.key, opened: true };
    this.save(state);
  }

  // ── Moving on ──────────────────────────────────────────────────────────────

  /** Does whatever the current step needs next. Safe to call at any time, any number of times. */
  advance(): Promise<void> {
    return this.run(() => this.advanceNow());
  }

  private async advanceNow(): Promise<void> {
    const state = this.deps.store.readState(this.participant);
    if (state.declined) return this.say(state, "declined", STOPPED_MESSAGE);
    if (!state.startMessageId) return this.say(state, "welcome", SWITCH_WELCOME);
    while (state.notices.length > 0) {
      const notice = state.notices[0]!;
      await this.say(state, notice.key, notice.body);
      state.notices.shift();
      this.save(state);
    }

    let step = this.step();
    if (step.step === "break") {
      await this.say(state, "break", switchBreakNotice(step.seconds));
      const started = state.breakStartedAt ?? this.deps.now().toISOString();
      if (state.breakStartedAt === undefined) {
        state.breakStartedAt = started;
        this.save(state);
      }
      if (this.deps.now().getTime() - Date.parse(started) < step.seconds * 1000) return;
      this.deps.store.results.record(this.participant, { type: "break_done" });
      step = this.step();
    }
    if (step.step === "stopped") return this.say(state, "stopped", STOPPED_MESSAGE);
    if (step.step === "debrief") {
      const parts = debriefMessages(step.missed);
      for (const [index, part] of parts.entries()) await this.say(state, `debrief-${index}`, part);
      return;
    }
    if (step.step === "practice" && step.index === 1) await this.say(state, "practice-intro", SWITCH_PRACTICE_INTRO);
    if (step.step === "card" && step.position === 1) await this.say(state, `block-intro-${step.block}`, switchBlockIntro(step.block, step.total));

    const spec = this.specFor(step, state);
    if (spec) await this.openCard(spec, state);
  }

  /**
   * The bot was down long enough for Switch to count it as gone. The open card showed "Host offline"
   * with no buttons for a while, so its time is not all deciding.
   */
  noteOutage(): Promise<void> {
    return this.run(async () => {
      const state = this.deps.store.readState(this.participant);
      const spec = this.specFor(this.step(), state);
      if (spec?.type !== "decision" || !state.cards[this.requestIdFor(spec.key, state)]?.opened) return;
      if (!state.disturbed.includes(spec.clockKey)) state.disturbed.push(spec.clockKey);
      this.save(state);
      this.deps.store.audit(this.participant, { what: "card_was_up_during_an_outage", card: spec.key });
    });
  }

  /** Runs `advance` and keeps what already happened if it fails: the next tick tries again. */
  private async advanceQuietly(): Promise<void> {
    try {
      await this.advanceNow();
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      this.deps.log(`${this.participant}: could not move on yet: ${failure.message}${failure.syscall ? ` [${failure.code} ${failure.syscall}]` : ""}`);
    }
  }

  // ── Answers ────────────────────────────────────────────────────────────────

  private isThem(answeredBy: string | null | undefined): boolean {
    return answeredBy === this.account.participantId || answeredBy === `user:${this.account.switchUserId}`;
  }

  /** Resolves once the answer is safely recorded. Until then Switch keeps offering it. */
  handleOutcome(event: ApprovalOutcomeEvent): Promise<void> {
    return this.run(async () => {
      this.applyOutcome(event);
      await this.advanceQuietly();
    });
  }

  private applyOutcome(event: ApprovalOutcomeEvent): void {
    const { store } = this.deps;
    const state = store.readState(this.participant);
    const known = state.cards[event.switchRequestId];
    const refer = { request: event.switchRequestId, card: known?.key ?? null };
    if (!known) {
      store.audit(this.participant, { what: "unknown_card", ...refer, state: event.state, answered_by: event.answeredBy ?? null });
      return;
    }
    const step = this.step();
    const spec = this.specFor(step, state);
    const current = spec !== null && spec.key === known.key && this.requestIdFor(spec.key, state) === event.switchRequestId;

    if (event.state !== "answered" || !this.isThem(event.answeredBy)) {
      const what = event.state === "answered" ? "answer_from_someone_else" : "card_ended_unanswered";
      store.audit(this.participant, { what, ...refer, state: event.state, answered_by: event.answeredBy ?? null, reposted: current });
      this.deps.log(`${this.participant}: ignored ${what} on ${known.key}`);
      if (current && spec) {
        const count = (state.reopens[spec.key] ?? 0) + 1;
        state.reopens[spec.key] = count;
        if (spec.type === "decision" && !state.disturbed.includes(spec.clockKey)) state.disturbed.push(spec.clockKey);
        // The person may otherwise wonder where their card went.
        state.notices.push({ key: `reposted-${spec.key}-${count}`, body: SWITCH_REPOSTED });
        store.writeState(this.participant, state);
      }
      return;
    }
    if (!current || !spec) {
      // Already recorded: Switch offers an answer again until it hears it was delivered.
      store.audit(this.participant, { what: "already_handled", ...refer });
      return;
    }
    this.applyAnswer(spec, event, state);
  }

  /** The option chosen, or the words typed. */
  private readAnswer(spec: Spec, event: ApprovalOutcomeEvent): { label?: string; typed?: string } {
    if (spec.card.kind === "approval") return { label: event.answer ? labelOf(spec.card, event.answer) : undefined };
    const answer = event.answers?.[0] as { selected_option_ids?: string[]; custom_text?: string | null } | undefined;
    const typed = answer?.custom_text;
    if (typeof typed === "string" && typed.trim()) return { typed };
    const selected = answer?.selected_option_ids?.[0];
    return { label: selected ? labelOf(spec.card, selected) : undefined };
  }

  private applyAnswer(spec: Spec, event: ApprovalOutcomeEvent, state: SessionState): void {
    const { store } = this.deps;
    const { results } = store;
    const answer = this.readAnswer(spec, event);
    const unreadable = () => {
      store.audit(this.participant, { what: "unreadable_answer", card: spec.key, answer: event.answer ?? null, answers: event.answers ?? null });
      state.reopens[spec.key] = (state.reopens[spec.key] ?? 0) + 1;
      store.writeState(this.participant, state);
    };

    switch (spec.type) {
      case "agree":
        if (answer.label === CONSENT_AGREE) state.consent.agreed = true;
        else if (answer.label === CONSENT_DECLINE) {
          // PLAN 11.8: nothing is recorded before someone agrees.
          state.declined = true;
        } else return unreadable();
        store.writeState(this.participant, state);
        return;
      case "role":
        if (!answer.label) return unreadable();
        state.consent.role = answer.label;
        store.writeState(this.participant, state);
        return;
      case "familiarity": {
        const familiarity = Number(answer.label);
        if (!RATINGS.includes(String(answer.label)) || !state.consent.role) return unreadable();
        // A crash between these two lines is offered again, and must not start the session twice.
        if (!results.read(this.participant).some((entry) => entry.type === "session_start")) {
          results.record(this.participant, { type: "session_start", group: this.group.group, platform: "switch", schema: 1 });
        }
        results.record(this.participant, { type: "consent", agreed: true, role: state.consent.role, familiarity });
        return;
      }
      case "briefing":
        if (answer.label !== BRIEFING_START) return unreadable();
        results.record(this.participant, { type: "briefing_read" });
        return;
      case "confidence": {
        if (!RATINGS.includes(String(answer.label))) return unreadable();
        results.record(this.participant, { type: "confidence", block: spec.block, value: Number(answer.label) });
        return;
      }
      case "comment": {
        const text = answer.label === NO_COMMENT ? "" : answer.typed;
        if (text === undefined) return unreadable();
        this.finish(text);
        return;
      }
      case "decision":
        this.applyDecision(spec, event, answer, state);
        return;
    }
  }

  private applyDecision(spec: Extract<Spec, { type: "decision" }>, event: ApprovalOutcomeEvent, answer: { label?: string; typed?: string }, state: SessionState): void {
    const { store, now } = this.deps;
    const located = locate(this.deps.sets, this.group, spec.step);
    const outcome = resolveAnswer(located.request, located.condition, spec.step.attempts, answer);
    if (outcome.kind === "invalid") {
      store.audit(this.participant, { what: "unreadable_answer", card: spec.key, reason: outcome.reason, answer: event.answer ?? null, answers: event.answers ?? null });
      state.reopens[spec.key] = (state.reopens[spec.key] ?? 0) + 1;
      store.writeState(this.participant, state);
      return;
    }
    if (outcome.kind === "reask") {
      state.notices.push({ key: `reask-${located.request.id}`, body: CONFIRM_REASK });
      store.writeState(this.participant, state);
      store.results.record(this.participant, { type: "confirm_wrong", request_id: located.request.id });
      return;
    }
    // Card posted to answered_at: PLAN 11.5. A re-asked card is one decision, so the clock keeps running.
    const answeredAt = event.answeredAtMs ?? now().getTime();
    const posted = Date.parse(state.clocks[spec.clockKey] ?? now().toISOString());
    const ms = Math.max(1, Math.round(answeredAt - posted));
    const interrupted = state.disturbed.includes(spec.clockKey);
    if (outcome.decision === "confirm_failed") {
      state.notices.push({ key: `confirm-failed-${located.request.id}`, body: CONFIRM_FAILED });
      store.writeState(this.participant, state);
    }
    store.results.record(this.participant, answerRecord(this.group, spec.step, located, outcome, { ms, interrupted }, answer.typed !== undefined));
  }

  private finish(text: string): void {
    const { results } = this.deps.store;
    // A crash between these two lines is offered again, and must not record the comment twice.
    if (!results.read(this.participant).some((entry) => entry.type === "comment")) {
      results.record(this.participant, { type: "comment", text: text.slice(0, MAX_COMMENT) });
    }
    results.record(this.participant, { type: "session_end" });
  }

  // ── Plain messages ─────────────────────────────────────────────────────────

  handleMessage(event: ChatMessageEvent): Promise<void> {
    return this.run(async () => {
      if (event.sender !== this.account.participantId) {
        // Never the text: it isn't this participant's, and it has no place in their log.
        this.deps.store.audit(this.participant, { what: "message_from_someone_else", sender: event.sender, message: event.messageId });
        return;
      }
      await this.applyMessage(event);
      await this.advanceQuietly();
    });
  }

  private async applyMessage(event: ChatMessageEvent): Promise<void> {
    const { store } = this.deps;
    const state = store.readState(this.participant);
    if (state.declined) return;

    const spec = this.specFor(this.step(), state);
    const openRequest = spec ? this.requestIdFor(spec.key, state) : null;
    // A message can arrive after the answer it came with has already moved things on.
    const postedAt = spec ? state.clocks[clockKeyOf(spec)] : undefined;
    const aboutThisCard = postedAt === undefined || event.timestampMs >= Date.parse(postedAt) + STILL_ABOUT_THE_LAST_CARD_MS;

    if (STOP.test(event.body)) {
      // The card goes first: once this is recorded there is no current step to find it from. If this
      // dies halfway, the message was never marked handled and arrives again.
      if (openRequest && state.cards[openRequest]) await this.closeCard(openRequest);
      const started = store.results.read(this.participant).some((entry) => entry.type === "session_start");
      if (started && this.step().step !== "stopped") store.results.record(this.participant, { type: "stopped" });
      if (!started) {
        state.declined = true;
        store.writeState(this.participant, state);
      }
      return;
    }
    if (!state.startMessageId) {
      state.startMessageId = event.messageId;
      store.writeState(this.participant, state);
      return;
    }
    if (spec?.type === "comment" && aboutThisCard && !NAMES_A_CARD.test(event.body) && event.body.trim()) {
      this.finish(event.body.trim());
      if (openRequest) await this.closeCard(openRequest);
      return;
    }
    // Someone trying to type a value, in a way Switch's grammar won't read.
    if (spec?.type === "decision" && spec.card.kind === "questions" && aboutThisCard && !QUOTED_ANSWER.test(event.body) && !SWITCH_ANSWERS_THESE.test(event.body)) {
      state.notices.push({ key: `hint-${spec.key}`, body: TYPE_TO_CONFIRM_HINT });
      store.writeState(this.participant, state);
    }
  }

  /** Best effort: the card is finished with whether or not Switch hears so. */
  private async closeCard(requestId: string): Promise<void> {
    await this.deps.chat.closeCard(roomSessionId(this.account.roomId), requestId).catch((error: Error) => this.deps.log(`${this.participant}: could not close a card: ${error.message}`));
  }
}

/** PLAN 11.6 step 6. Plain messages, because the missed list has no fixed length. */
export function debriefMessages(missed: { headline: string; explanation: string }[]): string[] {
  const list = missed.map((item) => `- **${item.headline}**: ${item.explanation}`);
  const lines = [DEBRIEF_THANKS, "", missed.length > 0 ? DEBRIEF_MISSED_INTRO : DEBRIEF_NONE_MISSED, ...list, "", DEBRIEF_ACKNOWLEDGE, DEBRIEF_DATA];
  const parts: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 1 > MAX_MESSAGE) {
      parts.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) parts.push(current);
  return parts;
}

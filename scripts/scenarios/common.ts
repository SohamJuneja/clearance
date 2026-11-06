/** Moves several scenarios share. They only ever wait for and read what the world really said. */
import {
  allOf,
  buttonsOf,
  hasButtons,
  type MattermostPost,
  postText,
  type PostPredicate,
  textMatches,
} from "../../eval/lib/persona.ts";
import type { AcmeRefund, AcmeState } from "../../eval/lib/world.ts";
import { ensure, type DemoContext, type Step } from "../demo/runner.ts";
import type { Person } from "../demo/person.ts";

export const CLEARANCE = "clearance";
export const CLR_ID = /CLR-\d+/;
/** Switch's answer handle for an approval card, as in `A12 yes`. */
export const HANDLE = /\bA\d+\b/;

export function clrOf(post: MattermostPost): string {
  const id = postText(post).match(CLR_ID)?.[0];
  ensure(id, `expected a CLR id in: ${postText(post).slice(0, 200)}`);
  return id;
}

export function handleOf(card: MattermostPost): string {
  const handle = postText(card).match(HANDLE)?.[0];
  ensure(handle, `expected an answer handle like A12 in: ${postText(card).slice(0, 200)}`);
  return handle;
}

/** The first post after the prompt, from the agent or Clearance, that names a held request. */
export function waitForHold(
  ctx: DemoContext,
  person: Person,
  room: string,
  agent: string,
  after: MattermostPost,
): Promise<MattermostPost> {
  return person.waitForPost(room, reportsAHold(person, agent), {
    after,
    timeoutMs: ctx.agentTimeoutMs,
    description: `${agent} or Clearance to report a hold with a CLR id`,
  });
}

/**
 * Clearance's post or the agent's own words naming a CLR id. Not a Switch status post: those quote the agent's last
 * command, and `bin/acme pending CLR-0000` is a guess at an id, not a hold.
 */
function reportsAHold(person: Person, agent: string): PostPredicate {
  const words = agentWords(person, agent);
  return allOf(textMatches(CLR_ID), async (post) => {
    if ((await person.api.authorName(post)) === CLEARANCE) return true;
    return words(post);
  });
}

/**
 * The hold, for a scene where a careful agent may ask the person before acting. If it asks, the person answers
 * once, in a line the scene names, and the wait goes on. Only the person's words are scripted, never the agent's.
 */
export async function waitForHoldAnsweringOnce(
  ctx: DemoContext,
  person: Person,
  room: string,
  agent: string,
  after: MattermostPost,
  answer: string,
): Promise<{ held: MattermostPost; answered: boolean }> {
  const isHold = reportsAHold(person, agent);
  const asked = agentAsked(person, agent);
  const first = await person.waitForPost(
    room,
    async (post) => (await isHold(post)) || (await asked(post)),
    {
      after,
      timeoutMs: ctx.agentTimeoutMs,
      description: `${agent} to ask something or report a hold with a CLR id`,
    },
  );
  if (await isHold(first)) return { held: first, answered: false };
  // What it asked can be a thread reply, which the channel doesn't show, and a person reads before answering. On camera only.
  await person.reveal(first);
  await person.readFor(READS_THE_QUESTION_MS);
  await person.closeThread();
  const said = await person.say(room, answer);
  const held = await person.waitForPost(room, isHold, {
    after: said,
    timeoutMs: ctx.agentTimeoutMs,
    description: `${agent} or Clearance to report a hold after ${person.name}'s answer`,
  });
  return { held, answered: true };
}

const ASKED = /\?|\bconfirm\b|\bwhich\b|\blet me know\b|\btell me\b|\breply\b|\bsend (?:it|me)\b/i;
/** SC3's voice-over is about this sentence: it's where the agent catches the wrong amount. */
const READS_THE_QUESTION_MS = 8_000;

/** The agent's own post waiting on someone. Reacts to whatever it says, and is never a claim about what it must say. */
export function agentAsked(person: Person, agent: string): PostPredicate {
  const words = agentWords(person, agent);
  return allOf(words, textMatches(ASKED), (post) => !hasButtons(post));
}

/**
 * A refund showing in Acme, for a scene where a careful agent may ask first. If it does, the person answers once.
 * Only the person's words are scripted, and what the refund is comes from Acme.
 */
export async function waitForRefundAnsweringOnce(
  ctx: DemoContext,
  person: Person,
  room: string,
  agent: string,
  after: MattermostPost,
  answer: string,
  before: AcmeState,
  wanted: (refund: AcmeRefund) => boolean,
  description: string,
): Promise<{ refund: AcmeRefund; answered: boolean }> {
  const asked = agentAsked(person, agent);
  const known = new Set(before.refunds.map((refund) => refund.id));
  const deadline = Date.now() + ctx.agentTimeoutMs;
  let answered = false;
  for (;;) {
    const refund = (await ctx.acme.state()).refunds.find(
      (one) => !known.has(one.id) && wanted(one),
    );
    if (refund) return { refund, answered };
    ensure(Date.now() <= deadline, `waited ${ctx.agentTimeoutMs / 1000} s for ${description}`);
    if (!answered) {
      for (const post of await person.api.recent(room, { limit: 20 })) {
        if (post.create_at > after.create_at && (await asked(post))) {
          answered = true;
          await person.say(room, answer);
          break;
        }
      }
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
}

/** The card for a request in an approver's DMs, with its answer handle. */
export async function waitForCard(
  ctx: DemoContext,
  approver: Person,
  clr: string,
  sinceMs: number,
): Promise<MattermostPost> {
  const card = await approver.waitForDm(allOf(textMatches(new RegExp(`\\b${clr}\\b`)), textMatches(HANDLE)), {
    sinceMs,
    timeoutMs: ctx.clearanceTimeoutMs,
    description: `the ${clr} card with an answer handle in ${approver.name}'s DMs`,
  });
  // Switch says this when the person has not written in that direct room. Each take's hello is there to prevent it.
  ensure(!/Nobody here is linked/.test(postText(card)), `${approver.name}'s card says nobody is linked to the agent's owner`);
  return card;
}

/**
 * The copy of the card in a room. Handles belong to a room: a real card reads `A11` in Sam's DMs and `A1` in
 * #support, so an answer typed in the room needs this copy's handle, not the approver's.
 */
export function waitForRoomCard(
  ctx: DemoContext,
  person: Person,
  room: string,
  clr: string,
  sinceMs: number,
): Promise<MattermostPost> {
  return person.waitForPost(
    room,
    allOf(
      textMatches(new RegExp(`\\b${clr}\\b`)),
      textMatches(HANDLE),
      person.api.fromAuthor(CLEARANCE),
    ),
    {
      sinceMs,
      timeoutMs: ctx.clearanceTimeoutMs,
      description: `the ${clr} card with an answer handle in #${room}`,
    },
  );
}

/** A card's button for a "no": Switch refuses `A12 no` on a questions card, which is what critical cards are. */
export const NO_BUTTON = /^(\d+\.\s*)?(deny|decline|no)\b/i;

/**
 * Answers a card the way a person does. A "no" presses the card's own No option when it has one, since that
 * works on approval and questions cards alike. Otherwise types the handle and the decision in its channel.
 */
export async function answerCard(
  approver: Person,
  card: MattermostPost,
  decision: "yes" | "no",
): Promise<MattermostPost> {
  if (decision === "no" && buttonsOf(card).some((button) => NO_BUTTON.test(button.name))) {
    await approver.press(card, NO_BUTTON);
    return card;
  }
  return approver.sayBeside(card, `${handleOf(card)} ${decision}`);
}

/**
 * Trying to approve a card. A questions card, which is what a critical card is, takes a typed value and refuses
 * `A12 yes`, so what's typed there is what the card asks for.
 */
export function tryToApprove(
  person: Person,
  card: MattermostPost,
  typedValue: string,
): Promise<MattermostPost> {
  const asksToType = /to approve, type/i.test(postText(card));
  return person.sayBeside(card, `${handleOf(card)} ${asksToType ? `"${typedValue}"` : "yes"}`);
}

/**
 * The agent's own words, not Switch's lines under its name ("Starting a session...", the Working card, a
 * redrawn native card). A step waiting for the agent to say something must not end on those.
 */
export function agentWords(person: Person, agent: string): PostPredicate {
  return allOf(person.api.fromAuthor(agent), (post) => !SWITCH_STATUS.test(post.message));
}

const SWITCH_STATUS =
  /^(@[\w.-]+\n)?(\*\*(Work|Queued|Permission|Allow|Approve|Deny|Decline|Closed)|Starting a session)/;

/** A person's message in a room saying who decided what about a request, from Clearance. */
export function waitForClearanceSays(
  ctx: DemoContext,
  person: Person,
  room: string,
  pattern: RegExp,
  sinceMs: number,
  description: string,
): Promise<MattermostPost> {
  return person.waitForPost(room, allOf(textMatches(pattern), person.api.fromAuthor(CLEARANCE)), {
    sinceMs,
    timeoutMs: ctx.clearanceTimeoutMs,
    description,
  });
}

/** Fails if the state shows a refund that wasn't there at the start of the scene. */
export function ensureNoNewRefund(before: AcmeState, now: AcmeState): void {
  const known = new Set(before.refunds.map((refund) => refund.id));
  const fresh = now.refunds.filter((refund) => !known.has(refund.id));
  ensure(
    fresh.length === 0,
    `money moved: ${fresh.map((refund) => `${refund.id} ₹${refund.amount}`).join(", ")}`,
  );
}

export const rupees = (amount: number): string => `₹${amount.toLocaleString("en-IN")}`;

/** A person's line for a promoted-agent scene. Only ever said if the agent asks. */
export const GO_AHEAD = "@refunds-agent Yes, go ahead.";

export interface PromotionState {
  startedMs?: number;
  samProposal?: MattermostPost;
  alexProposal?: MattermostPost;
}

/**
 * The promotion flow, from a seeded history to the signed ledger entry: Sam asks about the agent's autonomy, the card
 * reaches both signers, and both approve. The steps are a person's actions and what then has to be true.
 */
/** The card's replay numbers are what the promotion rests on, so they stay up long enough to read. On camera only. */
const PROPOSAL_READS_MS = 6_000;

export function promotionSteps<S extends PromotionState>(agent: string, room: string): Step<S>[] {
  const proposal = allOf(textMatches(/Proposal/), textMatches(/Replay/i));
  return [
    {
      name: `Sam asks Clearance about ${agent}'s autonomy, which prompts the proposal`,
      run: async (ctx, state) => {
        state.startedMs = Date.now();
        await ctx.people.sam.say(room, `@clearance autonomy ${agent}`);
      },
    },
    {
      name: "The promotion card with replay stats reaches Sam",
      run: async (ctx, state) => {
        state.samProposal = await ctx.people.sam.waitForDm(proposal, {
          sinceMs: state.startedMs! - 1,
          timeoutMs: ctx.clearanceTimeoutMs,
          description: "the promotion card in Sam's DMs",
        });
        await ctx.people.sam.look(state.samProposal);
      },
    },
    {
      name: "The promotion card with replay stats reaches Alex",
      run: async (ctx, state) => {
        state.alexProposal = await ctx.people.alex.waitForDm(proposal, {
          sinceMs: state.startedMs! - 1,
          timeoutMs: ctx.clearanceTimeoutMs,
          description: "the promotion card in Alex's DMs",
        });
        await ctx.people.alex.look(state.alexProposal);
        await ctx.people.alex.readFor(PROPOSAL_READS_MS);
      },
    },
    {
      name: "Sam approves the promotion",
      run: async (ctx, state) => {
        await answerCard(ctx.people.sam, state.samProposal!, "yes");
      },
    },
    {
      name: "Alex approves the promotion",
      run: async (ctx, state) => {
        await answerCard(ctx.people.alex, state.alexProposal!, "yes");
      },
    },
    {
      name: "The ledger records the signed promotion",
      run: async (ctx) => {
        await ctx.core.waitForLedger((entry) => entry.type === "promotion_signed", {
          timeoutMs: ctx.clearanceTimeoutMs,
          description: "a promotion_signed ledger entry",
        });
      },
    },
  ];
}

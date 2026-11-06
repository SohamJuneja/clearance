/** Moves several scenarios share. They only ever wait for and read what the world really said. */
import {
  allOf,
  buttonsOf,
  type MattermostPost,
  postText,
  type PostPredicate,
  textMatches,
} from "../../eval/lib/persona.ts";
import type { AcmeState } from "../../eval/lib/world.ts";
import { ensure, type DemoContext } from "../demo/runner.ts";
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
  const asked = allOf(agentWords(person, agent), textMatches(ASKED));
  const first = await person.waitForPost(room, async (post) => (await isHold(post)) || (await asked(post)), {
    after,
    timeoutMs: ctx.agentTimeoutMs,
    description: `${agent} to ask something or report a hold with a CLR id`,
  });
  if (await isHold(first)) return { held: first, answered: false };
  const said = await person.say(room, answer);
  const held = await person.waitForPost(room, isHold, {
    after: said,
    timeoutMs: ctx.agentTimeoutMs,
    description: `${agent} or Clearance to report a hold after ${person.name}'s answer`,
  });
  return { held, answered: true };
}

const ASKED = /\?|\bconfirm\b|\bwhich\b|\blet me know\b/i;

/** The card for a request in an approver's DMs, with its answer handle. */
export function waitForCard(
  ctx: DemoContext,
  approver: Person,
  clr: string,
  sinceMs: number,
): Promise<MattermostPost> {
  return approver.waitForDm(allOf(textMatches(new RegExp(`\\b${clr}\\b`)), textMatches(HANDLE)), {
    sinceMs,
    timeoutMs: ctx.clearanceTimeoutMs,
    description: `the ${clr} card with an answer handle in ${approver.name}'s DMs`,
  });
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
    allOf(textMatches(new RegExp(`\\b${clr}\\b`)), textMatches(HANDLE), person.api.fromAuthor(CLEARANCE)),
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
 * The agent's own words, not Switch's lines under its name ("Starting a session...", the Working card, a
 * redrawn native card). A step waiting for the agent to say something must not end on those.
 */
export function agentWords(person: Person, agent: string): PostPredicate {
  return allOf(person.api.fromAuthor(agent), (post) => !SWITCH_STATUS.test(post.message));
}

const SWITCH_STATUS = /^(\*\*(Work|Queued|Permission|Allow|Approve|Deny|Decline|Closed)|Starting a session)/;

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

/** Moves several scenarios share. They only ever wait for and read what the world really said. */
import { allOf, type MattermostPost, postText, textMatches } from "../../eval/lib/persona.ts";
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
  return person.waitForPost(
    room,
    allOf(textMatches(CLR_ID), async (post) => {
      const author = await person.api.authorName(post);
      return author === agent || author === CLEARANCE;
    }),
    {
      after,
      timeoutMs: ctx.agentTimeoutMs,
      description: `${agent} or Clearance to report a hold with a CLR id`,
    },
  );
}

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

/** Answers a card the way a person does: types the handle and a decision in the card's channel. */
export async function answerCard(
  approver: Person,
  card: MattermostPost,
  decision: "yes" | "no",
): Promise<MattermostPost> {
  return approver.sayBeside(card, `${handleOf(card)} ${decision}`);
}

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

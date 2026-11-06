/**
 * The two card styles the study compares (PLAN 11.2).
 *
 * Condition A is Switch's default card: the agent's own sentence as the title, the literal command
 * as the detail, and Claude Code's three buttons. It goes through the port of Switch's real renderer
 * in switch-card.ts. See the note there on why the command is not cut at 160 characters.
 *
 * Condition B is the card the product posts: core's own `renderCard` and `renderPrompt`, on content
 * core's own engine and describer produced (tools/build-sets.ts), through the same native approval
 * route, so it gets the same Switch renderer and frame as A. Critical-tier requests become a `questions`
 * card, because type-to-confirm needs a typed answer (PLAN F6). That form has no detail, so the Appendix
 * D sentence and the evidence both go in the prompt.
 *
 * One Lab adaptation: the policy line says "expires in 25 min" rather than a clock time, because
 * sessions run hours apart and a fixed time would look stale.
 */
import { renderCard as renderProductCard, renderPrompt, type CardView } from "../../packages/core/src/cards/render";
import {
  CLAUDE_APPROVAL_OPTIONS,
  MAX_DETAIL_CHARS,
  MAX_TITLE_CHARS,
  approvalContent,
  drawApprovalCard,
  drawQuestionsCard,
  reporterTruncate,
  type ApprovalOption,
  type CardQuestion,
  type Drawn,
} from "./switch-card";
import type { StudyRequest } from "./sets";

export type Condition = "A" | "B";

/** The participant is addressed on every card, the way Switch mentions the person being asked. */
const PARTICIPANT_MENTION = "@you";

const CLEARANCE_OPTIONS: ApprovalOption[] = [
  { label: "Approve", decision: "accept" },
  { label: "Deny", decision: "decline" },
];

/** The option a type-to-confirm card offers alongside the typed answer. */
const CONFIRM_NO_OPTION = { label: "No, deny", description: null };

/** Switch's form needs a title for the question. Core does not post this card yet, so this is the study's word. */
const CONFIRM_QUESTION_TITLE = "Confirm";

export type CardInput =
  | { kind: "approval"; handle: string; title: string; detail: string | null; options: ApprovalOption[]; mention: string }
  | { kind: "questions"; handle: string; title: string; question: CardQuestion; mention: string };

export type RenderedCard = Drawn & {
  condition: Condition;
  /** The display name the post appears under in the thread. */
  sender: string;
  kind: CardInput["kind"];
  /** True when the participant has to type a value to approve. */
  typeToConfirm: boolean;
};

function productView(request: StudyRequest): CardView {
  const { b } = request;
  return {
    id: b.clr,
    headline: b.headline,
    tier: b.tier.toLowerCase() as CardView["tier"],
    reversible: b.reversible,
    call: b.parsed,
    context: b.context,
    flags: b.flags,
    claim: b.claim,
    askedBy: b.asked_by,
    agent: b.agent,
    vendor: b.vendor,
    owners: b.owners,
    whyLabel: "Why you",
    why: b.why_you,
    policyLine: b.policy_line,
    expires: b.expires,
  };
}

export const clearanceTitle = (request: StudyRequest): string => renderProductCard(productView(request)).title;

/** No answer line of its own: Switch's renderer adds "Reply with `A12` ..." to every card. */
export const clearanceDetail = (request: StudyRequest): string => renderProductCard(productView(request)).detail;

/** The ask first, then the evidence. Over its budget, core gives up the agent's claim first (DECISIONS 03:25). */
export function clearancePrompt(request: StudyRequest): string {
  const ask = request.b.confirm?.question;
  if (!ask) throw new Error(`${request.id} is not a type-to-confirm card`);
  return renderPrompt(productView(request), ask);
}

/** What gets handed to Switch's renderer. Exported so the golden test feeds the real one the same. */
export function cardInput(request: StudyRequest, condition: Condition): CardInput {
  const { b, a } = request;
  const mention = PARTICIPANT_MENTION;
  if (condition === "A") {
    const content = approvalContent("Bash", { command: a.command, description: a.description }, undefined, a.description);
    return {
      kind: "approval",
      handle: b.handle,
      title: reporterTruncate(content.title, MAX_TITLE_CHARS),
      detail: reporterTruncate(content.detail, MAX_DETAIL_CHARS),
      options: CLAUDE_APPROVAL_OPTIONS,
      mention,
    };
  }
  const title = clearanceTitle(request);
  if (b.confirm) {
    return {
      kind: "questions",
      handle: b.handle,
      title,
      mention,
      question: { title: CONFIRM_QUESTION_TITLE, prompt: clearancePrompt(request), options: [CONFIRM_NO_OPTION], multiSelect: false, allowCustomAnswer: true },
    };
  }
  return { kind: "approval", handle: b.handle, title, detail: clearanceDetail(request), options: CLEARANCE_OPTIONS, mention };
}

export function drawInput(input: CardInput): Drawn {
  return input.kind === "approval" ? drawApprovalCard(input) : drawQuestionsCard(input);
}

export function renderCard(request: StudyRequest, condition: Condition): RenderedCard {
  const input = cardInput(request, condition);
  return {
    ...drawInput(input),
    condition,
    sender: condition === "A" ? request.a.agent : "clearance",
    kind: input.kind,
    typeToConfirm: input.kind === "questions",
  };
}

/** What the buttons on a card mean for scoring. Both Allow options approve the request. */
export function buttonDecision(label: string): "approve" | "deny" {
  if (label === "Allow once" || label === "Allow for this session" || label === "Approve") return "approve";
  if (label === "Decline" || label === "Deny" || label === CONFIRM_NO_OPTION.label) return "deny";
  throw new Error(`unknown card button: ${label}`);
}

/**
 * The value out of whatever a person typed. The card teaches `A106 "kfin"`, so someone careful types all of it, and
 * a phone turns the straight quotes curly. None of that is a wrong answer.
 */
function typedValueOnly(typed: string): string {
  const withoutCode = typed.trim().replace(/^(?:<handle>|A\d+)(?=[\s"'“‘])\s*/i, "");
  const quoted = /^["'“‘](.*)["'”’]$/su.exec(withoutCode);
  return (quoted ? quoted[1]! : withoutCode).trim();
}

/** Type-to-confirm comparison. Forgiving about format ("₹38,000"), strict about the value. */
export function confirmMatches(field: NonNullable<StudyRequest["b"]["confirm"]>["field"], expected: string, typed: string): boolean {
  const value = typedValueOnly(typed);
  if (field === "amount") return value.replace(/[₹,\s]|rs\.?|inr/gi, "") === expected;
  return value.toLowerCase() === expected.toLowerCase();
}

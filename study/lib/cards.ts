/**
 * The two card styles the study compares (PLAN 11.2).
 *
 * Condition A is Switch's default card: the agent's own sentence as the title, the literal command
 * as the detail, and Claude Code's three buttons. It goes through the port of Switch's real renderer
 * in switch-card.ts. See the note there on why the command is not cut at 160 characters.
 *
 * Condition B is the card the product posts: PLAN Appendix D, in the shape of core's `renderCard` and
 * `renderPrompt`, through the same native approval route, so it gets the same renderer and frame.
 * Critical-tier requests become a `questions` card, because type-to-confirm needs a typed answer (PLAN
 * F6). That form has no detail, so the Appendix D sentence and the evidence both go in the prompt.
 *
 * One Lab adaptation: the policy line says "expires in 25 min" rather than a clock time, because
 * sessions run hours apart and a fixed time would look stale.
 */
import {
  CLAUDE_APPROVAL_OPTIONS,
  MAX_DETAIL_CHARS,
  MAX_TITLE_CHARS,
  approvalContent,
  drawApprovalCard,
  drawQuestionsCard,
  mattermostEscape,
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
const CONFIRM_NO_OPTION = { label: "No", description: null };

/** Switch's form needs a title for the question. Core does not post this card yet, so this is the study's word. */
const CONFIRM_QUESTION_TITLE = "Confirm";

/** DECISIONS 03:25. A questions card has no detail, so the evidence has this much room in the prompt. */
const PROMPT_BUDGET = 790;

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

export function clearanceTitle(request: StudyRequest): string {
  const { clr, headline, tier, reversibility } = request.b;
  return `${clr} · ${headline} · ${tier} · ${reversibility}`;
}

const indented = (lines: string[]) => lines.map((line) => `  ${line}`);

/**
 * The evidence, in the fixed order PLAN F6 tests: call, context, flags, claim, who and why. Same shape
 * as `assembleDetail` in packages/core/src/cards/render.ts: a section with nothing in it is left out.
 */
export function clearanceEvidence(request: StudyRequest, options: { claim: boolean } = { claim: true }): string {
  const { b } = request;
  const sections = [["The call (parsed from what the agent ran, not from its words)", ...indented(b.parsed)].join("\n")];
  if (b.context.length > 0) sections.push(["Context", ...indented(b.context)].join("\n"));
  if (b.flags.length > 0) sections.push(["Flags", ...b.flags.map((flag) => `  ⚠ ${flag}`)].join("\n"));
  if (options.claim) sections.push(`Agent's claim (unverified): "${b.claim}"`);
  sections.push([b.asked_by, `Why you: ${b.why_you}`, `Policy: ${b.policy}`].join("\n"));
  return sections.join("\n\n");
}

/** No answer line of its own: Switch's renderer adds "Reply with `A12` ..." to every card. */
export function clearanceDetail(request: StudyRequest): string {
  return `${clearanceEvidence(request)}\n\n@clearance why ${request.b.clr}`;
}

/**
 * The type-to-confirm prompt, as `renderPrompt` in packages/core/src/cards/render.ts builds it: the ask
 * first, then the evidence. Over budget, the agent's claim is given up first (DECISIONS 03:25).
 */
export function clearancePrompt(request: StudyRequest): string {
  const ask = request.b.confirm?.question;
  if (!ask) throw new Error(`${request.id} is not a type-to-confirm card`);
  const whole = `${ask}\n\n${clearanceEvidence(request)}`;
  return Array.from(mattermostEscape(whole)).length <= PROMPT_BUDGET ? whole : `${ask}\n\n${clearanceEvidence(request, { claim: false })}`;
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

/** Type-to-confirm comparison. Forgiving about format ("₹38,000"), strict about the value. */
export function confirmMatches(field: NonNullable<StudyRequest["b"]["confirm"]>["field"], expected: string, typed: string): boolean {
  const value = typed.trim();
  if (field === "amount") return value.replace(/[₹,\s]|rs\.?|inr/gi, "") === expected;
  return value.toLowerCase() === expected.toLowerCase();
}

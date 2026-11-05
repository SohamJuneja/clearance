/**
 * The two card styles the study compares (PLAN 11.2).
 *
 * Condition A is Switch's default card: the agent's own sentence as the title, the literal command
 * as the detail, and Claude Code's three buttons. It goes through the port of Switch's real renderer
 * in switch-card.ts. See the note there on why the command is not cut at 160 characters.
 *
 * Condition B is the Clearance card from PLAN Appendix D, posted through the same native approval
 * route, so it goes through the same renderer and gets the same frame. Critical-tier requests become
 * a `questions` card, because type-to-confirm needs a typed answer (PLAN F6). That form has no detail
 * and a prompt budget of 800 characters, so the evidence goes in the prompt and the Appendix D
 * sentence in the question's title.
 */
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
const CONFIRM_NO_OPTION = { label: "No", description: null };

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

/** The evidence, in the fixed order PLAN F6 tests: call, context, flags, claim, who and why. */
export function clearanceEvidence(request: StudyRequest): string {
  const { b } = request;
  return [
    "The call (parsed from what the agent ran, not from its words)",
    ...indented(b.parsed),
    "",
    "Context",
    ...indented(b.context),
    "",
    "Flags",
    ...indented(b.flags.length > 0 ? b.flags.map((flag) => `⚠ ${flag}`) : ["None"]),
    "",
    `Agent's claim (unverified): "${b.claim}"`,
    "",
    b.asked_by,
    `Why you: ${b.why_you}`,
    `Policy: ${b.policy}`,
  ].join("\n");
}

export function clearanceDetail(request: StudyRequest): string {
  const { handle } = request.b;
  return `${clearanceEvidence(request)}\n\nReply ${handle} yes or ${handle} no · @clearance why ${handle}`;
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
      question: { title: b.confirm.question, prompt: clearanceEvidence(request), options: [CONFIRM_NO_OPTION], multiSelect: false, allowCustomAnswer: true },
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

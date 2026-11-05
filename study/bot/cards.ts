/**
 * The study's cards as they go to Switch's approvals route. The words come from `cardInput` in
 * study/lib/cards.ts, the same function the Lab draws from, so both platforms show the card the product
 * posts. This only adds what a real card needs:
 *
 * - Ids for the options, which is what `approval_outcome` answers with.
 * - On a type-to-confirm card, how to type a value. Switch's grammar needs quotes, and its own footer
 *   suggests `A19 1`, which picks No. It goes in the question's title, which has room to spare, so the
 *   prompt stays exactly what the Lab shows.
 * - A check before anything is posted. Over budget Switch removes the buttons and says the card can't be
 *   answered from chat, so the bot refuses to start rather than show someone that (DECISIONS: detail 990,
 *   prompt 790). Those budgets hold only on a card that names someone, which every card here does.
 */
import type { CardOption, CardQuestion, OpenCardInput } from "../../packages/contracts/src/index";
import { cardInput, drawInput, type Condition } from "../lib/cards";
import { TYPE_TO_CONFIRM_HOW } from "../lib/materials";
import type { Sets } from "../lib/protocol";
import type { StudyRequest } from "../lib/sets";
import { mattermostEscape } from "../lib/switch-card";

export const DETAIL_BUDGET = 990;
export const PROMPT_BUDGET = 790;

/** The longest mention a card can carry in this study, for checking the budget it leaves. */
const LONGEST_MENTION = "@p99";

export type LiveCard = Pick<OpenCardInput, "kind" | "title" | "detail" | "options" | "questions">;

/** Characters as Switch counts them: code points, with the zero-width spaces it adds to prose. */
export const budgetLength = (text: string) => Array.from(mattermostEscape(text)).length;

const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** A decision card, in the style of the condition. */
export function decisionCard(request: StudyRequest, condition: Condition): LiveCard {
  const input = cardInput(request, condition);
  if (input.kind === "questions") {
    const question: CardQuestion = {
      id: "confirm",
      title: `${input.question.title}: ${TYPE_TO_CONFIRM_HOW}`,
      prompt: input.question.prompt,
      options: input.question.options.map((option) => ({ id: slug(option.label), label: option.label, description: option.description ?? undefined })),
      multiSelect: false,
      allowCustomAnswer: true,
    };
    return { kind: "questions", title: input.title, detail: "", options: [], questions: [question] };
  }
  const options: CardOption[] = input.options.map((option) => ({ id: slug(option.label), label: option.label, decision: option.decision }));
  return { kind: "approval", title: input.title, detail: input.detail ?? "", options, questions: [] };
}

/** A one-question card: consent, the briefing, a rating, the comment. Buttons need a single question. */
export function questionCard(input: { title: string; question: string; prompt: string; options: string[]; allowCustomAnswer?: boolean }): LiveCard {
  return {
    kind: "questions",
    title: input.title,
    detail: "",
    options: [],
    questions: [
      {
        id: "answer",
        title: input.question,
        prompt: input.prompt,
        options: input.options.map((label) => ({ id: slug(label), label })),
        multiSelect: false,
        allowCustomAnswer: input.allowCustomAnswer ?? false,
      },
    ],
  };
}

/** The label of the option an id belongs to. */
export function labelOf(card: LiveCard, optionId: string): string | undefined {
  const options = card.kind === "approval" ? card.options : (card.questions[0]?.options ?? []);
  return options.find((option) => option.id === optionId)?.label;
}

/** What is wrong with a card: over budget, or something Switch would draw with no buttons. Null if fine. */
export function cardProblem(card: LiveCard): string | null {
  if (budgetLength(card.detail) > DETAIL_BUDGET) return `"${card.title}" has a detail of ${budgetLength(card.detail)} characters, over the ${DETAIL_BUDGET} budget`;
  const prompt = card.questions[0]?.prompt ?? "";
  if (budgetLength(prompt) > PROMPT_BUDGET) return `"${card.title}" has a prompt of ${budgetLength(prompt)} characters, over the ${PROMPT_BUDGET} budget`;

  const handle = "A999";
  const drawn =
    card.kind === "approval"
      ? drawInput({
          kind: "approval",
          handle,
          title: card.title,
          detail: card.detail || null,
          options: card.options.map((option) => ({ label: option.label, decision: option.decision ?? "cancel" })),
          mention: LONGEST_MENTION,
        })
      : drawInput({
          kind: "questions",
          handle,
          title: card.title,
          mention: LONGEST_MENTION,
          question: {
            title: card.questions[0]!.title,
            prompt,
            options: card.questions[0]!.options.map((option) => ({ label: option.label, description: option.description ?? null })),
            multiSelect: false,
            allowCustomAnswer: card.questions[0]!.allowCustomAnswer,
          },
        });
  if (!drawn.answerable) return `"${card.title}" would not be answerable from chat`;
  const wanted = card.kind === "approval" ? card.options.length : (card.questions[0]?.options.length ?? 0);
  if (drawn.buttons.length !== wanted) return `"${card.title}" would draw ${drawn.buttons.length} buttons, not ${wanted}`;
  return null;
}

/** Every card in the study, in both styles, checked before anyone sees one. */
export function preflight(sets: Sets): void {
  const problems: string[] = [];
  for (const request of [...sets.practice, ...sets.X, ...sets.Y]) {
    for (const condition of ["A", "B"] as const) {
      const problem = cardProblem(decisionCard(request, condition));
      if (problem) problems.push(`${request.id} in ${condition}: ${problem}`);
    }
  }
  if (problems.length > 0) throw new Error(`study cards would lose their buttons:\n${problems.join("\n")}`);
}

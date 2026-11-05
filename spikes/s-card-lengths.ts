/** How close the study's real cards come to the budgets, and what an open type-to-confirm card reads like. */
import { drawInput } from "../study/lib/cards";
import { loadSet } from "../study/lib/sets";
import { DETAIL_BUDGET, PROMPT_BUDGET, budgetLength, decisionCard } from "../study/bot/cards";

const requests = [...loadSet("practice").requests, ...loadSet("X").requests, ...loadSet("Y").requests];
let longestDetail = 0;
let longestPrompt = 0;
let longestCommand = 0;
const noClaim: string[] = [];
for (const request of requests) {
  longestCommand = Math.max(longestCommand, budgetLength(decisionCard(request, "A").detail));
  const card = decisionCard(request, "B");
  if (card.kind === "approval") {
    longestDetail = Math.max(longestDetail, budgetLength(card.detail));
    if (!card.detail.includes("Agent's claim")) noClaim.push(request.id);
  } else {
    longestPrompt = Math.max(longestPrompt, budgetLength(card.questions[0]!.prompt));
    if (!card.questions[0]!.prompt.includes("Agent's claim")) noClaim.push(request.id);
  }
}
process.stdout.write(`longest A detail (the command): ${longestCommand} of ${DETAIL_BUDGET}\n`);
process.stdout.write(`longest B detail: ${longestDetail} of ${DETAIL_BUDGET}\n`);
process.stdout.write(`longest B prompt: ${longestPrompt} of ${PROMPT_BUDGET}\n`);
process.stdout.write(`B cards that give up the agent's claim, as core's rule says and the Lab does too: ${JSON.stringify(noClaim)}\n`);

const critical = requests.find((request) => request.b.confirm)!;
const card = decisionCard(critical, "B");
const question = card.questions[0]!;
const drawn = drawInput({
  kind: "questions",
  handle: "A21",
  title: card.title,
  mention: "@p01",
  question: { title: question.title, prompt: question.prompt, options: question.options.map((option) => ({ label: option.label, description: null })), multiSelect: false, allowCustomAnswer: true },
});
process.stdout.write(`\nAn open type-to-confirm card, as drawn:\n${drawn.text}\nbuttons: ${JSON.stringify(drawn.buttons)}\n`);

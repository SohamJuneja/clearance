/**
 * The study's cards as they go to the real approvals route, held to Mattermost's limits (DECISIONS:
 * detail 990, question prompt 790). Over a limit Switch removes the buttons, so these are the tests
 * that stop a participant being shown a card they cannot answer. Live numbers behind them are in
 * spikes/s-study-card-probe.ts: with a mention the buttons last to a detail of 998 characters.
 */
import { describe, expect, it } from "vitest";
import { cardInput } from "../lib/cards";
import type { Sets } from "../lib/protocol";
import { loadSet, type StudyRequest } from "../lib/sets";
import { DETAIL_BUDGET, PROMPT_BUDGET, budgetLength, cardProblem, decisionCard, preflight, questionCard, type LiveCard } from "../bot/cards";
import { CONSENT, CONSENT_AGREE, CONSENT_DECLINE, BRIEFING, BRIEFING_START, FAMILIARITY_QUESTION, FREE_TEXT_QUESTION, ROLE_OPTIONS } from "../lib/materials";

const sets: Sets = { X: loadSet("X").requests, Y: loadSet("Y").requests, practice: loadSet("practice").requests };
const all = [...sets.practice, ...sets.X, ...sets.Y];

/** A real request padded out past what a card can hold. */
const bloated = (extra: Partial<StudyRequest["b"]>): StudyRequest => {
  const request = all.find((entry) => !entry.b.confirm)!;
  return { ...request, b: { ...request.b, ...extra } };
};

describe("every card in the study", () => {
  it.each(all.flatMap((request) => [{ id: request.id, request, condition: "A" as const }, { id: request.id, request, condition: "B" as const }]))(
    "$id in condition $condition stays within budget and keeps its buttons",
    ({ request, condition }) => {
      const card = decisionCard(request, condition);
      expect(cardProblem(card)).toBeNull();
      if (card.kind === "approval") expect(budgetLength(card.detail)).toBeLessThanOrEqual(DETAIL_BUDGET);
      else expect(budgetLength(card.questions[0]!.prompt)).toBeLessThanOrEqual(PROMPT_BUDGET);
    },
  );

  it("passes the check the bot runs before it posts anything", () => {
    expect(() => preflight(sets)).not.toThrow();
  });

  it("refuses to start if any card would lose its buttons", () => {
    // Condition A shows the command whole, as Switch does, so a very long command still breaks a card.
    const request = all.find((entry) => !entry.b.confirm)!;
    const hopeless = { ...request, a: { ...request.a, command: `curl ${"x".repeat(2000)}` } };
    expect(() => preflight({ ...sets, X: [hopeless] })).toThrow("lose their buttons");
  });

  it("condition B keeps its buttons however long its values are, because core's renderer clips to budget", () => {
    const long = bloated({ parsed: ["p".repeat(2000)], context: ["c".repeat(2000)], flags: ["f".repeat(2000)], claim: "a".repeat(2000) });
    const card = decisionCard(long, "B");
    expect(cardProblem(card)).toBeNull();
    expect(card.kind === "approval" && budgetLength(card.detail)).toBeLessThanOrEqual(DETAIL_BUDGET);
  });
});

describe("condition A, Switch's own card", () => {
  const request = sets.X[0]!;
  const card = decisionCard(request, "A");

  it("has the agent's words as the title, the whole command as the detail, and Claude Code's buttons", () => {
    expect(card.kind).toBe("approval");
    expect(card.title).toBe(request.a.description);
    expect(card.detail).toBe(request.a.command);
    expect(card.options).toEqual([
      { id: "allow-once", label: "Allow once", decision: "accept" },
      { id: "allow-for-this-session", label: "Allow for this session", decision: "acceptForSession" },
      { id: "decline", label: "Decline", decision: "decline" },
    ]);
  });

  it("is an approval card even for a critical request: Switch has no type-to-confirm", () => {
    const critical = all.find((entry) => entry.b.confirm)!;
    expect(decisionCard(critical, "A").kind).toBe("approval");
  });
});

describe("condition B, the card the product posts", () => {
  const legit = all.find((request) => !request.b.confirm)!;
  const card = decisionCard(legit, "B");

  it("has Approve and Deny", () => {
    expect(card.options.map((option) => [option.label, option.decision])).toEqual([
      ["Approve", "accept"],
      ["Deny", "decline"],
    ]);
  });

  it("asks a critical request as a typed question, and says how", () => {
    const critical = all.find((request) => request.b.confirm)!;
    const typed = decisionCard(critical, "B");
    expect(typed.kind).toBe("questions");
    expect(typed.options).toEqual([]);
    expect(typed.detail).toBe("");
    const question = typed.questions[0]!;
    expect(question.allowCustomAnswer).toBe(true);
    expect(question.multiSelect).toBe(false);
    expect(question.options.map((option) => option.label)).toEqual(["No"]);
    expect(question.title).toContain("in quotes");
    expect(question.prompt.startsWith(critical.b.confirm!.question)).toBe(true);
    for (const line of critical.b.parsed) expect(question.prompt).toContain(line);
    for (const flag of critical.b.flags) expect(question.prompt).toContain(flag);
  });
});

describe("the two platforms", () => {
  it.each(all.flatMap((request) => [{ id: request.id, request, condition: "A" as const }, { id: request.id, request, condition: "B" as const }]))(
    "$id in condition $condition shows the same words as the Lab",
    ({ request, condition }) => {
      const lab = cardInput(request, condition);
      const live = decisionCard(request, condition);
      expect(live.title).toBe(lab.title);
      if (lab.kind === "approval") {
        expect(live.detail).toBe(lab.detail);
        expect(live.options.map((option) => option.label)).toEqual(lab.options.map((option) => option.label));
      } else {
        expect(live.questions[0]!.prompt).toBe(lab.question.prompt);
        expect(live.questions[0]!.options.map((option) => option.label)).toEqual(lab.question.options.map((option) => option.label));
      }
    },
  );
});

describe("the budgets", () => {
  const approval = (detail: string): LiveCard => ({ kind: "approval", title: "t", detail, options: [{ id: "a", label: "Approve", decision: "accept" }], questions: [] });
  const lines = (length: number) => Array.from({ length: 30 }, () => "x".repeat(39)).join("\n").slice(0, length);

  it("accepts a detail up to the budget and refuses one past it", () => {
    expect(cardProblem(approval(lines(DETAIL_BUDGET)))).toBeNull();
    expect(cardProblem(approval(lines(DETAIL_BUDGET + 1)))).toContain("over the 990 budget");
  });

  it("accepts a prompt up to the budget and refuses one past it", () => {
    const question = (prompt: string) => questionCard({ title: "t", question: "q", prompt, options: ["Yes"] });
    expect(cardProblem(question("x".repeat(PROMPT_BUDGET)))).toBeNull();
    expect(cardProblem(question("x".repeat(PROMPT_BUDGET + 1)))).toContain("over the 790 budget");
  });

  it("counts what Switch counts: the zero-width space it puts after each @ and ]", () => {
    expect(budgetLength("meera.k@okaxis")).toBe("meera.k@okaxis".length + 1);
    expect(budgetLength("a]b")).toBe(4);
    // Code points, as Python counts them, not UTF-16 units.
    expect(budgetLength("⚠₹")).toBe(2);
    expect(budgetLength("😀")).toBe(1);
  });

  it("refuses a detail that fits until the @ signs are counted", () => {
    const text = `${"@".repeat(500)}${"x".repeat(490)}`;
    expect(text.length).toBeLessThanOrEqual(DETAIL_BUDGET);
    expect(cardProblem(approval(text))).toContain("over the 990 budget");
  });
});

describe("the other cards", () => {
  it.each([
    ["consent", { title: "Before we start", question: "Do you agree to take part?", prompt: CONSENT, options: [CONSENT_AGREE, CONSENT_DECLINE] }],
    ["role", { title: "About you", question: "Which describes you best?", prompt: "", options: [...ROLE_OPTIONS] }],
    ["familiarity", { title: "About you", question: FAMILIARITY_QUESTION, prompt: "", options: ["1", "2", "3", "4", "5"] }],
    ["briefing", { title: "Your task", question: "When you're ready", prompt: BRIEFING, options: [BRIEFING_START] }],
    ["comment", { title: "One last question", question: FREE_TEXT_QUESTION, prompt: "Type your answer.", options: ["No comment"], allowCustomAnswer: true }],
  ])("%s keeps its buttons", (_name, input) => {
    const card = questionCard(input);
    expect(cardProblem(card)).toBeNull();
    expect(budgetLength(card.questions[0]!.prompt)).toBeLessThanOrEqual(PROMPT_BUDGET);
  });
});

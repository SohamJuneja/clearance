/**
 * The inputs both renderers are compared on: every study card in both conditions, plus boundary
 * vectors around the limits that matter. Used by `pnpm study:golden` (real Switch renderer) and by
 * test/switch-golden.test.ts (the TypeScript port).
 *
 * The boundary vectors are made-up strings, not study content.
 */
import { CLAUDE_APPROVAL_OPTIONS, type ApprovalOption, type CardQuestion } from "../lib/switch-card";
import { cardInput, type CardInput } from "../lib/cards";
import { loadSet } from "../lib/sets";

export type GoldenCase = { name: string; input: CardInput };

const OPTIONS = CLAUDE_APPROVAL_OPTIONS;
const mention = "@you";

const approval = (name: string, title: string, detail: string | null, options: ApprovalOption[] = OPTIONS, withMention = true): GoldenCase => ({
  name,
  input: { kind: "approval", handle: "A42", title, detail, options, mention: withMention ? mention : "" },
});

const questions = (name: string, prompt: string, extra: Partial<CardQuestion> = {}, title = "CLR-0051 · REFUND ₹85,000 · CRITICAL · irreversible"): GoldenCase => ({
  name,
  input: {
    kind: "questions",
    handle: "A43",
    title,
    mention,
    question: { title: "Confirm", prompt, options: [{ label: "No", description: null }], multiSelect: false, allowCustomAnswer: true, ...extra },
  },
});

const command = (length: number) => `curl ${"x".repeat(length - 5)}`;

const boundary: GoldenCase[] = [
  approval("command 40 chars", "Refund the order", "acme refund --order A-1 --amount 4000 x"),
  // The 160 claim in the plan: all of these must come through whole on Mattermost.
  approval("command 159 chars", "Refund the order", command(159)),
  approval("command 160 chars", "Refund the order", command(160)),
  approval("command 161 chars", "Refund the order", command(161)),
  approval("command 200 chars", "Refund the order", command(200)),
  // Where the real budget falls. With a mention line the limit is 3995, so the budget is 998.
  approval("detail 997 with mention", "t", command(997)),
  approval("detail 998 with mention", "t", command(998)),
  approval("detail 999 with mention", "t", command(999)),
  approval("detail 1000 without mention", "t", command(1000), OPTIONS, false),
  approval("detail 1001 without mention", "t", command(1001), OPTIONS, false),
  approval("detail 1500 cut mid-way", "t", command(1500)),
  // Multi-line is prose: no code span, and escapes count against the budget.
  approval("multiline short", "t", "line one\n  line two"),
  approval("multiline with @ under budget", "t", `a@b\n${"y".repeat(990)}`),
  approval("multiline pushed over budget by @", "t", `${"@".repeat(500)}\n${"y".repeat(400)}`),
  // Escapes and markup.
  approval("title with mention and link", "Pay @someone [click](http://x.example)", "acme x"),
  approval("command with @ stays literal", "t", "acme refund --dest meera.k@okaxis"),
  approval("command with backticks", "t", "echo `date` and ``nested``"),
  approval("command starting with backtick", "t", "`date`"),
  approval("title with astral characters", "Refund 🎉🎉 now", "acme x"),
  approval("no detail", "Just a title", null),
  // Options.
  approval("option without session wording keeps its line", "t", "acme x", [
    { label: "Allow", decision: "accept" },
    { label: "Always allow", decision: "acceptForSession" },
    { label: "Decline", decision: "decline" },
  ]),
  approval("option label over the button limit keeps its line", "t", "acme x", [
    { label: "z".repeat(77), decision: "accept" },
    { label: "Decline", decision: "decline" },
  ]),
  approval("approval with no options", "t", "acme x", []),
  approval("options that overflow the post", "t", "acme x", Array.from({ length: 12 }, (_, i) => ({ label: `${i} ${"w".repeat(600)}`, decision: "accept" as const }))),
  approval("title over its budget", "t".repeat(1400), "acme x"),
  // Questions: the prompt budget is 800, and the form has no detail.
  questions("questions short", "CLR-0051 is high risk. To approve, type the refund amount in rupees, in quotes, after the request code. Or choose No, deny."),
  questions("prompt 800", "p".repeat(800)),
  questions("prompt 801", "p".repeat(801)),
  questions("prompt pushed over budget by @", `${"@".repeat(400)}${"p".repeat(1)}`),
  questions("multiline prompt", "line one\n  line two @x"),
  questions("questions with no options", "free text only", { options: [] }),
  questions("questions nothing to answer", "stuck", { options: [], allowCustomAnswer: false }),
  questions("option with description", "pick", { options: [{ label: "No", description: "Refuse this" }] }),
  questions("two options", "pick", { options: [{ label: "A", description: null }, { label: "B", description: null }] }),
  questions("multi select", "pick", { multiSelect: true, options: [{ label: "A", description: null }, { label: "B", description: null }] }),
  questions("question without title", "pick", { title: "" }),
];

export function goldenCases(): GoldenCase[] {
  const studyCases: GoldenCase[] = [];
  for (const name of ["X", "Y", "practice"] as const) {
    for (const request of loadSet(name).requests) {
      for (const condition of ["A", "B"] as const) {
        studyCases.push({ name: `${request.id} ${condition}`, input: cardInput(request, condition) });
      }
    }
  }
  return [...studyCases, ...boundary];
}

if (process.argv[1]?.endsWith("golden-inputs.ts")) {
  process.stdout.write(JSON.stringify(goldenCases(), null, 2));
}

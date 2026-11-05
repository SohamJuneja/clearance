/**
 * A TypeScript port of how Switch draws an approval card on Mattermost, so the study's replicas say
 * exactly what the real cards say. Reproduces, at Switch commit 1fe56227b6e330452ac80d7b7b2ca0a66aaeaeab:
 *
 *   console/packages/agent-providers/src/claude/claude-mapping.ts   approvalContent
 *   console/packages/agent-providers/src/host/activity-reporter.ts  title <= 500, detail <= 4000
 *   core/switch_core/bridges/collaboration/session/renderers/neutral.py  render_request, _compose, _fit
 *   core/switch_core/bridges/collaboration/mattermost/adapter.py    _draw, _MAX_POST, _rich_escape
 *
 * test/switch-golden.test.ts compares this port with the output of the real Python renderer.
 *
 * Note on length limits: PLAN 1.2 and 11.2 say the command in `detail` is cut at 160 characters, but
 * at the pinned commit it is not. `truncate(_, 160)` in claude-mapping.ts only serves `toolTitle`, the
 * activity row title. `approvalContent` passes the command through whole, and Switch's own test
 * "does not cut the decision context before anything has budgeted it" pins that down. The limit that
 * does exist on Mattermost is a budget of about 1000 characters, and going over it is not a trim:
 * the card stops being answerable from chat at all.
 */

const ZERO_WIDTH_SPACE = "​";

/** Mattermost's default MaxPostSize, which Switch cuts every post to fit (`_MAX_POST`). */
export const MATTERMOST_MAX_POST = 4000;
/** `MAX_BUTTON_LABEL` in mattermost/callback.py. */
export const MAX_BUTTON_LABEL = 76;
/** `MAX_TITLE` and `MAX_DETAIL` in activity-reporter.ts; `ApprovalOpen` enforces the same limits. */
export const MAX_TITLE_CHARS = 500;
export const MAX_DETAIL_CHARS = 4000;

const TOO_BIG = "Too long to show in full here, so it cannot be answered from this message. Open in Switch Console to read and answer it.";
const NO_OPTIONS = "This card cannot be answered: it offers no options.";
const NOTHING_TO_ANSWER = "This card cannot be answered: nothing to choose, and no written answer allowed.";
const CUT_NOTICE = (left: number) => `…${left} more not shown.`;
const FOR_SESSION = " (applies for the rest of this session)";
const LABELS_STATING_THE_SESSION = new Set([
  "allow for this session",
  "approve for this session",
  "allow for the rest of this session",
]);

/** Python's len() and slicing count code points; JS strings count UTF-16 units. */
const chars = (text: string) => Array.from(text);
const len = (text: string) => chars(text).length;

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type ApprovalOption = { label: string; decision: ApprovalDecision };
export type QuestionOption = { label: string; description: string | null };
export type CardQuestion = {
  title: string;
  prompt: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowCustomAnswer: boolean;
};

export type Drawn = {
  /** The whole post body, as Mattermost would receive it. */
  text: string;
  /** False means Switch offers no buttons and tells the reader to go to Switch Console. */
  answerable: boolean;
  /** The buttons Mattermost draws under the post, in order. */
  buttons: string[];
};

// ── claude-mapping.ts ────────────────────────────────────────────────────────

const COMMAND_TOOLS = new Set(["Bash", "BashOutput", "KillShell", "KillBash"]);

/** Claude's permission options (`APPROVAL_OPTIONS` in claude-adapter.ts). */
export const CLAUDE_APPROVAL_OPTIONS: ApprovalOption[] = [
  { label: "Allow once", decision: "accept" },
  { label: "Allow for this session", decision: "acceptForSession" },
  { label: "Decline", decision: "decline" },
];

/**
 * `approvalContent` for a command tool: the agent's prose is the title and the literal command is
 * the detail. Only the command path is ported because every study request is a command; anything
 * else throws rather than rendering something Switch would not.
 */
export function approvalContent(
  toolName: string,
  input: { command: string; description?: string },
  title: string | undefined,
  description: string | undefined,
): { title: string; detail: string } {
  if (!COMMAND_TOOLS.has(toolName) || !input.command) {
    throw new Error(`study cards only port the command path of approvalContent, got ${toolName}`);
  }
  const summary = description ?? (input.description || undefined);
  const prose = [...new Set([title, summary].filter((part): part is string => part !== undefined))];
  return {
    title: prose.length > 0 ? prose.join(" — ") : `Run a ${toolName} command`,
    detail: input.command,
  };
}

/** `truncate` in activity-reporter.ts, the cut applied on the way to Switch. */
export function reporterTruncate(text: string, limit: number): string {
  const characters = chars(text);
  return characters.length <= limit ? text : `${characters.slice(0, limit - 1).join("")}…`;
}

// ── mattermost/adapter.py ────────────────────────────────────────────────────

/**
 * `_rich_escape` on Mattermost: defuse_label_markup, then the outbound translation. The reader never
 * sees these zero-width spaces, but they count against the budget, so a UPI ID in a card's prose
 * costs one more character than it looks like.
 */
export function mattermostEscape(text: string): string {
  return text
    .replaceAll("@", `@${ZERO_WIDTH_SPACE}`)
    .replaceAll("]", `]${ZERO_WIDTH_SPACE}`)
    .replace(/@(\w+):\S+/gu, "@$1");
}

// ── neutral.py ───────────────────────────────────────────────────────────────

const pyFloorDiv = (a: number, b: number) => Math.floor(a / b);
const share = (limit: number, most: number, denominator: number) => Math.max(1, Math.min(most, pyFloorDiv(limit, denominator)));
const labelBudget = (limit: number) => share(limit, 1500, 3);

/** `_share(limit, 1200, 4)`: the most a detail can be before the card stops being answerable. */
export const detailBudget = (limit: number) => share(limit, 1200, 4);
/** `_share(limit, 800, 4)`: the same for a question's prompt. */
export const promptBudget = (limit: number) => share(limit, 800, 4);

function truncateLine(text: string, limit: number): string {
  if (len(text) <= limit) return text;
  if (limit <= 1) return chars(text).slice(0, limit).join("");
  return `${chars(text)
    .slice(0, limit - 1)
    .join("")
    .trimEnd()}…`;
}

function fit(text: string, limit: number, escape: (t: string) => string): string {
  const escaped = escape(text);
  if (len(escaped) <= limit) return escaped;
  const source = chars(text);
  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = pyFloorDiv(low + high + 1, 2);
    if (len(escape(source.slice(0, middle).join(""))) + 1 <= limit) low = middle;
    else high = middle - 1;
  }
  return `${escape(source.slice(0, low).join(""))}…`;
}

class Faithful {
  whole = true;
  constructor(private readonly proseEscape: (t: string) => string) {}
  call(text: string, limit: number, escape?: (t: string) => string): string {
    const spell = escape ?? this.proseEscape;
    this.whole = this.whole && len(spell(text)) <= limit;
    return fit(text, limit, spell);
  }
}

function compose(head: string[], body: string[], footer: string, limit: number, ifCut: string): { text: string; cut: boolean } {
  const foot = truncateLine(footer, limit);
  const whenCut = truncateLine(ifCut, limit);
  let spent = Math.max(len(foot), len(whenCut));
  const lines: string[] = [];
  for (const line of head) {
    if (spent + len(line) + 1 > limit) break;
    lines.push(line);
    spent += len(line) + 1;
  }
  const shown: string[] = [];
  for (const line of body) {
    if (spent + len(line) + 1 > limit) break;
    shown.push(line);
    spent += len(line) + 1;
  }
  const cut = shown.length < body.length || lines.length < head.length;
  if (shown.length < body.length) {
    let notice = CUT_NOTICE(body.length - shown.length);
    while (shown.length > 0 && spent + len(notice) + 1 > limit) {
      spent -= len(shown.pop()!) + 1;
      notice = CUT_NOTICE(body.length - shown.length);
    }
    if (spent + len(notice) + 1 <= limit) shown.push(notice);
  }
  return { text: [...lines, ...shown, cut ? whenCut : foot].join("\n"), cut };
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

const bold = (text: string) => `**${text}**`;
const literal = (text: string) => text;

function scope(option: ApprovalOption): string {
  if (option.decision !== "acceptForSession") return "";
  const normalised = option.label.split(/\s+/).filter(Boolean).join(" ").toLowerCase().replace(/\.+$/, "");
  return LABELS_STATING_THE_SESSION.has(normalised) ? "" : FOR_SESSION;
}

function carried(option: ApprovalOption, controlLabelLimit: number): boolean {
  if (scope(option)) return false;
  return len(option.label.trim()) <= controlLabelLimit;
}

/** The budget `_draw` hands the renderer once it has charged the mention line to it. */
const budgetAfter = (mention: string | undefined) => Math.max(1, MATTERMOST_MAX_POST - (mention ? len(mention) + 1 : 0));

const withLead = (mention: string | undefined, text: string) => (mention ? `${mention}\n${text}` : text);

export function drawApprovalCard(input: {
  handle: string;
  title: string;
  detail: string | null;
  options: ApprovalOption[];
  mention?: string;
}): Drawn {
  const limit = budgetAfter(input.mention);
  const faithful = new Faithful(mattermostEscape);
  const head = [`${bold("Permission needed")} · request ${codeSpan(input.handle)}`, faithful.call(input.title, share(limit, 1500, 3))];
  if (input.detail) {
    // A command spanning lines is left as prose: a code span is one line.
    const multiline = input.detail.includes("\n");
    const detail = faithful.call(input.detail, detailBudget(limit), multiline ? undefined : literal);
    head.push(multiline ? detail : codeSpan(detail));
  }
  const body = input.options
    .map((option, index) => ({ option, line: `${index + 1}. ${faithful.call(option.label, labelBudget(limit))}${scope(option)}` }))
    .filter(({ option }) => !carried(option, MAX_BUTTON_LABEL))
    .map(({ line }) => line);

  const invites = input.options.length > 0;
  const fittedWhole = faithful.whole;
  const footer = !invites
    ? NO_OPTIONS
    : !fittedWhole
      ? TOO_BIG
      : `Reply with ${codeSpan(input.handle)} and your choice, e.g. ${codeSpan(`${input.handle} 1`)}.`;
  const invitesAnswer = invites && fittedWhole;
  const { text, cut } = compose(head, body, footer, limit, invitesAnswer ? TOO_BIG : footer);
  const answerable = invitesAnswer && !cut;
  return {
    text: withLead(input.mention, text),
    answerable,
    buttons: answerable ? input.options.map((option) => option.label) : [],
  };
}

/** The `questions` form. It has no `detail`, so a question's prompt is where anything long has to go. */
export function drawQuestionsCard(input: { handle: string; title: string; question: CardQuestion; mention?: string }): Drawn {
  const limit = budgetAfter(input.mention);
  const faithful = new Faithful(mattermostEscape);
  const { question } = input;
  const head = [`${bold("Questions")} · request ${codeSpan(input.handle)}`, faithful.call(input.title, share(limit, 1500, 3))];
  const title = question.title ? faithful.call(question.title, labelBudget(limit)) : "";
  const body = [bold(title ? `1. ${title}` : "1.")];
  if (question.prompt) body.push(faithful.call(question.prompt, promptBudget(limit)));
  question.options.forEach((option, index) => {
    let line = `${index + 1}. ${faithful.call(option.label, labelBudget(limit))}`;
    if (option.description) line += ` — ${faithful.call(option.description, labelBudget(limit))}`;
    body.push(line);
  });
  const fittedWhole = faithful.whole;
  const stuck = question.options.length === 0 && !question.allowCustomAnswer;
  const invitesAnswer = fittedWhole && !stuck;
  const example = question.options.length === 0 ? '"your answer"' : question.multiSelect && question.options.length > 1 ? "1,2" : "1";
  const footer = stuck
    ? NOTHING_TO_ANSWER
    : fittedWhole
      ? `Reply with ${codeSpan(input.handle)} and your answer, e.g. ${codeSpan(`${input.handle} ${example}`)}.`
      : TOO_BIG;
  const { text, cut } = compose(head, body, footer, limit, invitesAnswer ? TOO_BIG : footer);
  const answerable = invitesAnswer && !cut;
  return {
    text: withLead(input.mention, text),
    answerable,
    buttons: answerable && !question.multiSelect ? question.options.map((option) => option.label) : [],
  };
}

/**
 * The evidence card (F6, Appendix D). A pure function: same view, same text. The order of content is fixed:
 * the parsed call, context, flags, the agent's claim, who and why, then the pointer to the routing trace.
 * Switch writes the answer handle into the post and adds its own answer line, so the card has none.
 *
 * Budgets are measured against Switch's real Mattermost renderer. A detail over 1000 characters (each @ costs
 * one more, for escaping) is not trimmed: the card loses its buttons and cannot be answered. So going over
 * budget is the failure this file exists to prevent, and it gives up the least important content first:
 * the agent's claim, then context lines. The parsed call, the flags and the expiry always stay.
 */
import type { Tier } from "@clearance/contracts";
import { joinNames, oneLine } from "../format.js";

export const TITLE_MAX = 500;
export const DETAIL_BUDGET = 990;
export const PROMPT_BUDGET = 790;

/** What a text costs against Switch's limit: each @ is escaped, so it counts twice. */
export function renderedCost(text: string): number {
  return text.length + (text.match(/@/g)?.length ?? 0);
}

export type CardView = {
  id: string;
  /** "REFUND ₹40,000": the class and the one thing to know. */
  headline: string;
  tier: Tier;
  reversible: boolean | undefined;
  call: string[];
  context: string[];
  flags: string[];
  claim?: string | undefined;
  /** "Priya (support)". Empty means nobody is known to have asked. */
  askedBy: string[];
  agent: string;
  vendor: string;
  owners: string[];
  /** "Why you" on an approver's card, "Why here" on the room's copy. */
  whyLabel: string;
  why: string;
  /** "refunds over ₹10,000 need 1 finance approver". */
  policyLine: string;
  /** "15:42 IST". */
  expires: string;
};

function reversibility(reversible: boolean | undefined): string {
  if (reversible === undefined) return "reversibility unknown";
  return reversible ? "reversible" : "irreversible";
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function renderTitle(view: CardView): string {
  const tail = ` · ${view.tier.toUpperCase()} · ${reversibility(view.reversible)}`;
  const head = `${view.id} · `;
  return `${head}${clip(view.headline, TITLE_MAX - head.length - tail.length)}${tail}`;
}

type Shrink = {
  claim: boolean;
  contextLines: number;
  /** Longest a line may be. Every line stays; a long agent-supplied value is what gets shorter. */
  lineMax: number;
  /** Lines of each section kept when even clipped lines do not fit: a last resort for absurd input. */
  listMax: number;
};

const CLAIM_MAX = 300;
const FULL_LINE = 300;

/** Least important first. Only the steps that shorten the call or flags are lossy for them, and only by clipping. */
function* shrinkSteps(view: CardView): Generator<Shrink> {
  const all = view.context.length;
  const listMax = Number.POSITIVE_INFINITY;
  yield { claim: true, contextLines: all, lineMax: FULL_LINE, listMax };
  yield { claim: false, contextLines: all, lineMax: FULL_LINE, listMax };
  for (let lines = all - 1; lines >= 0; lines -= 1) yield { claim: false, contextLines: lines, lineMax: FULL_LINE, listMax };
  for (const lineMax of [200, 120, 80, 50, 30]) yield { claim: false, contextLines: 0, lineMax, listMax };
  for (let keep = Math.max(view.call.length, view.flags.length); keep >= 1; keep -= 1) {
    yield { claim: false, contextLines: 0, lineMax: 30, listMax: keep };
  }
}

function list(lines: string[], shrink: Shrink, prefix: string): string[] {
  const kept = lines.slice(0, shrink.listMax).map((text) => `${prefix}${clip(text, shrink.lineMax)}`);
  const dropped = lines.length - kept.length;
  return dropped > 0 ? [...kept, `${prefix}and ${dropped} more`] : kept;
}

function who(view: CardView, shrink: Shrink): string[] {
  const asked = view.askedBy.length > 0 ? `Asked by ${joinNames(view.askedBy)}` : "Asked by: requester unknown,";
  const owned = view.owners.length > 0 ? `owned by ${joinNames(view.owners)}` : "owner unknown";
  return [
    clip(`${asked} through ${view.agent} (${view.vendor}, ${owned})`, Math.max(shrink.lineMax, 100)),
    `${view.whyLabel}: ${clip(view.why, Math.max(shrink.lineMax, 60))}`,
    `Policy: ${clip(view.policyLine, Math.max(shrink.lineMax, 60))} · expires ${view.expires}`,
  ];
}

function callSection(view: CardView, shrink: Shrink): string {
  return ["The call (parsed from what the agent ran, not from its words)", ...list(view.call, shrink, "  ")].join("\n");
}

function assembleDetail(view: CardView, shrink: Shrink): string {
  const sections = [callSection(view, shrink)];
  const context = view.context.slice(0, shrink.contextLines);
  if (context.length > 0) sections.push(["Context", ...context.map((text) => `  ${clip(text, shrink.lineMax)}`)].join("\n"));
  if (view.flags.length > 0) sections.push(["Flags", ...list(view.flags, shrink, "  ⚠ ")].join("\n"));
  const claim = shrink.claim && view.claim ? oneLine(view.claim, CLAIM_MAX) : "";
  if (claim) sections.push(`Agent's claim (unverified): "${claim}"`);
  sections.push(who(view, shrink).join("\n"));
  sections.push(`@clearance why ${view.id}`);
  return sections.join("\n\n");
}

function fit(view: CardView, budget: number, assemble: (shrink: Shrink) => string): string {
  let last = "";
  for (const shrink of shrinkSteps(view)) {
    last = assemble(shrink);
    if (renderedCost(last) <= budget) return last;
  }
  return keepTail(last, budget);
}

/** Only reachable with a view no real call produces. Keep the end: that is where the expiry is. */
function keepTail(text: string, budget: number): string {
  let cost = 0;
  let start = text.length;
  while (start > 0) {
    const next = text[start - 1] === "@" ? 2 : 1;
    if (cost + next > budget) break;
    cost += next;
    start -= 1;
  }
  return text.slice(start);
}

export function renderCard(view: CardView): { title: string; detail: string } {
  return { title: renderTitle(view), detail: fit(view, DETAIL_BUDGET, (shrink) => assembleDetail(view, shrink)) };
}

/**
 * A questions card has no detail slot, so the question's prompt carries the evidence, with a smaller budget.
 * `ask` is the question itself ("Type the refund amount in rupees to approve, or answer no.") and always stays.
 */
export function renderPrompt(view: CardView, ask: string): string {
  return fit(view, PROMPT_BUDGET, (shrink) => {
    const sections = [ask, callSection(view, shrink)];
    const context = view.context.slice(0, shrink.contextLines);
    if (context.length > 0) sections.push(["Context", ...context.map((text) => `  ${clip(text, shrink.lineMax)}`)].join("\n"));
    if (view.flags.length > 0) sections.push(["Flags", ...list(view.flags, shrink, "  ⚠ ")].join("\n"));
    const claim = shrink.claim && view.claim ? oneLine(view.claim, CLAIM_MAX) : "";
    if (claim) sections.push(`Agent's claim (unverified): "${claim}"`);
    sections.push(who(view, shrink).join("\n"));
    return sections.join("\n\n");
  });
}

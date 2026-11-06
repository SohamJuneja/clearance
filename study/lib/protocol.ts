/**
 * The PLAN 11.6 protocol as a pure function of what has been recorded so far, so a reload or a double
 * tap on a phone can never skip a card or score one twice. `deriveStep` decides what comes next and
 * `resolveAnswer` decides what an answer means. The server does the I/O.
 */
import { buttonDecision, confirmMatches, renderCard, type Condition, type RenderedCard } from "./cards";
import type { DecisionEvent, StudyEvent } from "./events";
import { PARTICIPANT_ID } from "./events";
import type { StudyRequest } from "./sets";

export type SetName = "X" | "Y";
export type Block = { condition: Condition; set: SetName };
export type Group = { group: number; blocks: [Block, Block] };

/** PLAN 11.2: A-X then B-Y; A-Y then B-X; B-X then A-Y; B-Y then A-X. */
export const GROUPS: Group[] = [
  { group: 1, blocks: [{ condition: "A", set: "X" }, { condition: "B", set: "Y" }] },
  { group: 2, blocks: [{ condition: "A", set: "Y" }, { condition: "B", set: "X" }] },
  { group: 3, blocks: [{ condition: "B", set: "X" }, { condition: "A", set: "Y" }] },
  { group: 4, blocks: [{ condition: "B", set: "Y" }, { condition: "A", set: "X" }] },
];

/** Round-robin by participant number: p01 is group 1, p04 group 4, p05 group 1 again. */
export function assignGroup(participant: string): Group {
  if (!PARTICIPANT_ID.test(participant)) throw new Error(`bad participant id: ${participant}`);
  const number = Number(participant.slice(1));
  if (number < 1) throw new Error(`bad participant id: ${participant}`);
  return GROUPS[(number - 1) % GROUPS.length]!;
}

export type Sets = { X: StudyRequest[]; Y: StudyRequest[]; practice: StudyRequest[] };

/** What the browser may see of a card. It has no kind, flaw or expected answer. */
export type CardView = Pick<RenderedCard, "sender" | "kind" | "text" | "buttons" | "typeToConfirm">;

export type Step =
  | { step: "consent" }
  | { step: "briefing" }
  | { step: "practice"; index: number; total: number; request_id: string; card: CardView; attempts: number }
  | { step: "card"; block: number; position: number; total: number; request_id: string; card: CardView; attempts: number }
  | { step: "confidence"; block: number }
  | { step: "break"; seconds: number }
  | { step: "comment" }
  | { step: "debrief"; missed: { headline: string; explanation: string }[] }
  | { step: "stopped" };

const view = (request: StudyRequest, condition: Condition): CardView => {
  const { sender, kind, text, buttons, typeToConfirm } = renderCard(request, condition);
  return { sender, kind, text, buttons, typeToConfirm };
};

const attemptsFor = (events: StudyEvent[], requestId: string) => events.filter((e) => e.type === "confirm_wrong" && e.request_id === requestId).length;

/** Practice shows one card in each style, in block order, so neither style is new when it counts. */
export function practiceAt(sets: Sets, group: Group, index: number): { request: StudyRequest; condition: Condition } {
  return { request: sets.practice[index]!, condition: group.blocks[index]!.condition };
}

export function requestAt(sets: Sets, group: Group, blockIndex: number, position: number): { request: StudyRequest; block: Block } {
  const block = group.blocks[blockIndex]!;
  return { request: sets[block.set][position]!, block };
}

export function deriveStep(events: StudyEvent[], participant: string, sets: Sets, breakSeconds: number): Step {
  const group = assignGroup(participant);
  const has = (type: StudyEvent["type"]) => events.some((e) => e.type === type);

  if (has("stopped")) return { step: "stopped" };
  if (!has("consent")) return { step: "consent" };
  if (!has("briefing_read")) return { step: "briefing" };

  const practiced = events.filter((e) => e.type === "practice").length;
  if (practiced < sets.practice.length) {
    const { request, condition } = practiceAt(sets, group, practiced);
    return {
      step: "practice",
      index: practiced + 1,
      total: sets.practice.length,
      request_id: request.id,
      card: view(request, condition),
      attempts: attemptsFor(events, request.id),
    };
  }

  for (const blockIndex of [0, 1]) {
    const blockNumber = blockIndex + 1;
    const decided = events.filter((e) => e.type === "decision" && e.block === blockNumber).length;
    const set = sets[group.blocks[blockIndex]!.set];
    if (decided < set.length) {
      const { request, block } = requestAt(sets, group, blockIndex, decided);
      return {
        step: "card",
        block: blockNumber,
        position: decided + 1,
        total: set.length,
        request_id: request.id,
        card: view(request, block.condition),
        attempts: attemptsFor(events, request.id),
      };
    }
    if (!events.some((e) => e.type === "confidence" && e.block === blockNumber)) return { step: "confidence", block: blockNumber };
    if (blockIndex === 0 && !has("break_done")) return { step: "break", seconds: breakSeconds };
  }

  if (!has("session_end")) return { step: "comment" };

  const all = [...sets.X, ...sets.Y];
  const missed = events
    .filter((e): e is DecisionEvent => e.type === "decision" && e.kind === "flawed" && e.decision === "approve")
    .map((e) => all.find((r) => r.id === e.request_id)!)
    .map((r) => ({ headline: r.b.headline, explanation: r.flaw!.explanation }));
  return { step: "debrief", missed };
}

export type CardStep = Extract<Step, { step: "practice" | "card" }>;

export type Located = { request: StudyRequest; condition: Condition; block: Block | null };

/** Which request and style the current step shows. */
export function locate(sets: Sets, group: Group, step: CardStep): Located {
  if (step.step === "practice") return { ...practiceAt(sets, group, step.index - 1), block: null };
  const found = requestAt(sets, group, step.block - 1, step.position - 1);
  return { request: found.request, condition: found.block.condition, block: found.block };
}

/**
 * The event a final answer becomes, on either platform. `typed` counts a type-to-confirm attempt. The
 * caller adds who and when.
 */
export function answerRecord(
  group: Group,
  step: CardStep,
  located: Located,
  outcome: Extract<AnswerOutcome, { kind: "final" }>,
  timing: { ms: number; interrupted: boolean },
  typed: boolean,
): Record<string, unknown> {
  const answer = {
    condition: located.condition,
    request_id: located.request.id,
    decision: outcome.decision,
    option: outcome.option,
    ms: timing.ms,
    interrupted: timing.interrupted,
    confirm_attempts: step.attempts + (typed ? 1 : 0),
  };
  if (step.step === "practice") return { type: "practice", ...answer };
  return {
    type: "decision",
    ...answer,
    group: group.group,
    block: step.block,
    set: located.block!.set,
    position: step.position,
    template: located.request.template,
    kind: located.request.kind,
    flaw_type: located.request.flaw?.type ?? null,
    evidence_in_a: located.request.flaw?.evidence_in_a ?? null,
  };
}

export type AnswerInput = { label?: string; typed?: string };

export type AnswerOutcome =
  | { kind: "invalid"; reason: string }
  /** Wrong type-to-confirm value, first time: ask once more (PLAN F6). */
  | { kind: "reask" }
  | { kind: "final"; decision: DecisionEvent["decision"]; option: string };

/** What an answer to the current card means. Pure: the server records the result. */
export function resolveAnswer(request: StudyRequest, condition: Condition, attempts: number, input: AnswerInput): AnswerOutcome {
  const card = renderCard(request, condition);
  if (input.label !== undefined) {
    if (!card.buttons.includes(input.label)) return { kind: "invalid", reason: "that button is not on this card" };
    return { kind: "final", decision: buttonDecision(input.label), option: input.label };
  }
  if (input.typed === undefined) return { kind: "invalid", reason: "an answer needs a button or a typed value" };
  const confirm = request.b.confirm;
  if (!card.typeToConfirm || !confirm) return { kind: "invalid", reason: "this card takes no typed answer" };
  if (confirmMatches(confirm.field, confirm.expected, input.typed)) return { kind: "final", decision: "approve", option: "typed" };
  return attempts >= 1 ? { kind: "final", decision: "confirm_failed", option: "typed" } : { kind: "reask" };
}

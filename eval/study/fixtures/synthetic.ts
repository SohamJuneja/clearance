/**
 * SYNTHETIC TEST DATA. Made-up sessions for unit-testing the analysis, every event marked
 * `synthetic: true`. Never write these into study/results and never report a number from them.
 */
import { assignGroup } from "../../../study/lib/protocol";
import type { StudyEvent } from "../../../study/lib/events";

export type SyntheticConditionPlan = {
  /** How many of the 4 flawed cards this person denies. */
  catches: number;
  /** How many of the 8 legitimate cards this person denies. */
  falseDenies: number;
  msLegit: number;
  msFlawed: number;
  confidence: number;
};

const AT = "2026-11-06T00:00:00.000Z";
const FLAWED_POSITIONS: Record<"X" | "Y", number[]> = { X: [3, 6, 9, 11], Y: [2, 5, 8, 10] };

export function syntheticSession(participant: string, plan: { A: SyntheticConditionPlan; B: SyntheticConditionPlan }, options: { stopAfterCards?: number } = {}): StudyEvent[] {
  const { group, blocks } = assignGroup(participant);
  const base = { participant, at: AT, synthetic: true as const };
  const events: StudyEvent[] = [
    { ...base, type: "session_start", group, platform: "approval-lab", schema: 1 },
    { ...base, type: "consent", agreed: true, role: "other", familiarity: 3 },
    { ...base, type: "briefing_read" },
  ];
  let cards = 0;
  for (const [blockIndex, block] of blocks.entries()) {
    const conditionPlan = plan[block.condition];
    const flawedPositions = FLAWED_POSITIONS[block.set];
    let flawedSeen = 0;
    let legitSeen = 0;
    for (let position = 1; position <= 12; position += 1) {
      if (options.stopAfterCards !== undefined && cards >= options.stopAfterCards) {
        events.push({ ...base, type: "stopped" });
        return events;
      }
      const isFlawed = flawedPositions.includes(position);
      const denied = isFlawed ? flawedSeen++ < conditionPlan.catches : legitSeen++ < conditionPlan.falseDenies;
      events.push({
        ...base,
        type: "decision",
        group,
        block: blockIndex + 1,
        condition: block.condition,
        set: block.set,
        position,
        request_id: `${block.set}${String(position).padStart(2, "0")}`,
        template: "T00",
        kind: isFlawed ? "flawed" : "legit",
        flaw_type: isFlawed ? "text_call_mismatch" : null,
        evidence_in_a: isFlawed ? "raw" : null,
        decision: denied ? "deny" : "approve",
        option: denied ? "Decline" : "Allow once",
        ms: isFlawed ? conditionPlan.msFlawed : conditionPlan.msLegit,
        interrupted: false,
        confirm_attempts: 0,
      });
      cards += 1;
    }
    events.push({ ...base, type: "confidence", block: blockIndex + 1, value: conditionPlan.confidence });
    if (blockIndex === 0) events.push({ ...base, type: "break_done" });
  }
  events.push({ ...base, type: "comment", text: "" }, { ...base, type: "session_end" });
  return events;
}

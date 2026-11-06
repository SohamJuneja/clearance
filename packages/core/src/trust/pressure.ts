/**
 * F21: spots agent messages that lean on the people approving things ("urgent, CEO says approve now"). Plain text
 * patterns, so the same message always gets the same answer and there's nothing to talk round.
 *
 * This is advice and nothing else. Switch calls it with a 2 s timeout and carries on if it doesn't answer, so nothing may
 * depend on it. Nothing in core reads the result: it reaches no decision, no card and no record. A message that gets
 * past these patterns has lost nothing, because the card leads with the call, and the agent's words come last, labelled unverified.
 */
export type TrustRole = "user" | "assistant";
export type TrustMessage = { role: TrustRole; content: string };
export type TrustFinding = { category: string; detector_name: string; severity: string };
export type TrustOutcome = "GUARDRAIL_RESULT_OUTCOME_OK" | "GUARDRAIL_RESULT_OUTCOME_ALERTED";

const CATEGORY = "approver_pressure";
const SEVERITY = "MEDIUM";

/** Asking someone to approve. "approved" only when someone's wanting it, since "was approved by Sam" is just news. */
const ASK = /\bapprove\b|\b(?:want|wants|need|needs|expect|expects|get|getting) (?:this|it|that|them|these) approved\b/;
const URGENCY = /\b(?:urgent|urgently|asap|immediately|right now|right away|hurry|before eod|by eod|eod|time.?sensitive)\b|\bapprove (?:(?:this|it|that|them) )?now\b/;
const AUTHORITY = /\b(?:ceo|cfo|cto|coo|founder|vp|director|your (?:boss|manager)|the (?:boss|board))\b/;

/** Each of these is pressure on its own, because each one is asking a person not to do the job. */
const BYPASS: [name: string, pattern: RegExp][] = [
  ["just_approve", /\bjust (?:approve|click|press|hit|say yes|sign off)\b/],
  ["skip_review", /\b(?:skip|bypass|ignore|avoid) (?:the |this |that |your )?(?:approval|approver|review|check|card|confirmation)\b/],
  ["no_need_to_look", /\b(?:no need to|don't need to|do not need to|don't bother|do not bother|no time to) (?:review|read|look|check|checking|reading|verify|confirm)/],
  ["already_agreed", /\b(?:already approved|pre-?approved|approved already|already signed off)\b/],
  ["must_approve", /\b(?:you've got to|you have got to|you have to|you need to|you must) approve\b/],
];

const INVISIBLE = /[­​-‏⁠-⁤﻿]/g;

/** Lower case, no invisible characters, one kind of quote and one kind of space. */
function normalise(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "").replace(/[‘’]/g, "'").toLowerCase().replace(/\s+/g, " ");
}

/** The names of what this text does. Empty is the usual answer. */
export function findPressure(text: string): string[] {
  const clean = normalise(text);
  const found = BYPASS.filter(([, pattern]) => pattern.test(clean)).map(([name]) => name);
  if (ASK.test(clean)) {
    if (URGENCY.test(clean)) found.push("urgency_and_ask");
    if (AUTHORITY.test(clean)) found.push("authority_and_ask");
  }
  return found;
}

/** The answer in Switch's shape. Only agents are held to this: people can say what they like to each other. */
export function checkMessages(messages: TrustMessage[]): { outcome: TrustOutcome; findings: TrustFinding[] } {
  const names = new Set(messages.filter((message) => message.role === "assistant").flatMap((message) => findPressure(message.content)));
  // Switch shows the category in the room. The message's own words stay out of it: they've already been seen.
  const findings = [...names].map((name) => ({ category: CATEGORY, detector_name: name, severity: SEVERITY }));
  return { outcome: findings.length > 0 ? "GUARDRAIL_RESULT_OUTCOME_ALERTED" : "GUARDRAIL_RESULT_OUTCOME_OK", findings };
}

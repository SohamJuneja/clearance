/**
 * What must stay true however long the soak runs (PLAN 10.5). Pure functions over what the soak read from
 * the ledger, Acme and core's database, so each can be tested with a violation it must catch. A violation is
 * reported, never hidden: the soak's whole job is to find one.
 */
export interface SoakLedgerRow {
  seq: number;
  type: string;
  request_id: string | null;
  payload: Record<string, unknown>;
}

export interface RequestFacts {
  id: string;
  cls: string;
  requesterIds: string[];
  agentOwnerId: string | null;
}

export type Violation = { invariant: string; detail: string };

/** Who may approve what, from policy/team.yaml. Fixed for the soak, which runs that team. */
export const APPROVERS: Record<string, string[]> = {
  refund: ["sam", "neha"],
  deploy: ["alex"],
  merge: ["alex", "dev"],
};

/** Every execution had an approval first, and every approver on it was allowed to give it. */
export function checkApprovals(
  rows: SoakLedgerRow[],
  facts: Map<string, RequestFacts>,
): Violation[] {
  const violations: Violation[] = [];
  const approvedAt = new Map<string, { seq: number; by: string[] }>();
  for (const row of rows) {
    if (row.type === "approved" && row.request_id) {
      approvedAt.set(row.request_id, {
        seq: row.seq,
        by: (row.payload.approved_by ?? []) as string[],
      });
    }
  }
  for (const row of rows) {
    if (row.type !== "executed" || !row.request_id || row.payload.ok !== true) continue;
    const approval = approvedAt.get(row.request_id);
    if (!approval || approval.seq > row.seq) {
      violations.push({
        invariant: "no execution without approval",
        detail: `${row.request_id} executed with no approval before it`,
      });
      continue;
    }
    const request = facts.get(row.request_id);
    if (!request) continue;
    const allowed = APPROVERS[request.cls];
    for (const person of approval.by) {
      if (request.requesterIds.includes(person)) {
        violations.push({
          invariant: "no execution without approval",
          detail: `${row.request_id} was approved by its requester, ${person}`,
        });
      }
      if (allowed && !allowed.includes(person)) {
        violations.push({
          invariant: "no execution without approval",
          detail: `${row.request_id} (${request.cls}) was approved by ${person}, who isn't an approver`,
        });
      }
    }
  }
  return violations;
}

/** A request runs once in the ledger, and each call's unique amount appears once in Acme. */
export function checkNoDoubles(rows: SoakLedgerRow[], refundAmounts: number[]): Violation[] {
  const violations: Violation[] = [];
  const executions = new Map<string, number>();
  for (const row of rows) {
    if (row.type !== "executed" || !row.request_id || row.payload.ok !== true) continue;
    if (row.payload.already_executed === true) continue;
    executions.set(row.request_id, (executions.get(row.request_id) ?? 0) + 1);
  }
  for (const [id, count] of executions) {
    if (count > 1)
      violations.push({
        invariant: "no double execution",
        detail: `${id} executed ${count} times`,
      });
  }
  const seen = new Map<number, number>();
  for (const amount of refundAmounts) seen.set(amount, (seen.get(amount) ?? 0) + 1);
  for (const [amount, count] of seen) {
    if (count > 1)
      violations.push({
        invariant: "no double execution",
        detail: `Acme shows the refund of ₹${amount} ${count} times`,
      });
  }
  return violations;
}

/** Money only moves through an executed request: Acme can't have more refunds than the ledger explains. */
export function checkAcmeExplained(rows: SoakLedgerRow[], refundCount: number): Violation[] {
  const executed = rows.filter((row) => row.type === "executed" && row.payload.ok === true);
  return refundCount > executed.length
    ? [
        {
          invariant: "no execution without approval",
          detail: `Acme shows ${refundCount} refunds but the ledger explains ${executed.length}`,
        },
      ]
    : [];
}

export function checkGrantsOnce(
  rows: SoakLedgerRow[],
  allowedRetries: Map<string, number>,
): Violation[] {
  const violations: Violation[] = [];
  const consumed = new Map<string, number>();
  for (const row of rows) {
    if (row.type === "grant_consumed" && row.request_id) {
      consumed.set(row.request_id, (consumed.get(row.request_id) ?? 0) + 1);
    }
  }
  for (const [id, count] of consumed) {
    if (count > 1)
      violations.push({
        invariant: "every grant used at most once",
        detail: `${id} consumed ${count} times`,
      });
  }
  for (const [command, count] of allowedRetries) {
    if (count > 1)
      violations.push({
        invariant: "every grant used at most once",
        detail: `"${command}" was allowed ${count} times on one approval`,
      });
  }
  return violations;
}

export interface OpenTimer {
  request_id: string;
  fire_at: number;
}
export interface OverdueRequest {
  id: string;
  state: string;
  expires_at: number;
}

/**
 * A timer or an expiry that's well past due, on a core that's been up long enough to have caught up. Only
 * meaningful while core is up, so the soak measures `upSinceMs` from its last restart.
 */
export function checkNoStuckTimers(
  timers: OpenTimer[],
  overdue: OverdueRequest[],
  nowMs: number,
  upSinceMs: number,
  slackMs: number,
): Violation[] {
  if (nowMs - upSinceMs < slackMs) return [];
  const violations: Violation[] = [];
  for (const timer of timers) {
    if (timer.fire_at < nowMs - slackMs) {
      violations.push({
        invariant: "no stuck timers",
        detail: `a timer for ${timer.request_id} is ${Math.round((nowMs - timer.fire_at) / 1000)} s overdue`,
      });
    }
  }
  for (const request of overdue) {
    if (request.expires_at < nowMs - slackMs) {
      violations.push({
        invariant: "no stuck timers",
        detail: `${request.id} is still ${request.state}, ${Math.round((nowMs - request.expires_at) / 1000)} s past expiry`,
      });
    }
  }
  return violations;
}

export function dedupe(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  return violations.filter((violation) => {
    const key = `${violation.invariant}|${violation.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A small deterministic generator, so a soak can be run again with the same choices. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type CallKind =
  | "hook_safe"
  | "gate_read"
  | "gate_refund_large"
  | "gate_refund_small"
  | "gate_deploy"
  | "hook_push"
  | "hook_curl";

/** The mix of calls, per PLAN 10.5's "mixed". Mostly quiet work, as a real team's traffic is. */
export const CALL_MIX: [CallKind, number][] = [
  ["hook_safe", 0.55],
  ["gate_read", 0.15],
  ["gate_refund_small", 0.1],
  ["gate_refund_large", 0.08],
  ["hook_push", 0.05],
  ["gate_deploy", 0.05],
  ["hook_curl", 0.02],
];

export function pickCall(roll: number): CallKind {
  let upTo = 0;
  for (const [kind, weight] of CALL_MIX) {
    upTo += weight;
    if (roll < upTo) return kind;
  }
  return "hook_safe";
}

export type BotChoice = "approve" | "deny" | "ignore";

export function botChoice(roll: number): BotChoice {
  return roll < 0.5 ? "approve" : roll < 0.8 ? "deny" : "ignore";
}

/** Chaos kills, evenly spaced through the soak. */
export function chaosTimes(durationMs: number, kills: number): number[] {
  return Array.from({ length: kills }, (_, index) => (durationMs * (index + 1)) / (kills + 1));
}

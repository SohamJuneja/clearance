/**
 * E3's numbers (PLAN 10.4), as pure functions over rows from the `actions` table and a person's labels.
 * Held-out only: calls at or after the policy freeze. The calls before it tuned the policy, so scoring on
 * them would flatter it.
 */
import { z } from "zod";

export interface ActionRow {
  id: string;
  at: string;
  source: string;
  vendor: string;
  agent: string;
  kind: string;
  class: string | null;
  decision: string;
  request_id: string | null;
  raw: string | null;
}

const LabelSchema = z.object({
  id: z.string().min(1),
  label: z.enum(["risky", "safe"]),
  labeller: z.string().min(1),
});
export type Label = z.infer<typeof LabelSchema>;

/** The labeller name for a decided disagreement. Its label wins over everyone's. */
export const RESOLVED = "resolved";

export function parseLabels(text: string): Label[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`labels line ${index + 1} is not JSON`);
      }
      const label = LabelSchema.safeParse(parsed);
      if (!label.success)
        throw new Error(`labels line ${index + 1}: ${label.error.issues[0]?.message}`);
      return label.data;
    });
}

/** Cohen's kappa for two raters over the same items. Undefined when chance agreement is total. */
export function cohensKappa(pairs: ["risky" | "safe", "risky" | "safe"][]): number | undefined {
  if (pairs.length === 0) return undefined;
  const agree = pairs.filter(([a, b]) => a === b).length / pairs.length;
  const firstRisky = pairs.filter(([a]) => a === "risky").length / pairs.length;
  const secondRisky = pairs.filter(([, b]) => b === "risky").length / pairs.length;
  const chance = firstRisky * secondRisky + (1 - firstRisky) * (1 - secondRisky);
  return chance === 1 ? undefined : (agree - chance) / (1 - chance);
}

export interface Agreement {
  labellers: string[];
  /** Calls both of the first two labellers labelled. */
  compared: number;
  kappa?: number;
  disagreements: number;
  unresolved: number;
}

/** One label per call, and how well the labellers agreed. Unresolved disagreements are left out and counted. */
export function resolveLabels(labels: Label[]): {
  final: Map<string, "risky" | "safe">;
  agreement: Agreement;
} {
  const byCall = new Map<string, Label[]>();
  for (const label of labels) byCall.set(label.id, [...(byCall.get(label.id) ?? []), label]);
  const labellers = [...new Set(labels.map((label) => label.labeller))]
    .filter((name) => name !== RESOLVED)
    .sort();
  const [first, second] = labellers;
  const pairs: ["risky" | "safe", "risky" | "safe"][] = [];
  const final = new Map<string, "risky" | "safe">();
  let disagreements = 0;
  let unresolved = 0;
  for (const [id, rows] of byCall) {
    const people = rows.filter((row) => row.labeller !== RESOLVED);
    const a = people.find((row) => row.labeller === first)?.label;
    const b = people.find((row) => row.labeller === second)?.label;
    if (a && b) pairs.push([a, b]);
    const decided = rows.find((row) => row.labeller === RESOLVED)?.label;
    const distinct = new Set(people.map((row) => row.label));
    if (distinct.size > 1) disagreements += 1;
    if (decided) final.set(id, decided);
    else if (distinct.size === 1) final.set(id, [...distinct][0] as "risky" | "safe");
    else if (distinct.size > 1) unresolved += 1;
  }
  const kappa = second ? cohensKappa(pairs) : undefined;
  return {
    final,
    agreement: {
      labellers,
      compared: pairs.length,
      ...(kappa === undefined ? {} : { kappa }),
      disagreements,
      unresolved,
    },
  };
}

export const held = (row: ActionRow): boolean => row.decision === "hold" || row.decision === "deny";

/**
 * What approval-required mode would ask about, per PLAN 10.4: every shell command and file write. A gate
 * call counts because, with no gate, that same action would have been a shell command.
 */
export function approvalRequiredAsks(row: ActionRow): boolean {
  return row.kind === "shell" || row.kind === "file_write" || row.kind === "business";
}

export interface ClassifierResult {
  freeze_at: string;
  corpus_calls: number;
  held_out_calls: number;
  labelled_calls: number;
  labelled_risky: number;
  labelled_safe: number;
  recall: { approval_required?: number; clearance?: number };
  false_hold_rate: { approval_required?: number; clearance?: number };
  no_card_share: { approval_required: number; clearance: number };
  cards_per_100: { approval_required: number; clearance: number };
  business_class_recall: Record<string, { risky: number; caught: number }>;
  misses: { id: string; class: string | null; decision: string }[];
}

const BUSINESS_CLASSES = ["refund", "deploy", "merge", "customer_email", "delete"];

function ratio(top: number, bottom: number): number | undefined {
  return bottom === 0 ? undefined : top / bottom;
}

export function computeMetrics(
  rows: ActionRow[],
  final: Map<string, "risky" | "safe">,
  freezeAt: string,
): ClassifierResult {
  const freezeMs = Date.parse(freezeAt);
  if (!Number.isFinite(freezeMs)) throw new Error(`the freeze time "${freezeAt}" can't be read`);
  const heldOut = rows.filter((row) => Date.parse(row.at) >= freezeMs);
  const labelled = heldOut.filter((row) => final.has(row.id));
  const risky = labelled.filter((row) => final.get(row.id) === "risky");
  const safe = labelled.filter((row) => final.get(row.id) === "safe");

  const cardsClearance = new Set(
    heldOut.filter((row) => row.decision === "hold" && row.request_id).map((row) => row.request_id),
  ).size;
  const cardsRequired = heldOut.filter(approvalRequiredAsks).length;
  const calls = heldOut.length;
  const per100 = (count: number): number => (calls === 0 ? 0 : (100 * count) / calls);

  const business: Record<string, { risky: number; caught: number }> = {};
  for (const name of BUSINESS_CLASSES) {
    const inClass = risky.filter((row) => row.class === name);
    if (inClass.length > 0)
      business[name] = { risky: inClass.length, caught: inClass.filter(held).length };
  }
  const defined = (key: string, value: number | undefined): Record<string, number> =>
    value === undefined ? {} : { [key]: value };

  return {
    freeze_at: freezeAt,
    corpus_calls: rows.length,
    held_out_calls: calls,
    labelled_calls: labelled.length,
    labelled_risky: risky.length,
    labelled_safe: safe.length,
    recall: {
      ...defined(
        "approval_required",
        ratio(risky.filter(approvalRequiredAsks).length, risky.length),
      ),
      ...defined("clearance", ratio(risky.filter(held).length, risky.length)),
    },
    false_hold_rate: {
      ...defined("approval_required", ratio(safe.filter(approvalRequiredAsks).length, safe.length)),
      ...defined("clearance", ratio(safe.filter(held).length, safe.length)),
    },
    no_card_share: {
      approval_required: calls === 0 ? 0 : (calls - cardsRequired) / calls,
      clearance: calls === 0 ? 0 : heldOut.filter((row) => row.decision === "allow").length / calls,
    },
    cards_per_100: { approval_required: per100(cardsRequired), clearance: per100(cardsClearance) },
    business_class_recall: business,
    misses: risky
      .filter((row) => !held(row))
      .map((row) => ({ id: row.id, class: row.class, decision: row.decision })),
  };
}

// ── Sampling for a person to label ───────────────────────────────────────────

const SECRET_SHAPES: [RegExp, string][] = [
  [/(authorization:\s*bearer\s+)\S+/gi, "$1[redacted]"],
  [/(x-acme-admin-key:\s*)\S+/gi, "$1[redacted]"],
  [/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,})\b/g, "[redacted]"],
  [/\b[0-9a-f]{40,}\b/gi, "[redacted]"],
];

export function redact(text: string): string {
  return SECRET_SHAPES.reduce(
    (out, [pattern, replacement]) => out.replace(pattern, replacement),
    text,
  );
}

/** What a call does, for a person, from the stored raw payload. */
export function describeCall(row: ActionRow): string {
  let raw: unknown = null;
  try {
    raw = row.raw ? JSON.parse(row.raw) : null;
  } catch {
    return redact(String(row.raw)).slice(0, 400);
  }
  const record = (raw ?? {}) as Record<string, unknown>;
  const input = (record.tool_input ?? record.toolInput ?? {}) as Record<string, unknown>;
  const parts = [
    record.tool_name,
    input.command,
    input.file_path,
    record.method,
    record.path,
    record.body === undefined ? undefined : JSON.stringify(record.body),
  ].filter((part) => part !== undefined && part !== null);
  const text = parts.length > 0 ? parts.join(" ") : JSON.stringify(raw);
  return redact(text).slice(0, 400);
}

/** Deterministic, so the same corpus always gives the same sample. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function strata(row: ActionRow): string {
  return `${row.class ?? "none"}|${row.decision}|${row.kind}`;
}

/**
 * A sample of `size` calls, stratified by class, decision and kind, so rare classes aren't drowned by the
 * thousands of file reads. Every stratum gets at least one call while there's room, then the rest in proportion.
 */
export function stratifiedSample(rows: ActionRow[], size: number, seed = 20261106): ActionRow[] {
  const random = seededRandom(seed);
  const groups = new Map<string, ActionRow[]>();
  for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    groups.set(strata(row), [...(groups.get(strata(row)) ?? []), row]);
  }
  for (const group of groups.values()) {
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [group[i], group[j]] = [group[j] as ActionRow, group[i] as ActionRow];
    }
  }
  const chosen: ActionRow[] = [];
  const remaining = [...groups.values()];
  for (const group of remaining) {
    if (chosen.length < size && group.length > 0) chosen.push(group.shift() as ActionRow);
  }
  const left = remaining.reduce((sum, group) => sum + group.length, 0);
  const room = size - chosen.length;
  for (const group of remaining) {
    const share = left === 0 ? 0 : Math.round((room * group.length) / left);
    chosen.push(...group.splice(0, Math.min(share, size - chosen.length)));
  }
  for (const group of remaining) {
    while (chosen.length < size && group.length > 0) chosen.push(group.shift() as ActionRow);
  }
  return chosen;
}

/**
 * The row a labeller sees. It leaves out the class and what Clearance decided, because a person who can see
 * the verdict is grading the policy against itself.
 */
export function blindRow(row: ActionRow): Record<string, unknown> {
  return {
    id: row.id,
    at: row.at,
    agent: row.agent,
    vendor: row.vendor,
    kind: row.kind,
    what: describeCall(row),
    label: null,
  };
}

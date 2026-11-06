/**
 * SYNTHETIC DATA, for screenshots only (DESK_FIXTURE=1). Every request, person's number and ledger entry
 * here is made up, and the page shows a SYNTHETIC banner whenever this source is in use. It stands in for
 * core at the HTTP level, so everything the fixture shows has been through the same code as real data.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CoreAnswer, CoreSource } from "./core-source";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Entry = { type: string; request_id: string | null; payload: Record<string, unknown>; agoMs: number };

type OpenRequest = {
  id: string;
  cls: string;
  tier: string;
  score: number;
  headline: string;
  agent: string;
  vendor: string;
  requesters: string[];
  room: string;
  flags: { code: string; text: string }[];
  quorum: number;
  agoMs: number;
  holders: { user: string; handle: string; what: string }[];
};

const OPEN: OpenRequest[] = [
  {
    id: "CLR-0048",
    cls: "merge",
    tier: "high",
    score: 55,
    headline: "MERGE acme/acme-mini-app#412",
    agent: "coder",
    vendor: "claude",
    requesters: ["alex"],
    room: "#eng",
    flags: [{ code: "touches_auth", text: "The diff touches auth code" }],
    quorum: 1,
    agoMs: 8 * MINUTE + 12 * SECOND,
    holders: [{ user: "dev", handle: "A19", what: "merge acme/acme-mini-app#412" }],
  },
  {
    id: "CLR-0047",
    cls: "refund",
    tier: "high",
    score: 55,
    headline: "REFUND ₹40,000",
    agent: "refunds-agent",
    vendor: "claude",
    requesters: ["priya"],
    room: "#support",
    flags: [],
    quorum: 1,
    agoMs: 3 * MINUTE + 20 * SECOND,
    holders: [
      { user: "sam", handle: "A15", what: "refund ₹40,000" },
      { user: "neha", handle: "A16", what: "refund ₹40,000" },
    ],
  },
  {
    id: "CLR-0042",
    cls: "refund",
    tier: "high",
    score: 71,
    headline: "REFUND ₹40,000",
    agent: "refunds-agent",
    vendor: "claude",
    requesters: ["priya"],
    room: "#support",
    flags: [
      { code: "amount_vs_order", text: "Amount is 10x the order total" },
      { code: "new_destination", text: "Destination added in the last 24 h" },
      { code: "mismatch", text: 'The agent wrote "₹4,000" in the thread; the call says ₹40,000' },
    ],
    quorum: 1,
    agoMs: 2 * MINUTE + 14 * SECOND,
    holders: [{ user: "sam", handle: "A12", what: "refund ₹40,000" }],
  },
  {
    id: "CLR-0045",
    cls: "customer_email",
    tier: "critical",
    score: 80,
    headline: "CUSTOMER EMAIL auditor@freemail.example",
    agent: "support-agent",
    vendor: "codex",
    requesters: ["sam"],
    room: "#support",
    flags: [{ code: "bulk_data", text: "Attachments hold 3,000 rows" }],
    quorum: 1,
    agoMs: 65 * SECOND,
    holders: [{ user: "priya", handle: "A14", what: "email auditor@freemail.example" }],
  },
  {
    id: "CLR-0044",
    cls: "deploy",
    tier: "critical",
    score: 90,
    headline: "DEPLOY checkout v2.14.0 prod",
    agent: "ops-agent",
    vendor: "opencode",
    requesters: ["priya"],
    room: "#eng",
    flags: [{ code: "failing_checks", text: "Checks are not passing for v2.14.0" }],
    quorum: 1,
    agoMs: 40 * SECOND,
    holders: [{ user: "alex", handle: "A13", what: "deploy checkout v2.14.0 prod" }],
  },
];

const HISTORY: Entry[] = [
  { type: "held", request_id: "CLR-0031", payload: { agent: "refunds-agent", class: "refund", tier: "low" }, agoMs: 5 * HOUR },
  { type: "routed", request_id: "CLR-0031", payload: { chosen: ["sam"], fallback: null, label: "finance" }, agoMs: 5 * HOUR - SECOND },
  { type: "answered", request_id: "CLR-0031", payload: { user_id: "sam", decision: "approve", latency_ms: 41_000 }, agoMs: 5 * HOUR - 41 * SECOND },
  { type: "approved", request_id: "CLR-0031", payload: { approved_by: ["sam"], quorum: 1 }, agoMs: 5 * HOUR - 41 * SECOND },
  { type: "executed", request_id: "CLR-0031", payload: { ok: true, status: 201, result: { id: "re_7731" } }, agoMs: 5 * HOUR - 42 * SECOND },
  { type: "drill_sent", request_id: "CLR-0033", payload: { agent: "refunds-agent", class: "refund", tier: "high" }, agoMs: 4 * HOUR + 40 * MINUTE },
  { type: "routed", request_id: "CLR-0033", payload: { chosen: ["sam"], fallback: null, label: "finance" }, agoMs: 4 * HOUR + 40 * MINUTE - SECOND },
  { type: "drill_result", request_id: "CLR-0033", payload: { result: "caught", user_id: "sam", flaw: "new_destination", latency_ms: 74_000 }, agoMs: 4 * HOUR + 38 * MINUTE },
  { type: "promotion_proposed", request_id: "PRO-0006", payload: { agent: "refunds-agent", class: "refund", bucket: "small", from: "L1", level: "L2", quorum: 2 }, agoMs: 4 * HOUR },
  { type: "promotion_signed", request_id: "PRO-0006", payload: { agent: "refunds-agent", class: "refund", bucket: "small", level: "L2", signed_by: ["sam", "alex"] }, agoMs: 4 * HOUR - 9 * MINUTE },
  { type: "drill_sent", request_id: "CLR-0035", payload: { agent: "ops-agent", class: "deploy", tier: "high" }, agoMs: 3 * HOUR + 30 * MINUTE },
  { type: "routed", request_id: "CLR-0035", payload: { chosen: ["alex"], fallback: null, label: "eng" }, agoMs: 3 * HOUR + 30 * MINUTE - SECOND },
  { type: "drill_result", request_id: "CLR-0035", payload: { result: "caught", user_id: "alex", flaw: "failing_checks", latency_ms: 88_000 }, agoMs: 3 * HOUR + 28 * MINUTE },
  { type: "held", request_id: "CLR-0036", payload: { agent: "ops-agent", class: "deploy", tier: "high" }, agoMs: 3 * HOUR },
  { type: "routed", request_id: "CLR-0036", payload: { chosen: ["alex"], fallback: null, label: "eng" }, agoMs: 3 * HOUR - SECOND },
  { type: "answered", request_id: "CLR-0036", payload: { user_id: "alex", decision: "deny", latency_ms: 95_000 }, agoMs: 3 * HOUR - 95 * SECOND },
  { type: "denied", request_id: "CLR-0036", payload: { denied_by: "alex" }, agoMs: 3 * HOUR - 95 * SECOND },
  { type: "demoted", request_id: "CLR-0036", payload: { agent: "ops-agent", class: "deploy", bucket: "staging", from: "L1", to: "L0", reason: "denial inside the bucket" }, agoMs: 3 * HOUR - 94 * SECOND },
  { type: "drill_sent", request_id: "CLR-0038", payload: { agent: "refunds-agent", class: "refund", tier: "high" }, agoMs: 2 * HOUR + 30 * MINUTE },
  { type: "routed", request_id: "CLR-0038", payload: { chosen: ["sam"], fallback: null, label: "finance" }, agoMs: 2 * HOUR + 30 * MINUTE - SECOND },
  { type: "drill_result", request_id: "CLR-0038", payload: { result: "missed", user_id: "sam", flaw: "amount_vs_order", latency_ms: 6_000 }, agoMs: 2 * HOUR + 29 * MINUTE },
  { type: "held", request_id: "CLR-0039", payload: { agent: "refunds-agent", class: "refund", tier: "high" }, agoMs: 2 * HOUR },
  { type: "routed", request_id: "CLR-0039", payload: { chosen: ["sam"], fallback: null, label: "finance" }, agoMs: 2 * HOUR - SECOND },
  { type: "ineligible_answer", request_id: "CLR-0039", payload: { user_id: "priya", answer: "allow", reasons: ["requester", "agent_owner"] }, agoMs: 2 * HOUR - 20 * SECOND },
  { type: "answered", request_id: "CLR-0039", payload: { user_id: "sam", decision: "deny", latency_ms: 62_000 }, agoMs: 2 * HOUR - 62 * SECOND },
  { type: "denied", request_id: "CLR-0039", payload: { denied_by: "sam" }, agoMs: 2 * HOUR - 62 * SECOND },
  { type: "held", request_id: "CLR-0041", payload: { agent: "ops-agent", class: "deploy", tier: "high" }, agoMs: 70 * MINUTE },
  { type: "routed", request_id: "CLR-0041", payload: { chosen: ["alex"], fallback: null, label: "eng" }, agoMs: 70 * MINUTE - SECOND },
  { type: "escalated", request_id: "CLR-0041", payload: { step: 0, kind: "add", added: "dev" }, agoMs: 65 * MINUTE },
  { type: "expired", request_id: "CLR-0041", payload: { after_ms: 25 * MINUTE }, agoMs: 45 * MINUTE },
  { type: "promotion_proposed", request_id: "PRO-0009", payload: { agent: "support-agent", class: "customer_email", bucket: "plain_reply", from: "L1", level: "L2", quorum: 2 }, agoMs: 20 * MINUTE },
  { type: "held", request_id: "CLR-0048", payload: { agent: "coder", class: "merge", tier: "high" }, agoMs: 8 * MINUTE + 12 * SECOND },
  { type: "routed", request_id: "CLR-0048", payload: { chosen: ["dev"], fallback: null, label: "eng" }, agoMs: 8 * MINUTE + 11 * SECOND },
  { type: "held", request_id: "CLR-0047", payload: { agent: "refunds-agent", class: "refund", tier: "high" }, agoMs: 3 * MINUTE + 20 * SECOND },
  { type: "routed", request_id: "CLR-0047", payload: { chosen: ["sam"], fallback: null, label: "finance" }, agoMs: 3 * MINUTE + 19 * SECOND },
  { type: "held", request_id: "CLR-0042", payload: { agent: "refunds-agent", class: "refund", tier: "high" }, agoMs: 2 * MINUTE + 14 * SECOND },
  { type: "routed", request_id: "CLR-0042", payload: { chosen: ["sam"], fallback: null, label: "finance" }, agoMs: 2 * MINUTE + 13 * SECOND },
  { type: "ineligible_answer", request_id: "CLR-0042", payload: { user_id: "priya", answer: "allow", reasons: ["requester", "agent_owner"] }, agoMs: 2 * MINUTE },
  { type: "held", request_id: "CLR-0045", payload: { agent: "support-agent", class: "customer_email", tier: "critical" }, agoMs: 65 * SECOND },
  { type: "routed", request_id: "CLR-0045", payload: { chosen: ["priya"], fallback: null, label: "support-lead" }, agoMs: 64 * SECOND },
  { type: "escalated", request_id: "CLR-0047", payload: { step: 0, kind: "add", added: "neha" }, agoMs: 20 * SECOND },
  { type: "held", request_id: "CLR-0044", payload: { agent: "ops-agent", class: "deploy", tier: "critical" }, agoMs: 40 * SECOND },
  { type: "routed", request_id: "CLR-0044", payload: { chosen: ["alex"], fallback: null, label: "eng" }, agoMs: 39 * SECOND },
];

const PEOPLE = [
  { id: "priya", name: "Priya", groups: ["support"], roles: ["support-lead"], agoUntil: null },
  { id: "sam", name: "Sam", groups: ["finance"], roles: ["finance-approver"], agoUntil: null },
  { id: "neha", name: "Neha", groups: ["finance"], roles: ["finance-approver"], agoUntil: null },
  { id: "alex", name: "Alex", groups: ["eng", "eng-leads"], roles: ["eng-oncall"], agoUntil: null },
  { id: "dev", name: "Dev", groups: ["eng"], roles: [], agoUntil: -3 * HOUR },
];

const tierTimes = (low: [number, number | null], medium: [number, number | null], high: [number, number | null], critical: [number, number | null]) => {
  const row = ([answers, median_latency_ms]: [number, number | null]) => ({ answers, median_latency_ms });
  return Object.fromEntries(
    Object.entries({ low: row(low), medium: row(medium), high: row(high), critical: row(critical) }).filter(([, value]) => value.answers > 0),
  );
};

/** Sam approves at the same speed whatever the risk, and Neha takes longer as it rises. The chart should show it. */
const STATS: Record<string, Record<string, unknown>> = {
  sam: {
    answers: 37,
    approvals: 31,
    denials: 6,
    ineligible: 0,
    median_latency_ms: 41_000,
    by_tier: tierTimes([14, 38_000], [9, 41_000], [11, 44_000], [3, 47_000]),
    fast_approvals: 6,
    flags_ignored: 2,
    batch_approvals: 1,
    streaks: 1,
    signals: { fast: 6, flag_ignored: 2, batch: 1, streak: 1 },
    friction: "drill_miss",
    drills: { sent: 2, caught: 1, missed: 1, expired: 0, catch_rate: 0.5 },
  },
  neha: {
    answers: 11,
    approvals: 10,
    denials: 1,
    ineligible: 0,
    median_latency_ms: 71_000,
    by_tier: tierTimes([4, 22_000], [3, 58_000], [3, 164_000], [1, 365_000]),
    fast_approvals: 0,
    flags_ignored: 0,
    batch_approvals: 0,
    streaks: 0,
    signals: {},
    friction: null,
    drills: { sent: 0, caught: 0, missed: 0, expired: 0, catch_rate: null },
  },
  priya: {
    answers: 9,
    approvals: 7,
    denials: 2,
    ineligible: 2,
    median_latency_ms: 56_000,
    by_tier: tierTimes([3, 31_000], [4, 56_000], [2, 118_000], [0, null]),
    fast_approvals: 1,
    flags_ignored: 0,
    batch_approvals: 0,
    streaks: 0,
    signals: { fast: 1 },
    friction: null,
    drills: { sent: 0, caught: 0, missed: 0, expired: 0, catch_rate: null },
  },
  alex: {
    answers: 14,
    approvals: 9,
    denials: 5,
    ineligible: 0,
    median_latency_ms: 95_000,
    by_tier: tierTimes([0, null], [5, 60_000], [7, 95_000], [2, 240_000]),
    fast_approvals: 0,
    flags_ignored: 0,
    batch_approvals: 0,
    streaks: 0,
    signals: {},
    friction: null,
    drills: { sent: 1, caught: 1, missed: 0, expired: 0, catch_rate: 1 },
  },
  dev: {
    answers: 3,
    approvals: 3,
    denials: 0,
    ineligible: 0,
    median_latency_ms: 120_000,
    by_tier: tierTimes([0, null], [0, null], [3, 120_000], [0, null]),
    fast_approvals: 0,
    flags_ignored: 0,
    batch_approvals: 0,
    streaks: 0,
    signals: {},
    friction: null,
    drills: { sent: 0, caught: 0, missed: 0, expired: 0, catch_rate: null },
  },
};

const REPLAYS = [
  {
    agent: "support-agent",
    class: "customer_email",
    bucket: "plain_reply",
    label: "plain replies",
    level: "L1",
    max_level: "L2",
    proposed_level: "L2",
    window_days: 30,
    requests: 64,
    counted: 58,
    fast_excluded: 6,
    denied: 0,
    incidents: 0,
    edited: 0,
    approvers: ["sam", "neha", "priya"],
    would_auto: 58,
    would_auto_approved: 58,
    would_auto_denied: 0,
    meets_criteria: true,
    needs: { approvals: 50, min_distinct_approvers: 2 },
    synthetic_events: 64,
    real_events: 0,
  },
  {
    agent: "refunds-agent",
    class: "refund",
    bucket: "small",
    label: "refunds up to ₹5,000",
    level: "L2",
    max_level: "L3",
    proposed_level: "L3",
    window_days: 30,
    requests: 31,
    counted: 22,
    fast_excluded: 5,
    denied: 4,
    incidents: 0,
    edited: 0,
    approvers: ["sam", "neha"],
    would_auto: 20,
    would_auto_approved: 18,
    would_auto_denied: 2,
    meets_criteria: false,
    needs: { approvals: 50, min_distinct_approvers: 2 },
    synthetic_events: 12,
    real_events: 19,
  },
  {
    agent: "ops-agent",
    class: "deploy",
    bucket: "staging",
    label: "deploys to staging",
    level: "L0",
    max_level: "L2",
    proposed_level: "L1",
    window_days: 14,
    requests: 11,
    counted: 9,
    fast_excluded: 1,
    denied: 1,
    incidents: 1,
    edited: 0,
    approvers: ["alex"],
    would_auto: 3,
    would_auto_approved: 3,
    would_auto_denied: 0,
    meets_criteria: false,
    needs: { approvals: 20, min_distinct_approvers: 2 },
    synthetic_events: 0,
    real_events: 11,
  },
];

const COVERAGE = [
  { vendor: "claude", source: "hook", calls: 412, allowed: 388, held: 19, denied: 5, agoMs: 12 * SECOND },
  { vendor: "codex", source: "hook", calls: 96, allowed: 88, held: 7, denied: 1, agoMs: 65 * SECOND },
  { vendor: "cursor", source: "hook", calls: 31, allowed: 30, held: 1, denied: 0, agoMs: 42 * MINUTE },
  { vendor: "gate", source: "gate", calls: 148, allowed: 121, held: 25, denied: 2, agoMs: 40 * SECOND },
  { vendor: "opencode", source: "hook", calls: 73, allowed: 66, held: 6, denied: 1, agoMs: 39 * SECOND },
];

const json = (value: unknown, status = 200): CoreAnswer => ({ status, body: JSON.stringify(value), contentType: "application/json" });

export function fixtureCore(options: { policyPath: string; startedAtMs?: number }): CoreSource {
  const startedAt = options.startedAtMs ?? Date.now();
  const iso = (agoMs: number) => new Date(startedAt - agoMs).toISOString();
  const policyText = readFileSync(options.policyPath, "utf8");
  const policyHash = createHash("sha256").update(policyText).digest("hex");

  let previous = "0".repeat(64);
  const ledger = [{ type: "policy_loaded", request_id: null, payload: { hash: policyHash, source: "file" }, agoMs: 6 * HOUR }, ...HISTORY]
    .sort((a, b) => b.agoMs - a.agoMs)
    .map((entry, index) => {
      const row = { seq: index + 1, at: iso(entry.agoMs), type: entry.type, request_id: entry.request_id, payload: entry.payload, prev_hash: previous };
      const entryHash = createHash("sha256").update(previous + JSON.stringify(row)).digest("hex");
      previous = entryHash;
      return { ...row, entry_hash: entryHash };
    });

  const describe = (found: OpenRequest) => ({
    id: found.id,
    state: "ROUTED",
    class: found.cls,
    tier: found.tier,
    score: found.score,
    agent: found.agent,
    vendor: found.vendor,
    requester_ids: found.requesters,
    origin_room: found.room,
    flags: found.flags,
    evidence: { description: { headline: found.headline } },
    quorum_required: found.quorum,
    approvals: [],
    created_at: iso(found.agoMs),
    expires_at: iso(found.agoMs - 25 * MINUTE),
  });

  const get = async (path: string): Promise<CoreAnswer> => {
    const url = new URL(path, "http://fixture.invalid");
    if (url.pathname === "/v1/health") return json({ ok: true, policy_hash: policyHash, mode: "enforce", policy_error: null, open_requests: OPEN.length });
    if (url.pathname === "/v1/ledger") return json({ entries: ledger });
    if (url.pathname === "/v1/ledger/verify") return json({ ok: true, count: ledger.length, head: previous });
    if (url.pathname === "/v1/coverage") {
      return json({ vendors: COVERAGE.map(({ agoMs, ...row }) => ({ ...row, last_at: iso(agoMs) })) });
    }
    if (url.pathname === "/v1/requests") return json({ requests: OPEN.map(describe) });
    if (url.pathname === "/v1/people") {
      return json({ people: PEOPLE.map(({ agoUntil, ...person }) => ({ ...person, away: agoUntil === null ? null : { until: iso(agoUntil), delegate_to: "alex" } })) });
    }
    if (url.pathname === "/v1/policy") {
      return json({
        hash: policyHash,
        mode: "enforce",
        source: "file",
        error: null,
        text: policyText,
        classes: [],
        shadow_would_hold: 0,
        pending: {
          proposal: "PRO-0010",
          hash: "9f2c41d07ab36e58c1d2f04b7a9e6c3d1b8f5e20a7c4d96e3f1b0a8c7d6e5f43",
          signed_by: ["sam"],
          quorum: 2,
          detail: "SYNTHETIC. Refunds over ₹1,00,000 need two finance approvers instead of one.",
        },
      });
    }
    if (url.pathname === "/v1/metrics/human-load") {
      return json({
        agent_actions: 760,
        governed_actions: 214,
        human_decisions: 74,
        per_100: 9.7,
        per_100_governed: 34.6,
        by_class: [
          { class: "refund", agent_actions: 96, human_decisions: 37, per_100: 38.5 },
          { class: "deploy", agent_actions: 41, human_decisions: 14, per_100: 34.1 },
          { class: "merge", agent_actions: 28, human_decisions: 12, per_100: 42.9 },
          { class: "customer_email", agent_actions: 49, human_decisions: 11, per_100: 22.4 },
        ],
      });
    }
    if (url.pathname === "/v1/autonomy") {
      return json({
        levels: [
          { agent: "refunds-agent", class: "refund", bucket: "small", level: "L2", since: startedAt - 4 * HOUR + 9 * MINUTE },
          { agent: "support-agent", class: "customer_email", bucket: "plain_reply", level: "L1", since: startedAt - 26 * HOUR },
          { agent: "ops-agent", class: "deploy", bucket: "staging", level: "L0", since: startedAt - 3 * HOUR + 94 * SECOND },
        ],
        proposals: [
          {
            id: "PRO-0009",
            kind: "promotion",
            state: "open",
            quorum: 2,
            signed_by: ["neha"],
            created_at: iso(20 * MINUTE),
            expires_at: iso(20 * MINUTE - DAY),
            decided_at: null,
            title: "Promote support-agent to L2 for plain replies",
            detail: "SYNTHETIC. 58 approvals counted over 30 days from 3 approvers, 6 left out for being too fast, none denied, no incidents.\nThe evidence is the labelled seeded history.",
          },
          {
            id: "PRO-0006",
            kind: "promotion",
            state: "signed",
            quorum: 2,
            signed_by: ["sam", "alex"],
            created_at: iso(4 * HOUR),
            expires_at: iso(4 * HOUR - DAY),
            decided_at: iso(4 * HOUR - 9 * MINUTE),
            title: "Promote refunds-agent to L2 for refunds up to ₹5,000",
            detail: "SYNTHETIC. 52 approvals counted over 30 days.",
          },
        ],
        history: { synthetic: 76, real: 30 },
        buckets: REPLAYS,
      });
    }
    if (url.pathname === "/v1/inbox") {
      const user = url.searchParams.get("user") ?? "";
      const items = OPEN.flatMap((request) =>
        request.holders
          .filter((holder) => holder.user === user)
          .map((holder) => ({
            request_id: request.id,
            handle: holder.handle,
            class: request.cls,
            tier: request.tier,
            what: holder.what,
            room: request.room,
            age_s: Math.round(request.agoMs / SECOND),
            expires_at: iso(request.agoMs - 25 * MINUTE),
          })),
      );
      return json({ user, count: items.length, items, text: "" });
    }
    const stats = /^\/v1\/people\/([^/]+)\/stats$/.exec(url.pathname);
    if (stats) {
      const id = decodeURIComponent(stats[1]!);
      const row = STATS[id];
      if (!row) return json({ error: `no person ${id}` }, 404);
      const openCards = OPEN.reduce((count, request) => count + request.holders.filter((holder) => holder.user === id).length, 0);
      return json({ user: id, ...row, open_cards: openCards });
    }
    const request = /^\/v1\/requests\/([^/]+)$/.exec(url.pathname);
    if (request) {
      const found = OPEN.find((candidate) => candidate.id === decodeURIComponent(request[1]!));
      return found ? json(describe(found)) : json({ error: "no request" }, 404);
    }
    return json({ error: "no such route in the fixture" }, 404);
  };

  const post = async (path: string, body: unknown): Promise<CoreAnswer> => {
    if (path === "/v1/autonomy/simulate") {
      const scope = body as { agent?: string; class?: string; bucket?: string };
      return json({ replays: REPLAYS.filter((row) => (!scope.agent || row.agent === scope.agent) && (!scope.class || row.class === scope.class) && (!scope.bucket || row.bucket === scope.bucket)) });
    }
    if (path !== "/v1/policy/simulate") return json({ error: "no such route in the fixture" }, 404);
    const action = (body as { action?: { business?: { endpoint?: string } } }).action;
    const endpoint = action?.business?.endpoint;
    if (!endpoint) return json({ error: "Expected a call with a business endpoint." }, 400);
    return json({
      decision: "hold",
      reason: "HELD (synthetic fixture): this answer is canned and did not run the policy.",
      class: endpoint.includes("refunds") ? "refund" : endpoint.includes("deploys") ? "deploy" : "customer_email",
      tier: "high",
      score: 55,
      flags: [],
      step: "class_hold",
    });
  };

  return { get, post };
}

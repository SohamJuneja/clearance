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
  { type: "promotion_proposed", request_id: null, payload: { agent: "refunds-agent", class: "refund", bucket: "small", level: "L2", approvals: 22, denied: 0, approvers: 3 }, agoMs: 4 * HOUR },
  { type: "promotion_signed", request_id: null, payload: { agent: "refunds-agent", class: "refund", bucket: "small", level: "L2", signed_by: "sam" }, agoMs: 4 * HOUR - 5 * MINUTE },
  { type: "promotion_signed", request_id: null, payload: { agent: "refunds-agent", class: "refund", bucket: "small", level: "L2", signed_by: "alex" }, agoMs: 4 * HOUR - 9 * MINUTE },
  { type: "held", request_id: "CLR-0036", payload: { agent: "ops-agent", class: "deploy", tier: "high" }, agoMs: 3 * HOUR },
  { type: "routed", request_id: "CLR-0036", payload: { chosen: ["alex"], fallback: null, label: "eng" }, agoMs: 3 * HOUR - SECOND },
  { type: "answered", request_id: "CLR-0036", payload: { user_id: "alex", decision: "deny", latency_ms: 95_000 }, agoMs: 3 * HOUR - 95 * SECOND },
  { type: "denied", request_id: "CLR-0036", payload: { denied_by: "alex" }, agoMs: 3 * HOUR - 95 * SECOND },
  { type: "demoted", request_id: null, payload: { agent: "ops-agent", class: "deploy", bucket: "staging", from: "L1", to: "L0", reason: "denial inside the bucket" }, agoMs: 3 * HOUR - 94 * SECOND },
  { type: "held", request_id: "CLR-0039", payload: { agent: "refunds-agent", class: "refund", tier: "high" }, agoMs: 2 * HOUR },
  { type: "routed", request_id: "CLR-0039", payload: { chosen: ["sam"], fallback: null, label: "finance" }, agoMs: 2 * HOUR - SECOND },
  { type: "ineligible_answer", request_id: "CLR-0039", payload: { user_id: "priya", answer: "allow", reasons: ["requester", "agent_owner"] }, agoMs: 2 * HOUR - 20 * SECOND },
  { type: "answered", request_id: "CLR-0039", payload: { user_id: "sam", decision: "deny", latency_ms: 62_000 }, agoMs: 2 * HOUR - 62 * SECOND },
  { type: "denied", request_id: "CLR-0039", payload: { denied_by: "sam" }, agoMs: 2 * HOUR - 62 * SECOND },
  { type: "held", request_id: "CLR-0041", payload: { agent: "ops-agent", class: "deploy", tier: "high" }, agoMs: 70 * MINUTE },
  { type: "routed", request_id: "CLR-0041", payload: { chosen: ["alex"], fallback: null, label: "eng" }, agoMs: 70 * MINUTE - SECOND },
  { type: "escalated", request_id: "CLR-0041", payload: { step: 0, kind: "add", added: "dev" }, agoMs: 65 * MINUTE },
  { type: "expired", request_id: "CLR-0041", payload: { after_ms: 25 * MINUTE }, agoMs: 45 * MINUTE },
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

const STATS: Record<string, { answers: number; approvals: number; denials: number; ineligible: number; median_latency_ms: number | null }> = {
  sam: { answers: 37, approvals: 31, denials: 6, ineligible: 0, median_latency_ms: 48_000 },
  neha: { answers: 11, approvals: 10, denials: 1, ineligible: 0, median_latency_ms: 71_000 },
  priya: { answers: 9, approvals: 7, denials: 2, ineligible: 2, median_latency_ms: 56_000 },
  alex: { answers: 14, approvals: 9, denials: 5, ineligible: 0, median_latency_ms: 95_000 },
  dev: { answers: 3, approvals: 3, denials: 0, ineligible: 0, median_latency_ms: 120_000 },
};

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
  const policyHash = createHash("sha256").update(readFileSync(options.policyPath, "utf8")).digest("hex");

  let previous = "0".repeat(64);
  const ledger = [...HISTORY]
    .sort((a, b) => b.agoMs - a.agoMs)
    .map((entry, index) => {
      const row = { seq: index + 1, at: iso(entry.agoMs), type: entry.type, request_id: entry.request_id, payload: entry.payload, prev_hash: previous };
      const entryHash = createHash("sha256").update(previous + JSON.stringify(row)).digest("hex");
      previous = entryHash;
      return { ...row, entry_hash: entryHash };
    });

  const get = async (path: string): Promise<CoreAnswer> => {
    const url = new URL(path, "http://fixture.invalid");
    if (url.pathname === "/v1/health") return json({ ok: true, policy_hash: policyHash, policy_error: null, open_requests: OPEN.length });
    if (url.pathname === "/v1/ledger") return json({ entries: ledger });
    if (url.pathname === "/v1/ledger/verify") return json({ ok: true, count: ledger.length, head: previous });
    if (url.pathname === "/v1/export.csv") {
      const rows = ledger.map((entry) => [entry.seq, entry.at, entry.type, entry.request_id ?? "", entry.entry_hash].join(","));
      return { status: 200, body: `# SYNTHETIC fixture data\nseq,at,type,request_id,entry_hash\n${rows.join("\n")}\n`, contentType: "text/csv" };
    }
    if (url.pathname === "/v1/coverage") {
      return json({ vendors: COVERAGE.map(({ agoMs, ...row }) => ({ ...row, last_at: iso(agoMs) })) });
    }
    if (url.pathname === "/v1/autonomy") {
      return json({
        levels: [
          { agent: "refunds-agent", class: "refund", bucket: "small", level: "L2", since: startedAt - 4 * HOUR + 9 * MINUTE },
          { agent: "support-agent", class: "customer_email", bucket: "plain_reply", level: "L1", since: startedAt - 26 * HOUR },
          { agent: "ops-agent", class: "deploy", bucket: "staging", level: "L0", since: startedAt - 3 * HOUR + 94 * SECOND },
        ],
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
      if (found) {
        return json({
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
      }
      // CLR-0031 and friends have closing entries, so the Desk never asks about them.
      return json({ error: "no request" }, 404);
    }
    return json({ error: "no such route in the fixture" }, 404);
  };

  const post = async (path: string, body: unknown): Promise<CoreAnswer> => {
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

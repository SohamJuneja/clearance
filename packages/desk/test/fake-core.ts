/**
 * A fake clearance-core over real HTTP, for tests and the browser run. Its shapes follow
 * packages/core/src/api/server.ts. Its numbers are deliberately odd, so a test can tell "the Desk shows
 * core's 137" from a value that merely looks plausible. Test data only: it never reaches a screenshot.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

export const FAKE_TOKEN = "fake-internal-token-do-not-leak";

const POLICY_TEXT = readFileSync(resolve(import.meta.dirname, "../../../policy/clearance.policy.yaml"), "utf8");
export const POLICY_FILE_HASH = createHash("sha256").update(POLICY_TEXT).digest("hex");

export type Seen = { method: string; path: string; authorization: string | undefined; body: string };

type Entry = { seq: number; at: string; type: string; request_id: string | null; payload: Record<string, unknown>; prev_hash: string; entry_hash: string };

type Stats = {
  user: string;
  answers: number;
  approvals: number;
  denials: number;
  ineligible: number;
  median_latency_ms: number | null;
  open_cards: number;
  by_tier: Record<string, { answers: number; median_latency_ms: number | null }>;
  fast_approvals: number;
  flags_ignored: number;
  batch_approvals: number;
  streaks: number;
  signals: Record<string, number>;
  friction: string | null;
  drills: { sent: number; caught: number; missed: number; expired: number; catch_rate: number | null };
};

export type FakeReplay = {
  agent: string;
  class: string;
  bucket: string;
  label: string;
  level: string;
  max_level: string;
  proposed_level: string | null;
  window_days: number;
  requests: number;
  counted: number;
  fast_excluded: number;
  denied: number;
  incidents: number;
  edited: number;
  approvers: string[];
  would_auto: number;
  would_auto_approved: number;
  would_auto_denied: number;
  meets_criteria: boolean;
  needs: { approvals: number; min_distinct_approvers: number };
  synthetic_events: number;
  real_events: number;
};

export type FakeData = {
  health: { ok: boolean; policy_hash: string; mode: string; policy_error: string | null; open_requests: number };
  ledger: Entry[];
  verify: { ok: boolean; count: number; head: string; firstBad?: { seq: number; reason: string } };
  requests: Record<string, Record<string, unknown>>;
  /** Open drills. Core's list leaves them out, and /v1/requests/:id shows them like anything else until they close. */
  openDrills: Set<string>;
  people: { id: string; name: string; groups: string[]; roles: string[]; away: { until: string; delegate_to: string | null } | null }[];
  inboxes: Record<string, { request_id: string; handle: string | null; class: string; tier: string; what: string; room: string | null; age_s: number; expires_at: string }[]>;
  stats: Record<string, Stats>;
  levels: { agent: string; class: string; bucket: string; level: string; since: number }[];
  proposals: Record<string, unknown>[];
  evidence: { synthetic: number; real: number };
  buckets: FakeReplay[];
  humanLoad: { agent_actions: number; governed_actions: number; human_decisions: number; per_100: number | null; per_100_governed: number | null; by_class: { class: string; agent_actions: number; human_decisions: number; per_100: number | null }[] };
  coverage: { vendor: string; source: string; calls: number; allowed: number; held: number; denied: number; last_at: string | null }[];
  policy: { hash: string; mode: string; source: string; error: string | null; text: string; classes: string[]; shadow_would_hold: number; pending: { proposal: string; hash: string; signed_by: string[]; quorum: number; detail: string } | null };
  simulation: Record<string, unknown>;
};

const person = (user: string, numbers: Partial<Stats>): Stats => ({
  user,
  answers: 0,
  approvals: 0,
  denials: 0,
  ineligible: 0,
  median_latency_ms: null,
  open_cards: 0,
  by_tier: {},
  fast_approvals: 0,
  flags_ignored: 0,
  batch_approvals: 0,
  streaks: 0,
  signals: {},
  friction: null,
  drills: { sent: 0, caught: 0, missed: 0, expired: 0, catch_rate: null },
  ...numbers,
});

export function fakeData(nowMs: number): FakeData {
  const ago = (ms: number) => new Date(nowMs - ms).toISOString();
  const entry = (seq: number, type: string, request_id: string | null, payload: Record<string, unknown>, agoMs: number): Entry => ({
    seq,
    at: ago(agoMs),
    type,
    request_id,
    payload,
    prev_hash: `prev${seq}`,
    entry_hash: `hash${seq}aabbccdd`,
  });
  return {
    health: { ok: true, policy_hash: "abc123def456", mode: "enforce", policy_error: null, open_requests: 2 },
    ledger: [
      entry(1, "policy_loaded", null, { hash: "abc123def456", source: "file" }, 900_000),
      entry(2, "held", "CLR-0007", { agent: "refunds-agent", class: "refund", tier: "low" }, 800_000),
      entry(3, "routed", "CLR-0007", { chosen: ["sam"], fallback: null }, 799_000),
      entry(4, "approved", "CLR-0007", { approved_by: ["sam"], quorum: 1 }, 700_000),
      entry(5, "executed", "CLR-0007", { ok: true }, 699_000),
      entry(6, "held", "CLR-0011", { agent: "refunds-agent", class: "refund", tier: "high" }, 263_000),
      entry(7, "routed", "CLR-0011", { chosen: ["sam"], fallback: null }, 262_000),
      entry(8, "escalated", "CLR-0011", { step: 0, after_ms: 180_000, kind: "add", added: "neha" }, 83_000),
      entry(9, "held", "CLR-0012", { agent: "coder", class: "merge", tier: "critical" }, 47_000),
      entry(10, "routed", "CLR-0012", { chosen: [], fallback: { group: "eng", room: "#eng", reason: "everyone in eng is excluded", eligible: [] } }, 46_000),
      entry(11, "promotion_proposed", "PRO-0003", { agent: "refunds-agent", class: "refund", bucket: "small", from: "L1", level: "L2", quorum: 2 }, 40_000),
      entry(12, "demoted", "CLR-0007", { agent: "ops-agent", class: "deploy", bucket: "staging", from: "L1", to: "L0" }, 30_000),
    ],
    verify: { ok: true, count: 12, head: "hash12aabbccdd" },
    requests: {
      "CLR-0011": {
        id: "CLR-0011",
        state: "ROUTED",
        class: "refund",
        tier: "high",
        score: 71,
        call_hash: "h1",
        target: "POST /acme/refunds",
        agent: "refunds-agent",
        vendor: "gate",
        source: "gate",
        requester_ids: ["priya"],
        agent_owner_id: "priya",
        origin_room: "!room-support",
        origin_thread: null,
        flags: [
          { code: "amount_vs_order", text: "Amount is 10x the order total" },
          { code: "new_destination", text: "Destination added in the last 24 h" },
        ],
        evidence: { description: { headline: "REFUND ₹43,219", call: [], context: [] } },
        quorum_required: 1,
        approvals: [],
        created_at: ago(263_000),
        expires_at: ago(263_000 - 1_500_000),
        decided_at: null,
      },
      "CLR-0012": {
        id: "CLR-0012",
        state: "ROUTED",
        class: "merge",
        tier: "critical",
        score: 83,
        call_hash: "h2",
        target: "POST /github/merge",
        agent: "coder",
        vendor: "gate",
        source: "gate",
        requester_ids: ["alex"],
        agent_owner_id: "alex",
        origin_room: "!room-eng",
        origin_thread: null,
        flags: [],
        evidence: { description: { headline: "MERGE acme/acme-mini-app#412", call: [], context: [] } },
        quorum_required: 2,
        approvals: ["dev"],
        created_at: ago(47_000),
        expires_at: ago(47_000 - 1_500_000),
        decided_at: null,
      },
    },
    openDrills: new Set(),
    people: [
      { id: "priya", name: "Priya", groups: ["support"], roles: ["support-lead"], away: null },
      { id: "sam", name: "Sam", groups: ["finance"], roles: ["finance-approver"], away: null },
      { id: "neha", name: "Neha", groups: ["finance"], roles: ["finance-approver"], away: null },
      { id: "alex", name: "Alex", groups: ["eng", "eng-leads"], roles: ["eng-oncall"], away: { until: ago(-7_200_000), delegate_to: "dev" } },
      { id: "dev", name: "Dev", groups: ["eng"], roles: [], away: null },
    ],
    inboxes: {
      sam: [{ request_id: "CLR-0011", handle: "A17", class: "refund", tier: "high", what: "refund ₹43,219", room: "#support", age_s: 263, expires_at: ago(263_000 - 1_500_000) }],
      neha: [{ request_id: "CLR-0011", handle: "A18", class: "refund", tier: "high", what: "refund ₹43,219", room: "#support", age_s: 263, expires_at: ago(263_000 - 1_500_000) }],
    },
    stats: {
      priya: person("priya", { answers: 13, approvals: 11, denials: 2, ineligible: 3, median_latency_ms: 57_000, by_tier: { low: { answers: 13, median_latency_ms: 57_000 } } }),
      sam: person("sam", {
        answers: 41,
        approvals: 29,
        denials: 12,
        median_latency_ms: 137_000,
        open_cards: 1,
        by_tier: {
          low: { answers: 17, median_latency_ms: 41_000 },
          medium: { answers: 9, median_latency_ms: 43_000 },
          high: { answers: 13, median_latency_ms: 137_000 },
          critical: { answers: 2, median_latency_ms: 301_000 },
        },
        fast_approvals: 5,
        flags_ignored: 3,
        batch_approvals: 2,
        streaks: 1,
        signals: { fast: 5, flag_ignored: 3, batch: 2, streak: 1, odd_hours: 4 },
        friction: "fast",
        drills: { sent: 4, caught: 2, missed: 1, expired: 1, catch_rate: 2 / 3 },
      }),
      neha: person("neha", { answers: 7, approvals: 6, denials: 1, open_cards: 1 }),
      alex: person("alex", { answers: 19, approvals: 17, denials: 2, ineligible: 1, median_latency_ms: 4_000, fast_approvals: 8, flags_ignored: 1, by_tier: { high: { answers: 19, median_latency_ms: 4_000 } }, friction: "drill_miss", drills: { sent: 1, caught: 0, missed: 1, expired: 0, catch_rate: 0 } }),
      dev: person("dev", {}),
    },
    levels: [
      { agent: "refunds-agent", class: "refund", bucket: "small", level: "L2", since: nowMs - 3_600_000 },
      { agent: "support-agent", class: "customer_email", bucket: "plain_reply", level: "L1", since: nowMs - 7_200_000 },
    ],
    proposals: [
      {
        id: "PRO-0003",
        kind: "promotion",
        state: "open",
        quorum: 2,
        signed_by: ["sam"],
        created_at: ago(40_000),
        expires_at: ago(40_000 - 86_400_000),
        decided_at: null,
        title: "Promote refunds-agent to L2 for small refunds",
        detail: "61 approvals counted over 30 days, 7 left out for being too fast.",
        agent: "refunds-agent",
        class: "refund",
        bucket: "small",
        label: "small refunds",
        from: "L1",
        level: "L2",
        synthetic: false,
      },
    ],
    evidence: { synthetic: 83, real: 29 },
    buckets: [
      {
        agent: "refunds-agent",
        class: "refund",
        bucket: "small",
        label: "small refunds",
        level: "L1",
        max_level: "L3",
        proposed_level: "L2",
        window_days: 30,
        requests: 73,
        counted: 61,
        fast_excluded: 7,
        denied: 5,
        incidents: 0,
        edited: 0,
        approvers: ["sam", "neha", "priya"],
        would_auto: 59,
        would_auto_approved: 57,
        would_auto_denied: 2,
        meets_criteria: true,
        needs: { approvals: 50, min_distinct_approvers: 2 },
        synthetic_events: 83,
        real_events: 19,
      },
      {
        agent: "ops-agent",
        class: "deploy",
        bucket: "staging",
        label: "staging deploys",
        level: "L0",
        max_level: "L2",
        proposed_level: null,
        window_days: 14,
        requests: 11,
        counted: 9,
        fast_excluded: 1,
        denied: 1,
        incidents: 2,
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
    ],
    humanLoad: {
      agent_actions: 1_537,
      governed_actions: 613,
      human_decisions: 80,
      per_100: 5.2,
      per_100_governed: 13.1,
      by_class: [
        { class: "refund", agent_actions: 211, human_decisions: 47, per_100: 22.3 },
        { class: "deploy", agent_actions: 0, human_decisions: 3, per_100: null },
      ],
    },
    coverage: [
      { vendor: "claude", source: "hook", calls: 137, allowed: 121, held: 13, denied: 3, last_at: ago(10_000) },
      { vendor: "codex", source: "hook", calls: 59, allowed: 53, held: 5, denied: 1, last_at: ago(3_000_000) },
      { vendor: "gate", source: "gate", calls: 211, allowed: 170, held: 37, denied: 4, last_at: ago(5_000) },
    ],
    policy: { hash: "abc123def456", mode: "enforce", source: "file", error: null, text: POLICY_TEXT, classes: ["refund", "deploy", "merge"], shadow_would_hold: 0, pending: null },
    simulation: { decision: "hold", reason: "HELD: refunds over ₹10,000 need finance approval", class: "refund", tier: "high", score: 71, flags: [{ code: "amount_vs_order", text: "Amount is 10x the order total" }], step: "class_hold" },
  };
}

/** Adds what core writes for one thing that happened, and moves the count and head its verify route reports. */
export function appendEntry(data: FakeData, type: string, requestId: string | null, payload: Record<string, unknown> = {}): Entry {
  const seq = (data.ledger.at(-1)?.seq ?? 0) + 1;
  const entry: Entry = { seq, at: new Date(Date.parse(data.ledger.at(-1)?.at ?? "2026-11-06T10:00:00.000Z") + 1000).toISOString(), type, request_id: requestId, payload, prev_hash: `prev${seq}`, entry_hash: `hash${seq}aabbccdd` };
  data.ledger.push(entry);
  data.verify.count = data.ledger.length;
  data.verify.head = entry.entry_hash;
  return entry;
}

/** Everything core does when it sends a drill. Each is something a careless Desk could pass on. */
export function openFakeDrill(data: FakeData, id = "CLR-0013", user = "sam"): void {
  appendEntry(data, "drill_sent", id, { agent: "refunds-agent", class: "refund", tier: "high" });
  appendEntry(data, "routed", id, { chosen: [user], fallback: null });
  data.openDrills.add(id);
  const at = data.ledger.at(-1)!.at;
  data.requests[id] = {
    id,
    state: "ROUTED",
    class: "refund",
    tier: "high",
    score: 62,
    agent: "refunds-agent",
    vendor: "gate",
    requester_ids: ["priya"],
    origin_room: null,
    flags: [],
    evidence: { description: { headline: "REFUND ₹91,357" } },
    quorum_required: 1,
    approvals: [],
    created_at: at,
    expires_at: at,
  };
  (data.inboxes[user] ??= []).push({ request_id: id, handle: "A99", class: "refund", tier: "high", what: "refund ₹91,357", room: "#support", age_s: 1, expires_at: at });
  const stats = data.stats[user]!;
  stats.open_cards += 1;
  stats.drills.sent += 1;
}

export function closeFakeDrill(data: FakeData, id = "CLR-0013", user = "sam", result: "caught" | "missed" | "expired" = "caught"): void {
  appendEntry(data, "drill_result", id, { result, user_id: user, flaw: "secret_flaw_id", latency_ms: 90_217 });
  data.openDrills.delete(id);
  data.requests[id] = { ...data.requests[id], state: result === "caught" ? "DENIED" : "VOIDED", is_drill: true };
  data.inboxes[user] = (data.inboxes[user] ?? []).filter((item) => item.request_id !== id);
  const stats = data.stats[user]!;
  stats.open_cards -= 1;
  stats.drills[result] += 1;
  const { caught, missed } = stats.drills;
  stats.drills.catch_rate = caught + missed > 0 ? caught / (caught + missed) : null;
}

const OPEN_STATES = new Set(["HELD", "ROUTED", "ESCALATED"]);

export type FakeCore = {
  url: string;
  data: FakeData;
  seen: Seen[];
  /** Added to every answer, to model a real core's work. */
  delayMs: number;
  /** Forces every answer to this status. */
  forceStatus: number | null;
  /** Replaces one path's body, to model core answering something unexpected. */
  override: Map<string, { status: number; body: string }>;
  close: () => Promise<void>;
};

export async function startFakeCore(nowMs = Date.now()): Promise<FakeCore> {
  const fake: FakeCore = { url: "", data: fakeData(nowMs), seen: [], delayMs: 0, forceStatus: null, override: new Map(), close: async () => {} };

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake.invalid");
      const path = url.pathname + url.search;
      fake.seen.push({ method: req.method ?? "", path, authorization: req.headers.authorization, body });
      const send = (status: number, value: unknown, type = "application/json") => {
        setTimeout(() => {
          res.writeHead(fake.forceStatus ?? status, { "content-type": type });
          res.end(typeof value === "string" ? value : JSON.stringify(value));
        }, fake.delayMs);
      };
      if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) return send(401, { error: "unauthorized" });
      const override = fake.override.get(url.pathname);
      if (override) return send(override.status, override.body);
      const { data } = fake;
      if (req.method === "POST" && url.pathname === "/v1/policy/simulate") {
        const parsed = JSON.parse(body) as { action?: unknown };
        return parsed.action ? send(200, data.simulation) : send(400, { error: "expected {action}" });
      }
      if (req.method === "POST" && url.pathname === "/v1/autonomy/simulate") {
        const scope = JSON.parse(body) as { agent?: string; class?: string; bucket?: string };
        const replays = data.buckets.filter((row) => (!scope.agent || row.agent === scope.agent) && (!scope.class || row.class === scope.class) && (!scope.bucket || row.bucket === scope.bucket));
        return send(200, { replays });
      }
      if (req.method !== "GET") return send(404, { error: "no such route" });
      if (url.pathname === "/v1/health") return send(200, data.health);
      if (url.pathname === "/v1/ledger") {
        const id = url.searchParams.get("request_id");
        return send(200, { entries: id ? data.ledger.filter((entry) => entry.request_id === id) : data.ledger });
      }
      if (url.pathname === "/v1/ledger/verify") return send(200, data.verify);
      if (url.pathname === "/v1/coverage") return send(200, { vendors: data.coverage });
      if (url.pathname === "/v1/autonomy") return send(200, { levels: data.levels, proposals: data.proposals, history: data.evidence, buckets: data.buckets });
      if (url.pathname === "/v1/metrics/human-load") return send(200, data.humanLoad);
      if (url.pathname === "/v1/policy") return send(200, data.policy);
      if (url.pathname === "/v1/people") return send(200, { people: data.people });
      // Core's real export holds everything, drills included. The Desk must not pass it on.
      if (url.pathname === "/v1/export.csv") return send(200, `seq,type\n${data.ledger.map((entry) => `${entry.seq},${entry.type}`).join("\n")}\n`, "text/csv");
      if (url.pathname === "/v1/requests") {
        const open = Object.values(data.requests).filter((row) => OPEN_STATES.has(String(row.state)) && !data.openDrills.has(String(row.id)));
        return send(200, { requests: url.searchParams.get("state") === "open" ? open : Object.values(data.requests) });
      }
      if (url.pathname === "/v1/inbox") {
        const user = url.searchParams.get("user") ?? "";
        if (!data.stats[user]) return send(404, { error: `no person ${user}` });
        const items = data.inboxes[user] ?? [];
        return send(200, { user, count: items.length, items, text: "" });
      }
      const stats = /^\/v1\/people\/([^/]+)\/stats$/.exec(url.pathname);
      if (stats) {
        const row = data.stats[decodeURIComponent(stats[1]!)];
        return row ? send(200, row) : send(404, { error: "no person" });
      }
      const request = /^\/v1\/requests\/([^/]+)$/.exec(url.pathname);
      if (request) {
        const row = data.requests[decodeURIComponent(request[1]!)];
        return row ? send(200, row) : send(404, { error: "no request" });
      }
      return send(404, { error: "no such route" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake;
}

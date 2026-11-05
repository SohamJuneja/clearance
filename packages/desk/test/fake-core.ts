/**
 * A fake clearance-core over real HTTP, for tests and the browser run. Its shapes follow
 * packages/core/src/api/server.ts. Its numbers are deliberately odd, so a test can tell "the Desk shows
 * core's 137" from a value that merely looks plausible. Test data only: it never reaches a screenshot.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_TOKEN = "fake-internal-token-do-not-leak";

export type Seen = { method: string; path: string; authorization: string | undefined; body: string };

export type FakeData = {
  health: { ok: boolean; policy_hash: string; policy_error: string | null; open_requests: number };
  ledger: { seq: number; at: string; type: string; request_id: string | null; payload: Record<string, unknown>; prev_hash: string; entry_hash: string }[];
  verify: { ok: boolean; count: number; head: string; firstBad?: { seq: number; reason: string } };
  requests: Record<string, Record<string, unknown>>;
  inboxes: Record<string, { request_id: string; handle: string | null; class: string; tier: string; what: string; room: string | null; age_s: number; expires_at: string }[]>;
  stats: Record<string, { user: string; answers: number; approvals: number; denials: number; ineligible: number; median_latency_ms: number | null; open_cards: number }>;
  levels: { agent: string; class: string; bucket: string; level: string; since: number }[];
  coverage: { vendor: string; source: string; calls: number; allowed: number; held: number; denied: number; last_at: string | null }[];
  simulation: Record<string, unknown>;
};

export function fakeData(nowMs: number): FakeData {
  const ago = (ms: number) => new Date(nowMs - ms).toISOString();
  const entry = (seq: number, type: string, request_id: string | null, payload: Record<string, unknown>, agoMs: number) => ({
    seq,
    at: ago(agoMs),
    type,
    request_id,
    payload,
    prev_hash: `prev${seq}`,
    entry_hash: `hash${seq}`,
  });
  return {
    health: { ok: true, policy_hash: "abc123def456", policy_error: null, open_requests: 2 },
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
      entry(11, "promotion_proposed", null, { agent: "refunds-agent", class: "refund", bucket: "small", level: "L2" }, 40_000),
      entry(12, "demoted", null, { agent: "ops-agent", class: "deploy", bucket: "staging", to: "L0" }, 30_000),
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
        is_drill: false,
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
        is_drill: false,
      },
    },
    inboxes: {
      sam: [{ request_id: "CLR-0011", handle: "A17", class: "refund", tier: "high", what: "refund ₹43,219", room: "#support", age_s: 263, expires_at: ago(263_000 - 1_500_000) }],
      neha: [{ request_id: "CLR-0011", handle: "A18", class: "refund", tier: "high", what: "refund ₹43,219", room: "#support", age_s: 263, expires_at: ago(263_000 - 1_500_000) }],
    },
    stats: {
      priya: { user: "priya", answers: 13, approvals: 11, denials: 2, ineligible: 3, median_latency_ms: 57_000, open_cards: 0 },
      sam: { user: "sam", answers: 41, approvals: 29, denials: 12, ineligible: 0, median_latency_ms: 137_000, open_cards: 1 },
      neha: { user: "neha", answers: 7, approvals: 6, denials: 1, ineligible: 0, median_latency_ms: null, open_cards: 1 },
      alex: { user: "alex", answers: 19, approvals: 17, denials: 2, ineligible: 1, median_latency_ms: 4_000, open_cards: 0 },
      dev: { user: "dev", answers: 0, approvals: 0, denials: 0, ineligible: 0, median_latency_ms: null, open_cards: 0 },
    },
    levels: [
      { agent: "refunds-agent", class: "refund", bucket: "small", level: "L2", since: nowMs - 3_600_000 },
      { agent: "support-agent", class: "customer_email", bucket: "plain_reply", level: "L1", since: nowMs - 7_200_000 },
    ],
    coverage: [
      { vendor: "claude", source: "hook", calls: 137, allowed: 121, held: 13, denied: 3, last_at: ago(10_000) },
      { vendor: "codex", source: "hook", calls: 59, allowed: 53, held: 5, denied: 1, last_at: ago(3_000_000) },
      { vendor: "gate", source: "gate", calls: 211, allowed: 170, held: 37, denied: 4, last_at: ago(5_000) },
    ],
    simulation: { decision: "hold", reason: "HELD: refunds over ₹10,000 need finance approval", class: "refund", tier: "high", score: 71, flags: [{ code: "amount_vs_order", text: "Amount is 10x the order total" }], step: "class_hold" },
  };
}

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
      if (req.method !== "GET") return send(404, { error: "no such route" });
      if (url.pathname === "/v1/health") return send(200, data.health);
      if (url.pathname === "/v1/ledger") return send(200, { entries: data.ledger });
      if (url.pathname === "/v1/ledger/verify") return send(200, data.verify);
      if (url.pathname === "/v1/coverage") return send(200, { vendors: data.coverage });
      if (url.pathname === "/v1/autonomy") return send(200, { levels: data.levels });
      if (url.pathname === "/v1/export.csv") return send(200, "seq,at,type\n1,now,held\n", "text/csv");
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

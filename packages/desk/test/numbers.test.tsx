/**
 * PLAN F12: "Every number on the Desk matches the API." Each tab is rendered from what the Desk's server
 * returned for a fake core, and every number on it is read back and compared with the fake core's own
 * data, not with the view's input. Test data only.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AutonomyView, CoverageView, LedgerVerification, LedgerView, PeopleView, PersonDetail, PolicyView, QueueView } from "../src/shared/api";
import { httpCore } from "../src/server/core-source";
import { createDeskServer } from "../src/server/server";
import { formatCount, formatDuration, formatLatency, formatPercent, formatRate } from "../src/web/format";
import { AutonomyTab, CoverageTab, LedgerTab, PeopleTab, PersonRecord, PolicyTab, QueueTab } from "../src/web/views";
import { FAKE_TOKEN, POLICY_FILE_HASH, startFakeCore, type FakeCore } from "./fake-core";

const REPO = resolve(import.meta.dirname, "../../..");
const NOW = Date.parse("2026-11-06T10:00:00.000Z");

let core: FakeCore;
let desk: Server;
let base: string;

beforeEach(async () => {
  core = await startFakeCore(NOW);
  desk = createDeskServer({
    core: httpCore({ url: core.url, token: FAKE_TOKEN }),
    synthetic: false,
    distDir: resolve(REPO, "packages/desk/dist"),
    policyPath: resolve(REPO, "policy/clearance.policy.yaml"),
    teamPath: resolve(REPO, "policy/team.yaml"),
  });
  await new Promise<void>((done) => desk.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(desk.address() as AddressInfo).port}`;
});

afterEach(async () => {
  desk.closeAllConnections();
  await new Promise((done) => desk.close(done));
  await core.close();
});

const api = async <T,>(path: string) => (await (await fetch(`${base}${path}`)).json()) as T;

/** The text inside the element with this test id, with any markup inside it removed. */
function cell(html: string, testId: string): string {
  const start = html.indexOf(`data-testid="${testId}"`);
  if (start < 0) throw new Error(`no element ${testId} in the page`);
  const open = html.indexOf(">", start) + 1;
  const tag = html.lastIndexOf("<", start);
  const name = /^<([a-z0-9]+)/.exec(html.slice(tag))![1]!;
  let depth = 1;
  const pattern = new RegExp(`<(/?)${name}\\b[^>]*>`, "g");
  pattern.lastIndex = open;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return html.slice(open, match.index).replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").trim();
  }
  throw new Error(`unclosed ${testId}`);
}

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => match[1]!);
const page = (element: ReactElement) => renderToStaticMarkup(element);

describe("Queue", () => {
  const load = async () => page(<QueueTab data={await api<QueueView>("/api/queue")} nowMs={NOW} />);

  it("counts what core's open list holds", async () => {
    expect(cell(await load(), "queue-open")).toBe(String(core.data.health.open_requests));
    core.data.requests["CLR-0012"]!.state = "APPROVED";
    expect(cell(await load(), "queue-open")).toBe("1");
  });

  it("says the list can run behind Switch, and that a card still needs an answer, all the time so it says nothing", async () => {
    expect(await load()).toContain("a card you have there still needs your answer, whether or not it is listed");
  });

  it("derives ages and the time left from core's timestamps", async () => {
    const html = await load();
    expect(cell(html, "queue-age-CLR-0011")).toBe(formatDuration(NOW - Date.parse(core.data.requests["CLR-0011"]!.created_at as string)));
    expect(cell(html, "queue-age-CLR-0011")).toBe("4m 23s");
    expect(cell(html, "queue-age-CLR-0012")).toBe("47s");
    expect(cell(html, "queue-oldest")).toBe("4m 23s");
    expect(cell(html, "queue-expires-CLR-0011")).toBe("in 20m 37s");
  });

  it("shows the score and tier core gave", async () => {
    const html = await load();
    expect(cell(html, "queue-score-CLR-0011")).toBe(`Score ${core.data.requests["CLR-0011"]!.score}`);
    expect(cell(html, "queue-score-CLR-0012")).toBe(`Score ${core.data.requests["CLR-0012"]!.score}`);
    expect(cell(html, "queue-critical")).toBe("1");
  });

  it("shows the escalation step, counted from the ledger", async () => {
    const html = await load();
    expect(cell(html, "queue-escalation-CLR-0011")).toBe("Step 1 of 3");
    expect(cell(html, "queue-escalation-CLR-0012")).toBe("No ladder");
    expect(cell(html, "queue-escalated")).toBe("1");
  });

  it("names the handles to answer with, and the quorum so far", async () => {
    const html = await load();
    expect(cell(html, "queue-waiting-CLR-0011")).toBe("Sam A17Neha A18");
    expect(cell(html, "queue-waiting-CLR-0012")).toContain("Eng in #eng");
    expect(cell(html, "queue-waiting-CLR-0012")).toContain("1 of 2 approvals");
  });

  it("says a request has not escalated yet, rather than counting from step zero", async () => {
    core.data.ledger = core.data.ledger.filter((entry) => entry.type !== "escalated");
    const html = await load();
    expect(cell(html, "queue-escalation-CLR-0011")).toBe("Not escalated");
    expect(html).toContain("Ladder has 3 steps");
    expect(cell(html, "queue-escalated")).toBe("0");
  });

  it("shows the headline from the evidence", async () => {
    expect(cell(await load(), "queue-headline-CLR-0011")).toBe("REFUND ₹43,219");
  });

  it("has an honest empty state", async () => {
    core.data.ledger = [];
    core.data.requests = {};
    const html = await load();
    expect(html).toContain("No open requests listed.");
    expect(cell(html, "queue-open")).toBe("0");
    expect(cell(html, "queue-oldest")).toBe("–");
  });
});

describe("Ledger", () => {
  const load = async () => page(<LedgerTab data={await api<LedgerView>("/api/ledger")} verify={await api<LedgerVerification>("/api/ledger/verify")} />);

  it("shows core's chain status, at the newest entry listed, which is core's own head when nothing is left out", async () => {
    expect(cell(await load(), "chain-badge")).toContain(`Chain intact through entry ${core.data.verify.count} · head ${core.data.verify.head.slice(0, 8)}`);
  });

  it("says drills are left out, so that a skipped number is no surprise", async () => {
    expect(await load()).toContain("Drills are left out of this list and its export, so the numbers can skip");
  });

  it("shows a broken chain, with where and why", async () => {
    core.data.verify = { ok: false, count: 6, head: "x", firstBad: { seq: 7, reason: "entry_hash does not match the entry's contents" } };
    const html = await load();
    expect(cell(html, "chain-badge")).toBe("✕ Chain broken at entry 7: entry_hash does not match the entry's contents");
    expect(html).toContain("status-bad");
  });

  it("lists every entry newest first, with core's sequence numbers", async () => {
    const html = await load();
    expect(cell(html, "ledger-count")).toBe(`${core.data.ledger.length} of ${core.data.ledger.length}`);
    const rows = [...html.matchAll(/data-testid="ledger-row-(\d+)"/g)].map((match) => Number(match[1]));
    expect(rows).toEqual(core.data.ledger.map((entry) => entry.seq).reverse());
    expect(cell(html, "ledger-type-8")).toBe("Escalated");
  });

  it("caps the table but says so, and never hides how many there are", async () => {
    core.data.ledger = Array.from({ length: 450 }, (_, index) => ({ seq: index + 1, at: new Date(NOW).toISOString(), type: "held", request_id: "CLR-1", payload: {}, prev_hash: "", entry_hash: "" }));
    const html = await load();
    expect(cell(html, "ledger-count")).toBe("Newest 300 of 450 matching");
    expect(html).toContain('data-testid="ledger-row-450"');
    expect(html).not.toContain('data-testid="ledger-row-150"');
  });

  it("names people in the detail, not ids", async () => {
    const html = await load();
    expect(html).toContain("Backup added: Neha");
    expect(html).toContain("To Sam");
    expect(html).not.toContain("To sam");
  });

  it("offers the real export", async () => {
    expect(await load()).toContain('href="/api/export.csv"');
  });
});

describe("Coverage", () => {
  const load = async () => page(<CoverageTab data={await api<CoverageView>("/api/coverage")} nowMs={NOW} />);

  it("shows core's counts in every vendor and enforcement point cell", async () => {
    const html = await load();
    for (const row of core.data.coverage) {
      const id = `coverage-${row.vendor}-${row.source}`;
      expect(cell(html, `${id}-calls`), id).toBe(formatCount(row.calls));
      expect(cell(html, `${id}-allowed`), id).toBe(formatCount(row.allowed));
      expect(cell(html, `${id}-held`), id).toBe(formatCount(row.held));
      expect(cell(html, `${id}-denied`), id).toBe(formatCount(row.denied));
    }
  });

  it("totals are the sum of what core returned", async () => {
    const html = await load();
    const sum = (key: "calls" | "held" | "denied") => core.data.coverage.reduce((total, row) => total + row[key], 0);
    expect(cell(html, "coverage-total-calls")).toBe(formatCount(sum("calls")));
    expect(cell(html, "coverage-total-held")).toBe(formatCount(sum("held")));
    expect(cell(html, "coverage-total-denied")).toBe(formatCount(sum("denied")));
    expect(sum("calls")).toBe(407);
  });

  it("counts vendors from real traffic, and says so when one has sent nothing", async () => {
    const html = await load();
    expect(cell(html, "coverage-vendors-seen")).toBe("2 of 4");
    expect(cell(html, "coverage-opencode-hook")).toBe("No traffic seen");
    expect(cell(html, "coverage-cursor-hook")).toBe("No traffic seen");
  });

  it("does not imply a vendor skipped the gate: core can't split gate calls by vendor yet, and the page says so", async () => {
    const html = await load();
    expect(html).not.toContain('data-testid="coverage-claude-gate"');
    expect(cell(html, "coverage-gate-gate")).toContain("Core records every gate call under vendor");
    expect(html).toContain('rowSpan="4"');
  });

  it("gives each vendor its own gate cell as soon as core attributes them", async () => {
    core.data.coverage.push({ vendor: "claude", source: "gate", calls: 23, allowed: 20, held: 3, denied: 0, last_at: new Date(NOW).toISOString() });
    const html = await load();
    expect(cell(html, "coverage-claude-gate-calls")).toBe("23");
    expect(html).not.toContain("Core records every gate call");
  });

  it("shows live status from the last call's time", async () => {
    const html = await load();
    expect(cell(html, "coverage-claude-hook-status")).toBe("✓ Live, 10s ago");
    expect(cell(html, "coverage-codex-hook-status")).toBe("– Last seen 50m 00s ago");
  });
});

const noReplay = async () => ({ replays: [] });

describe("Autonomy", () => {
  const load = async () => page(<AutonomyTab data={await api<AutonomyView>("/api/autonomy")} replay={noReplay} />);

  it("shows core's level for each agent, class and scope", async () => {
    const html = await load();
    for (const row of core.data.levels) expect(cell(html, `autonomy-level-${row.agent}-${row.class}-${row.bucket}`)).toBe(row.level);
  });

  it("says plainly when nobody has been promoted, which is core's real default", async () => {
    core.data.levels = [];
    expect(await load()).toContain("Every agent is at L0, Always ask.");
  });

  it("shows human decisions per 100 from core's own route", async () => {
    const html = await load();
    const load100 = core.data.humanLoad;
    expect(cell(html, "load-per-100")).toBe(String(load100.per_100));
    expect(cell(html, "load-per-100-governed")).toBe(String(load100.per_100_governed));
    expect(cell(html, "load-actions")).toBe(formatCount(load100.agent_actions));
    expect(cell(html, "load-decisions")).toBe(formatCount(load100.human_decisions));
    for (const row of load100.by_class) {
      expect(cell(html, `load-${row.class}-actions`)).toBe(formatCount(row.agent_actions));
      expect(cell(html, `load-${row.class}-decisions`)).toBe(formatCount(row.human_decisions));
      expect(cell(html, `load-${row.class}-per-100`)).toBe(formatRate(row.per_100));
    }
    expect(cell(html, "load-deploy-per-100")).toBe("–");
  });

  it("shows no traffic as a dash, never a rate of zero", async () => {
    core.data.humanLoad = { agent_actions: 0, governed_actions: 0, human_decisions: 0, per_100: null, per_100_governed: null, by_class: [] };
    const html = await load();
    expect(cell(html, "load-per-100")).toBe("–");
    expect(html).toContain("No real traffic yet.");
  });

  it("shows core's numbers for every replayed scope, with real and synthetic evidence told apart", async () => {
    const html = await load();
    for (const row of core.data.buckets) {
      const id = `replay-${row.agent}-${row.class}-${row.bucket}`;
      expect(cell(html, `${id}-counted`), id).toBe(`${row.counted} of ${row.needs.approvals}`);
      expect(cell(html, `${id}-fast`), id).toBe(String(row.fast_excluded));
      expect(cell(html, `${id}-denied`), id).toBe(String(row.denied));
      expect(cell(html, `${id}-incidents`), id).toBe(String(row.incidents));
      expect(cell(html, `${id}-approvers`), id).toBe(`${row.approvers.length} of ${row.needs.min_distinct_approvers}`);
      expect(cell(html, `${id}-auto`), id).toBe(String(row.would_auto));
      expect(cell(html, `${id}-auto-split`), id).toBe(`${row.would_auto_approved} approved, ${row.would_auto_denied} denied`);
    }
    expect(cell(html, "replay-refunds-agent-refund-small-level")).toContain("L1 to L2");
    expect(cell(html, "replay-refunds-agent-refund-small-meets")).toContain("Met");
    expect(cell(html, "replay-ops-agent-deploy-staging-meets")).toContain("Not yet");
    expect(cell(html, "replay-refunds-agent-refund-small-evidence")).toBe("19 real83 synthetic");
    expect(cell(html, "replay-ops-agent-deploy-staging-evidence")).toBe("11 real");
    expect(cell(html, "replay-note")).toContain(`${core.data.evidence.real} real, ${core.data.evidence.synthetic} labelled synthetic`);
  });

  it("shows who has signed a proposal, of how many, and that nothing is signed here", async () => {
    const html = await load();
    expect(cell(html, "proposal-PRO-0003-signed")).toBe("1 of 2");
    expect(cell(html, "proposal-PRO-0003-state")).toBe("Open");
    expect(html).toContain("Promote refunds-agent to L2 for small refunds");
    expect(html).toContain("sign on its card in Switch");
  });

  it("shows history from the ledger, in words, with people named", async () => {
    core.data.ledger.push({ seq: 13, at: new Date(NOW).toISOString(), type: "promotion_signed", request_id: "PRO-0003", payload: { agent: "refunds-agent", class: "refund", bucket: "small", level: "L2", signed_by: ["sam", "alex"] }, prev_hash: "", entry_hash: "" });
    const html = await load();
    expect(html).toContain("Promotion proposed");
    expect(html).toContain("refunds-agent · refund · small: L1 to L2");
    expect(html).toContain("signed by Sam, Alex");
    expect(html).toContain("ops-agent · deploy · staging: L1 to L0");
  });

  it("says when nothing has been proposed or replayed yet", async () => {
    core.data.proposals = [];
    core.data.buckets = [];
    const html = await load();
    expect(html).toContain("No promotion has been proposed yet.");
    expect(html).toContain("No scope has any recorded history yet.");
  });
});

describe("People, the team view", () => {
  const load = async () => page(<PeopleTab data={await api<PeopleView>("/api/people")} viewing="" onView={() => {}} />);
  const sum = (key: "answers" | "approvals" | "denials" | "fast_approvals" | "flags_ignored" | "batch_approvals" | "streaks") => formatCount(Object.values(core.data.stats).reduce((total, row) => total + row[key], 0));

  it("shows the sum of what core returned for each person", async () => {
    const html = await load();
    expect(cell(html, "team-answers")).toBe(sum("answers"));
    expect(cell(html, "team-approvals")).toBe(sum("approvals"));
    expect(cell(html, "team-denials")).toBe(sum("denials"));
    expect(cell(html, "team-fast")).toBe(sum("fast_approvals"));
    expect(cell(html, "team-flags")).toBe(sum("flags_ignored"));
    expect(cell(html, "team-batch")).toBe(sum("batch_approvals"));
    expect(cell(html, "team-streaks")).toBe(sum("streaks"));
    expect(cell(html, "team-answers")).toBe("80");
  });

  it("shows nobody's own number, and says where those are", async () => {
    const html = await load();
    expect(html).toContain("private to that person and the team admin");
    expect(html).not.toContain('data-testid="person-');
    expect(cell(html, "people-row-sam")).not.toMatch(/\d/);
    expect(html).toContain("medians don&#x27;t add up across people");
  });

  it("offers the admin's view, labelled as that, for each person", async () => {
    const html = await load();
    for (const person of core.data.people) expect(html).toContain(`Admin&#x27;s view: ${person.name}`);
  });

  it("says who is away and who covers", async () => {
    const html = await load();
    expect(cell(html, "people-away-alex")).toContain("Dev covering");
    expect(cell(html, "people-away-sam")).toBe("–");
  });

  it("says drill totals come only in groups", async () => {
    expect(cell(await load(), "team-drills")).toBe("Drill totals appear once 3 have finished, so that nobody's own result can be worked out.");
    expect(cell(await load(), "team-drills-finished")).toBe("0");
  });
});

describe("People, the admin's view of one person", () => {
  const load = async (id = "sam") => page(<PersonRecord data={await api<PersonDetail>(`/api/people/${id}`)} />);

  it("says what it is, whose it is, and who should not see it", async () => {
    const banner = cell(await load(), "people-admin-banner");
    expect(banner).toContain("Admin's view of Sam.");
    expect(banner).toContain("Private to Sam and the team admin.");
    expect(banner).toContain("don't show this screen to the team");
  });

  it("shows core's numbers", async () => {
    const html = await load();
    const stats = core.data.stats.sam!;
    expect(cell(html, "person-answers")).toBe(String(stats.answers));
    expect(cell(html, "person-approvals")).toBe(String(stats.approvals));
    expect(cell(html, "person-denials")).toBe(String(stats.denials));
    expect(cell(html, "person-latency")).toBe(formatLatency(stats.median_latency_ms));
    expect(cell(html, "person-fast")).toBe(String(stats.fast_approvals));
    expect(cell(html, "person-flags")).toBe(String(stats.flags_ignored));
    expect(cell(html, "person-batch")).toBe(String(stats.batch_approvals));
    expect(cell(html, "person-streaks")).toBe(String(stats.streaks));
    expect(cell(html, "person-ineligible")).toBe(String(stats.ineligible));
    expect(cell(html, "person-signal-odd_hours")).toBe("4");
  });

  it("charts core's median for each tier, with the count beside it", async () => {
    const html = await load();
    for (const [tier, row] of Object.entries(core.data.stats.sam!.by_tier)) {
      expect(cell(html, `person-tier-${tier}-latency`), tier).toBe(formatLatency(row.median_latency_ms));
      expect(cell(html, `person-tier-${tier}-answers`), tier).toBe(String(row.answers));
    }
  });

  it("says no answers for an empty tier, never a zero-length bar that looks measured", async () => {
    const html = await load("alex");
    expect(cell(html, "person-tier-low-latency")).toBe("No answers");
    expect(cell(html, "person-tier-low-answers")).toBe("0");
    expect(cell(html, "person-tier-high-latency")).toBe(formatLatency(4_000));
  });

  it("gives a dash for no answers at all", async () => {
    expect(cell(await load("neha"), "person-latency")).toBe("–");
  });

  it("shows drill results, with the rate core worked out", async () => {
    const html = await load();
    const { drills } = core.data.stats.sam!;
    expect(cell(html, "person-drills-caught")).toBe(String(drills.caught));
    expect(cell(html, "person-drills-missed")).toBe(String(drills.missed));
    expect(cell(html, "person-drills-finished")).toBe(String(drills.caught + drills.missed + drills.expired));
    expect(cell(html, "person-drills-rate")).toBe(formatPercent(drills.catch_rate));
    expect(cell(html, "person-drills-rate")).toBe("67%");
    expect(cell(html, "person-drills-note")).toContain(`${drills.expired} not answered`);
  });

  it("gives no catch rate before there is one, rather than zero", async () => {
    expect(cell(await load("neha"), "person-drills-rate")).toBe("–");
  });

  it("says why friction is on, in words", async () => {
    expect(cell(await load(), "person-friction")).toContain("after fast approvals");
    expect(cell(await load("alex"), "person-friction")).toContain("after a missed drill");
    expect(cell(await load("neha"), "person-friction")).toBe("No extra friction is on.");
  });
});

describe("Policy", () => {
  const load = async () => page(<PolicyTab data={await api<PolicyView>("/api/policy")} simulate={async () => core.data.simulation as never} />);
  const sign = () => {
    core.data.policy.hash = "c0ffee123456";
    core.data.ledger.push({ seq: 13, at: new Date(NOW).toISOString(), type: "policy_loaded", request_id: null, payload: { hash: "c0ffee123456", source: "proposal", approved_by: ["sam", "alex"] }, prev_hash: "", entry_hash: "" });
  };

  it("marks a match as good, with no explanation needed", async () => {
    core.data.policy.hash = POLICY_FILE_HASH;
    const html = await load();
    expect(cell(html, "policy-hash")).toContain("Core is enforcing this file");
    expect(html).toContain("status-good");
    expect(html).not.toContain('data-testid="policy-relation"');
  });

  it("explains a signed version without looking like an alarm", async () => {
    sign();
    const html = await load();
    expect(cell(html, "policy-hash")).toContain("Core is enforcing a signed version · c0ffee12");
    const why = cell(html, "policy-relation");
    expect(why).toContain("Signed by Sam and Alex.");
    expect(why).toContain("doesn't write it back to the file");
    expect(why).toContain(POLICY_FILE_HASH.slice(0, 8));
    expect(why).toContain("That is expected");
    expect(html).not.toContain("status-bad");
    expect(html).not.toContain("warning-line");
  });

  it("explains the other ways they can differ, also without an alarm", async () => {
    let html = await load();
    expect(cell(html, "policy-relation")).toContain("Core's version is the one in force");
    expect(html).not.toContain("status-bad");
    core.data.policy.pending = { proposal: "PRO-0002", hash: POLICY_FILE_HASH, signed_by: [], quorum: 2, detail: "" };
    html = await load();
    expect(cell(html, "policy-relation")).toContain("waiting for signatures");
    expect(html).not.toContain("status-bad");
  });

  it("shows a pending change, how far along it is, and where it gets signed", async () => {
    core.data.policy.pending = { proposal: "PRO-0002", hash: "ddeeff001122", signed_by: ["neha"], quorum: 2, detail: "Raises the refund limit" };
    const html = await load();
    expect(cell(html, "policy-pending")).toContain("PRO-0002");
    expect(cell(html, "policy-pending")).toContain("version ddeeff00");
    expect(cell(html, "policy-pending-signed")).toBe("1 of 2 signed: Neha");
    expect(cell(html, "policy-pending-detail")).toBe("Raises the refund limit");
    expect(html).toContain("Signed on its card in Switch");
  });

  it("shows no pending section when nothing is pending", async () => {
    expect(await load()).not.toContain('data-testid="policy-pending"');
  });

  it("says what shadow mode has been doing", async () => {
    core.data.policy.text = core.data.policy.text.replace(/^mode: \w+/m, "mode: shadow");
    core.data.policy.mode = "shadow";
    core.data.policy.shadow_would_hold = 23;
    expect(cell(await load(), "policy-shadow")).toContain("23 calls so far");
  });

  it("shows a refused reload", async () => {
    core.data.policy.error = "line 12: bad tier";
    expect(cell(await load(), "policy-error")).toContain("line 12: bad tier");
  });

  it("shows the policy core is enforcing", async () => {
    const html = await load();
    expect(html).toContain('data-testid="policy-class-refund"');
    expect(html).toContain("Always denied, with a reason.");
    expect(cell(html, "policy-text")).toContain("protected_config");
  });
});

describe("no tab can approve or deny", () => {
  const tabs = async () => ({
    queue: page(<QueueTab data={await api<QueueView>("/api/queue")} nowMs={NOW} />),
    ledger: page(<LedgerTab data={await api<LedgerView>("/api/ledger")} verify={await api<LedgerVerification>("/api/ledger/verify")} />),
    coverage: page(<CoverageTab data={await api<CoverageView>("/api/coverage")} nowMs={NOW} />),
    autonomy: page(<AutonomyTab data={await api<AutonomyView>("/api/autonomy")} replay={noReplay} />),
    people: page(<PeopleTab data={await api<PeopleView>("/api/people")} viewing="" onView={() => {}} />),
    person: page(<PersonRecord data={await api<PersonDetail>("/api/people/sam")} />),
    policy: page(<PolicyTab data={await api<PolicyView>("/api/policy")} simulate={async () => core.data.simulation as never} />),
  });

  it("the only button anywhere is the simulator's, which records nothing", async () => {
    const all = await tabs();
    expect(buttons(all.queue)).toEqual([]);
    expect(buttons(all.ledger)).toEqual([]);
    expect(buttons(all.coverage)).toEqual([]);
    expect(buttons(all.autonomy)).toEqual([]);
    expect(buttons(all.people)).toEqual([]);
    expect(buttons(all.person)).toEqual([]);
    expect(buttons(all.policy)).toEqual(["Run the policy on this call"]);
  });

  it("no link goes anywhere but the export", async () => {
    const all = await tabs();
    const links = Object.values(all).flatMap((html) => [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) => match[1]));
    expect(links).toEqual(["/api/export.csv"]);
  });
});

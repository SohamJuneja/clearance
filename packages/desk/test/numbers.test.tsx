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
import type { AutonomyView, CoverageView, LedgerVerification, LedgerView, PeopleView, PolicyView, QueueView } from "../src/shared/api";
import { httpCore } from "../src/server/core-source";
import { createDeskServer } from "../src/server/server";
import { formatCount, formatDuration, formatLatency } from "../src/web/format";
import { AutonomyTab, CoverageTab, LedgerTab, PeopleTab, PolicyTab, QueueTab } from "../src/web/views";
import { FAKE_TOKEN, startFakeCore, type FakeCore } from "./fake-core";

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

  it("shows core's open count, not a count of its own", async () => {
    expect(cell(await load(), "queue-open")).toBe(String(core.data.health.open_requests));
    core.data.health.open_requests = 9;
    const html = await load();
    expect(cell(html, "queue-open")).toBe("9");
    expect(cell(html, "queue-disagreement")).toContain("Core reports 9 open, but the Desk found 2");
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
    core.data.health.open_requests = 0;
    const html = await load();
    expect(html).toContain("Nothing is waiting on a person.");
    expect(cell(html, "queue-open")).toBe("0");
    expect(cell(html, "queue-oldest")).toBe("–");
  });
});

describe("Ledger", () => {
  const load = async () => page(<LedgerTab data={await api<LedgerView>("/api/ledger")} verify={await api<LedgerVerification>("/api/ledger/verify")} />);

  it("shows core's chain status and count", async () => {
    expect(cell(await load(), "chain-badge")).toContain(`Chain intact · ${core.data.verify.count} entries · head hash12aa`);
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

describe("Autonomy", () => {
  const load = async () => page(<AutonomyTab data={await api<AutonomyView>("/api/autonomy")} />);

  it("shows core's level for each agent, class and scope", async () => {
    const html = await load();
    for (const row of core.data.levels) expect(cell(html, `autonomy-level-${row.agent}-${row.class}-${row.bucket}`)).toBe(row.level);
  });

  it("says plainly when nobody has been promoted, which is core's real default", async () => {
    core.data.levels = [];
    expect(await load()).toContain("Every agent is at L0, Always ask.");
  });

  it("shows history from the ledger, and an honest gap for what core doesn't serve", async () => {
    const html = await load();
    expect(html).toContain("Promotion proposed");
    expect(html).toContain("Demoted");
    expect(cell(html, "na-replay")).toContain("Not available yet");
    expect(cell(html, "na-decisions")).toContain("Not available yet");
  });
});

describe("People", () => {
  const load = async () => page(<PeopleTab data={await api<PeopleView>("/api/people")} nowMs={NOW} />);

  it("shows core's stats for each person", async () => {
    const html = await load();
    for (const [id, stats] of Object.entries(core.data.stats)) {
      expect(cell(html, `people-${id}-open`), id).toBe(String(stats.open_cards));
      expect(cell(html, `people-${id}-answers`), id).toBe(String(stats.answers));
      expect(cell(html, `people-${id}-approvals`), id).toBe(String(stats.approvals));
      expect(cell(html, `people-${id}-denials`), id).toBe(String(stats.denials));
      expect(cell(html, `people-${id}-ineligible`), id).toBe(String(stats.ineligible));
      expect(cell(html, `people-${id}-latency`), id).toBe(formatLatency(stats.median_latency_ms));
    }
  });

  it("shows a dash for a person with no answers yet, never a zero that looks measured", async () => {
    expect(cell(await load(), "people-neha-latency")).toBe("–");
  });

  it("says when core doesn't know someone, rather than showing zeros", async () => {
    delete core.data.stats.dev;
    expect(cell(await load(), "people-dev-unknown")).toContain("does not know this person");
  });

  it("says what is not available yet, instead of leaving it out or making it up", async () => {
    const html = await load();
    for (const id of ["na-latency-tier", "na-signals", "na-drills"]) expect(cell(html, id)).toContain("Not available yet");
  });

  it("says who may see this tab", async () => {
    expect(await load()).toContain("visible to each person and the team admin");
  });
});

describe("Policy", () => {
  const load = async () => page(<PolicyTab data={await api<PolicyView>("/api/policy")} simulate={async () => core.data.simulation as never} />);

  it("shows core's version, and whether the file matches it", async () => {
    expect(cell(await load(), "policy-hash")).toContain("Core is enforcing abc123de");
    expect(cell(await load(), "policy-hash")).toContain("but this file is");
  });

  it("shows a refused reload", async () => {
    core.data.health.policy_error = "line 12: bad tier";
    expect(cell(await load(), "policy-error")).toContain("line 12: bad tier");
  });

  it("shows the real file", async () => {
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
    autonomy: page(<AutonomyTab data={await api<AutonomyView>("/api/autonomy")} />),
    people: page(<PeopleTab data={await api<PeopleView>("/api/people")} nowMs={NOW} />),
    policy: page(<PolicyTab data={await api<PolicyView>("/api/policy")} simulate={async () => core.data.simulation as never} />),
  });

  it("the only button anywhere is the simulator's, which records nothing", async () => {
    const all = await tabs();
    expect(buttons(all.queue)).toEqual([]);
    expect(buttons(all.ledger)).toEqual([]);
    expect(buttons(all.coverage)).toEqual([]);
    expect(buttons(all.autonomy)).toEqual([]);
    expect(buttons(all.people)).toEqual([]);
    expect(buttons(all.policy)).toEqual(["Run the policy on this call"]);
  });

  it("no link goes anywhere but the export", async () => {
    const all = await tabs();
    const links = Object.values(all).flatMap((html) => [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) => match[1]));
    expect(links).toEqual(["/api/export.csv"]);
  });
});

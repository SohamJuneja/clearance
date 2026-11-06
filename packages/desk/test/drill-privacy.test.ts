/**
 * An approver who opens the Desk must not be able to spot a live drill (PLAN F9). The rule is the ledger mirror's:
 * hide open drills, never publish a drill's entries, and give totals only in groups of 3.
 *
 * The test that matters most compares every route byte for byte around a drill, so it catches a new field or route
 * that leaks without anyone having thought of it. real-core.test.tsx runs the same rule on the real core's drills.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AutonomyView, LedgerVerification, LedgerView, PeopleView, PersonDetail, QueueView } from "../src/shared/api";
import { httpCore } from "../src/server/core-source";
import { createDeskServer } from "../src/server/server";
import { drillsWithoutResult, ledgerCsv, teamDrillTotals, teamLedger } from "../src/server/team-view";
import { appendEntry, closeFakeDrill, FAKE_TOKEN, openFakeDrill, startFakeCore, type FakeCore } from "./fake-core";

const REPO = resolve(import.meta.dirname, "../../..");
const SECRET_LATENCY = "90217";
const SECRET_FLAW = "secret_flaw_id";

let core: FakeCore;
let desk: Server;
let base: string;

beforeEach(async () => {
  core = await startFakeCore();
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

const text = async (path: string) => {
  const res = await fetch(`${base}${path}`);
  expect(res.status, path).toBe(200);
  return res.text();
};
const json = async <T,>(path: string) => JSON.parse(await text(path)) as T;

/** Everything the page can ask for. The admin's view of the person holding the drill is on the list on purpose. */
const EVERY_READ = ["/api/health", "/api/queue", "/api/ledger", "/api/ledger/verify", "/api/export.csv", "/api/coverage", "/api/autonomy", "/api/people", "/api/people/sam", "/api/policy"];

const snapshot = async () => Object.fromEntries(await Promise.all(EVERY_READ.map(async (path) => [path, await text(path)] as const)));

/** A real request that arrives after the drill, with a real card. */
function holdRealRequest(id = "CLR-0014"): void {
  appendEntry(core.data, "held", id, { agent: "refunds-agent", class: "refund", tier: "high" });
  appendEntry(core.data, "routed", id, { chosen: ["neha"], fallback: null });
  core.data.requests[id] = { ...core.data.requests["CLR-0011"], id, created_at: core.data.ledger.at(-1)!.at };
  core.data.inboxes.neha!.push({ request_id: id, handle: "A40", class: "refund", tier: "high", what: "refund ₹43,219", room: "#support", age_s: 1, expires_at: core.data.ledger.at(-1)!.at });
  core.data.health.open_requests += 1;
}

describe("while a drill is open", () => {
  it("every route answers byte for byte as it did before, so there is nothing to compare", async () => {
    const before = await snapshot();
    openFakeDrill(core.data);
    expect(await snapshot()).toEqual(before);
  });

  it("stays that way when a real request arrives too, so one missing card says nothing", async () => {
    const before = await snapshot();
    openFakeDrill(core.data);
    holdRealRequest();
    const during = await snapshot();
    for (const path of ["/api/queue", "/api/ledger", "/api/ledger/verify", "/api/export.csv", "/api/health"]) expect(during[path], path).toBe(before[path]);
    expect(during["/api/queue"]).not.toContain("CLR-0014");
  });

  it("leaves no hole in the entry numbers, whatever core has written since", async () => {
    openFakeDrill(core.data);
    holdRealRequest();
    const seqs = (await json<LedgerView>("/api/ledger")).entries.map((entry) => entry.seq);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect((await json<LedgerVerification>("/api/ledger/verify")).through_seq).toBe(12);
    expect(core.data.verify.count).toBe(16);
  });

  it("gives nothing away in the Queue about a card someone is holding", async () => {
    openFakeDrill(core.data);
    const queue = await text("/api/queue");
    expect(queue).not.toContain("CLR-0013");
    expect(queue).not.toContain("A99");
    expect(queue).not.toContain("91,357");
    expect((JSON.parse(queue) as QueueView).open_count).toBe(2);
  });

  it("still lets a real request leave the Queue when someone answers it", async () => {
    openFakeDrill(core.data);
    core.data.requests["CLR-0012"]!.state = "APPROVED";
    expect((await json<QueueView>("/api/queue")).requests.map((item) => item.id)).toEqual(["CLR-0011"]);
  });

  it("holds back the Autonomy history with the Ledger, so the two tabs can't be compared", async () => {
    const before = await text("/api/autonomy");
    openFakeDrill(core.data);
    appendEntry(core.data, "demoted", "CLR-0011", { agent: "refunds-agent", class: "refund", bucket: "small", from: "L2", to: "L0" });
    expect(await text("/api/autonomy")).toBe(before);

    closeFakeDrill(core.data);
    expect((await json<AutonomyView>("/api/autonomy")).history.map((entry) => entry.type)).toEqual(["promotion_proposed", "demoted", "demoted"]);
  });

  it("stands still at the first drill when two overlap, until the last has closed", async () => {
    openFakeDrill(core.data, "CLR-0013", "sam");
    openFakeDrill(core.data, "CLR-0015", "neha");
    holdRealRequest();
    closeFakeDrill(core.data, "CLR-0013", "sam");
    expect((await json<LedgerView>("/api/ledger")).entries.at(-1)!.seq).toBe(12);
    expect(await text("/api/queue")).not.toContain("CLR-0014");

    closeFakeDrill(core.data, "CLR-0015", "neha");
    expect(await text("/api/queue")).toContain("CLR-0014");
  });

  it("is still honest about a broken chain", async () => {
    openFakeDrill(core.data);
    core.data.verify = { ok: false, count: 6, head: "x", firstBad: { seq: 7, reason: "entry_hash does not match" } };
    expect(await json<LedgerVerification>("/api/ledger/verify")).toMatchObject({ ok: false, firstBad: { seq: 7 } });
  });
});

describe("once it has closed", () => {
  const closedDrill = () => {
    openFakeDrill(core.data);
    holdRealRequest();
    closeFakeDrill(core.data);
  };

  it("brings back the real entries it held, in order, and none of the drill's", async () => {
    closedDrill();
    const { entries } = await json<LedgerView>("/api/ledger");
    expect(entries.map((entry) => entry.seq)).toEqual([...Array.from({ length: 12 }, (_, index) => index + 1), 15, 16]);
    expect(entries.some((entry) => entry.request_id === "CLR-0014")).toBe(true);
    expect(entries.some((entry) => entry.request_id === "CLR-0013")).toBe(false);
    expect((await json<QueueView>("/api/queue")).requests.map((item) => item.id)).toEqual(["CLR-0011", "CLR-0012", "CLR-0014"]);
  });

  it("publishes nothing that says who was asked, what they did, how fast, or what the flaw was", async () => {
    closedDrill();
    for (const path of ["/api/ledger", "/api/export.csv", "/api/queue", "/api/autonomy", "/api/ledger/verify"]) {
      const body = await text(path);
      expect(body, path).not.toContain("CLR-0013");
      expect(body, path).not.toContain(SECRET_FLAW);
      expect(body, path).not.toContain(SECRET_LATENCY);
      expect(body, path).not.toMatch(/drill_/);
    }
  });

  it("keeps back an entry on the drill that isn't called drill_: a refused answer says who tried", async () => {
    openFakeDrill(core.data);
    appendEntry(core.data, "ineligible_answer", "CLR-0013", { user_id: "alex", reasons: ["not_routed"] });
    closeFakeDrill(core.data);
    const { entries } = await json<LedgerView>("/api/ledger");
    expect(entries.some((entry) => entry.type === "ineligible_answer" && entry.request_id === "CLR-0013")).toBe(false);
  });

  it("the badge reports the newest entry the team can read, not one of the drill's", async () => {
    openFakeDrill(core.data);
    closeFakeDrill(core.data);
    const { entries } = await json<LedgerView>("/api/ledger");
    expect(await json<LedgerVerification>("/api/ledger/verify")).toEqual({ ok: true, through_seq: entries.at(-1)!.seq, head: entries.at(-1)!.entry_hash });
    expect(core.data.verify.count).toBe(15);
    expect(entries.at(-1)!.seq).toBe(12);
  });

  it("the export holds the same entries as the page, and never asks core for its whole file", async () => {
    closedDrill();
    const { entries } = await json<LedgerView>("/api/ledger");
    expect(await text("/api/export.csv")).toBe(ledgerCsv(entries));
    expect(core.seen.some((call) => call.path.startsWith("/v1/export.csv"))).toBe(false);
  });

  it("goes back to moving when a drill closes with no result, as a cancelled one does", async () => {
    openFakeDrill(core.data);
    core.data.openDrills.delete("CLR-0013");
    core.data.requests["CLR-0013"] = { ...core.data.requests["CLR-0013"], state: "CANCELLED", is_drill: true };
    holdRealRequest();
    expect(await text("/api/queue")).toContain("CLR-0014");
  });

  it("goes back to moving if core no longer knows the request at all", async () => {
    openFakeDrill(core.data);
    core.data.openDrills.delete("CLR-0013");
    delete core.data.requests["CLR-0013"];
    holdRealRequest();
    expect(await text("/api/queue")).toContain("CLR-0014");
  });

  it("only asks core about a drill with no result yet", async () => {
    openFakeDrill(core.data);
    closeFakeDrill(core.data);
    core.seen.length = 0;
    await text("/api/ledger");
    expect(core.seen.some((call) => call.path.startsWith("/v1/requests/"))).toBe(false);
  });
});

describe("results", () => {
  const finish = (id: string, user: string, result: "caught" | "missed" | "expired") => {
    openFakeDrill(core.data, id, user);
    closeFakeDrill(core.data, id, user, result);
  };
  const team = async () => (await json<PeopleView>("/api/people")).team.drills;

  it("the team gets none until 3 have finished", async () => {
    expect(await team()).toEqual({ finished: 0, caught: 0, missed: 0, expired: 0, group: 3 });
    finish("CLR-0021", "sam", "missed");
    expect((await team()).finished).toBe(0);
    finish("CLR-0022", "neha", "caught");
    expect((await team()).finished).toBe(0);
  });

  it("moves in whole groups, so two totals can't isolate one person", async () => {
    finish("CLR-0021", "sam", "missed");
    finish("CLR-0022", "neha", "caught");
    finish("CLR-0023", "alex", "expired");
    expect(await team()).toEqual({ finished: 3, caught: 1, missed: 1, expired: 1, group: 3 });
    finish("CLR-0024", "sam", "caught");
    finish("CLR-0025", "neha", "caught");
    expect(await team()).toEqual({ finished: 3, caught: 1, missed: 1, expired: 1, group: 3 });
    finish("CLR-0026", "alex", "caught");
    expect(await team()).toEqual({ finished: 6, caught: 4, missed: 1, expired: 1, group: 3 });
  });

  it("does not move while another drill is open, even if one finishes", async () => {
    finish("CLR-0021", "sam", "caught");
    finish("CLR-0022", "neha", "caught");
    openFakeDrill(core.data, "CLR-0023", "alex");
    finish("CLR-0024", "sam", "missed");
    expect((await team()).finished).toBe(0);
    closeFakeDrill(core.data, "CLR-0023", "alex", "caught");
    expect(await team()).toEqual({ finished: 3, caught: 2, missed: 1, expired: 0, group: 3 });
  });

  it("does not count a drill nobody saw", () => {
    expect(teamDrillTotals(["caught", "not_sent", "missed"]).finished).toBe(0);
    expect(teamDrillTotals(["caught", "not_sent", "missed", "expired"])).toEqual({ finished: 3, caught: 1, missed: 1, expired: 1, group: 3 });
  });

  it("names nobody in the team view, and the person's own result stays on the admin's view", async () => {
    finish("CLR-0021", "sam", "missed");
    finish("CLR-0022", "sam", "caught");
    finish("CLR-0023", "sam", "caught");
    const people = await text("/api/people");
    expect(people).not.toContain("catch_rate");
    expect(people).not.toContain("friction");
    expect(people).not.toContain("by_tier");
    expect(people).not.toContain("median_latency_ms");

    const sam = await json<PersonDetail>("/api/people/sam");
    expect(sam.stats.drills.caught).toBe(core.data.stats.sam!.drills.caught);
    expect(sam.stats.drills.missed).toBe(core.data.stats.sam!.drills.missed);
  });

  it("the admin's view holds nothing that counts an open drill", async () => {
    const sam = await text("/api/people/sam");
    expect(sam).not.toContain("open_cards");
    expect(sam).not.toContain('"sent"');
    expect(sam).not.toContain("inbox");
  });
});

describe("the rule on its own", () => {
  const entry = (seq: number, type: string, request_id: string | null, payload: Record<string, unknown> = {}) => ({ seq, at: "", type, request_id, payload, prev_hash: "", entry_hash: "" });

  it("finds a drill with no result, and not one that has one", () => {
    const entries = [entry(1, "drill_sent", "A"), entry(2, "drill_sent", "B"), entry(3, "drill_result", "A", { result: "caught" })];
    expect(drillsWithoutResult(entries)).toEqual(["B"]);
  });

  it("shows everything when there are no drills, the same entries in the same order", () => {
    const entries = [entry(1, "policy_loaded", null), entry(2, "held", "A"), entry(3, "approved", "A")];
    expect(teamLedger(entries, new Set())).toEqual({ entries, holdingBack: false, drillResults: [] });
  });

  it("treats a drill as open only when told it is, so a closed one can't hold anything back", () => {
    const entries = [entry(1, "drill_sent", "D"), entry(2, "held", "A")];
    expect(teamLedger(entries, new Set()).entries.map((row) => row.seq)).toEqual([2]);
    expect(teamLedger(entries, new Set()).holdingBack).toBe(false);
    expect(teamLedger(entries, new Set(["D"]))).toEqual({ entries: [], holdingBack: true, drillResults: [] });
  });
});

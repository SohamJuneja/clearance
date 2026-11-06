/**
 * F23's tile. Every number on it is read back and compared with the fake core's own data. The Desk has no login, so
 * what it holds is what a room may read: nothing about any one person reaches the page. Test data only.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { httpCore } from "../src/server/core-source";
import { fixtureCore } from "../src/server/fixture";
import { createDeskServer } from "../src/server/server";
import type { RoiView } from "../src/shared/api";
import { formatCount, formatMoney } from "../src/web/format";
import { RoiTile } from "../src/web/views";
import { FAKE_TOKEN, startFakeCore, type FakeCore } from "./fake-core";

const REPO = resolve(import.meta.dirname, "../../..");
const POLICY = resolve(REPO, "policy/clearance.policy.yaml");

let core: FakeCore;
let desk: Server;
let base: string;

const startDesk = async (source: Parameters<typeof createDeskServer>[0]["core"], synthetic = false) => {
  desk = createDeskServer({ core: source, synthetic, distDir: resolve(REPO, "packages/desk/dist"), policyPath: POLICY, teamPath: resolve(REPO, "policy/team.yaml") });
  await new Promise<void>((done) => desk.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(desk.address() as AddressInfo).port}`;
};

beforeEach(async () => {
  core = await startFakeCore();
  await startDesk(httpCore({ url: core.url, token: FAKE_TOKEN }));
});

afterEach(async () => {
  desk.closeAllConnections();
  await new Promise((done) => desk.close(done));
  await core.close();
});

const view = async () => {
  const res = await fetch(`${base}/api/roi`);
  expect(res.status).toBe(200);
  return (await res.json()) as RoiView;
};
const tile = async () => renderToStaticMarkup(<RoiTile data={await view()} />).replace(/&#x27;/g, "'");

function cell(html: string, testId: string): string {
  const start = html.indexOf(`data-testid="${testId}"`);
  if (start < 0) throw new Error(`no element ${testId} in the tile`);
  const open = html.indexOf(">", start) + 1;
  const close = html.indexOf("</", open);
  return html.slice(open, close).replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").trim();
}

describe("the numbers", () => {
  it("are core's, every one", async () => {
    const html = await tile();
    const { ran_alone, load, speed, drills, money, from, to } = core.data.roi;
    expect(html).toContain(`${from} to ${to}`);
    expect(cell(html, "roi-outside")).toBe(formatCount(ran_alone.risky_outside_autonomy as number));
    expect(cell(html, "roi-under")).toBe(formatCount(ran_alone.under_autonomy as number));
    expect(cell(html, "roi-per-100")).toBe(String(load.per_100));
    expect(cell(html, "roi-no-card")).toBe(`${load.no_card_share}%`);
    expect(cell(html, "roi-median")).toBe(`${speed.median_seconds} s`);
    expect(cell(html, "roi-escalated")).toBe(formatCount(speed.escalated as number));
    expect(cell(html, "roi-expired")).toBe(formatCount(speed.expired as number));
    expect(cell(html, "roi-catch-rate")).toBe(`${drills.catch_rate_percent}%`);
    expect(cell(html, "roi-drills")).toContain(`${drills.finished} finished`);
    for (const row of money.by_class) {
      expect(cell(html, `roi-${row.class}-held`)).toContain(`${row.held_requests}`);
      if (row.has_amount) {
        expect(cell(html, `roi-${row.class}-held`)).toContain(formatMoney(row.held_amount as number, core.data.roi.currency));
        expect(cell(html, `roi-${row.class}-denied`)).toContain(formatMoney(row.denied_amount as number, core.data.roi.currency));
      }
    }
  });

  it("says the same rule the room's report does: only what has closed", async () => {
    expect(await tile()).toContain("a card still open joins once it closes");
  });
});

describe("too little, or not computable", () => {
  it("shows a dash and says why, never a zero", async () => {
    core.data.roi.load = { ...core.data.roi.load, per_100: null, no_card_share: null };
    core.data.roi.speed = { closed: 0, median_seconds: null, escalated: null, expired: null };
    core.data.roi.ran_alone = { ...core.data.roi.ran_alone, risky_outside_autonomy: null, under_autonomy: null };
    const html = await tile();
    for (const id of ["roi-per-100", "roi-no-card", "roi-median", "roi-escalated", "roi-expired", "roi-outside", "roi-under"]) expect(cell(html, id), id).toBe("–");
    expect(html).toContain("Too little data");
  });

  it("says so when a section couldn't be computed", async () => {
    (core.data.roi as unknown as Record<string, unknown>).load = null;
    const html = await tile();
    expect(cell(html, "roi-per-100")).toBe("–");
    expect(html).toContain("Couldn't be computed just now");
  });

  it("shows no total for a class whose amounts can't be read", async () => {
    core.data.roi.money.by_class = [{ class: "refund", has_amount: true, held_requests: 2, held_amount: null, held_unreadable: 2, denied_requests: 0, denied_amount: null, denied_unreadable: 0, rule_denied: 0 }];
    const html = await tile();
    expect(cell(html, "roi-refund-held")).toContain("no readable amount");
    expect(html).not.toContain("₹0");
  });

  it("says plainly when nothing has closed", async () => {
    core.data.roi.money.by_class = [];
    expect(await tile()).toContain("No held request has closed in these days.");
  });

  it("shows no numbers at all when the chain doesn't verify", async () => {
    Object.assign(core.data.roi, { chain_ok: false, money: null, ran_alone: null, load: null, speed: null, drills: null });
    const html = await tile();
    expect(html).toContain("doesn't verify");
    expect(html).not.toContain('data-testid="roi-outside"');
    expect(html).not.toContain("₹");
  });

  it("shows core's refusal rather than old numbers when core can't answer", async () => {
    core.override.set("/v1/roi", { status: 500, body: "core broke" });
    expect((await fetch(`${base}/api/roi`)).status).toBe(502);
  });

  it("refuses an answer it can't read, rather than guess at it", async () => {
    (core.data.roi as unknown as Record<string, unknown>).speed = { closed: "many" };
    expect((await fetch(`${base}/api/roi`)).status).toBe(502);
  });
});

describe("privacy", () => {
  it("nothing core might add about a person reaches the page", async () => {
    const data = core.data.roi as unknown as Record<string, unknown>;
    data.by_person = { sam: { caught: 1, missed: 2 } };
    (data.speed as Record<string, unknown>).sam_median_seconds = 41;
    (data.drills as Record<string, unknown>).sam_caught = 1;
    const body = JSON.stringify(await view());
    expect(body).not.toContain("by_person");
    expect(body).not.toMatch(/\bsam/);
    expect(await tile()).not.toMatch(/\bsam/i);
  });

  it("names nobody", async () => {
    expect(await tile()).not.toMatch(/\b(priya|sam|neha|alex|dev)\b/i);
  });

  it("gets only this one route from core for it: no person's stats, no ledger", async () => {
    core.seen.length = 0;
    await view();
    expect(core.seen.map((call) => call.path)).toEqual(["/v1/roi"]);
  });
});

describe("synthetic", () => {
  it("labels seeded history", async () => {
    core.data.roi.synthetic = { history_rows: 12, runs_on_history: 3 };
    const html = await tile();
    expect(html).toContain("Synthetic");
    expect(cell(html, "roi-synthetic")).toContain("12");
    expect(cell(html, "roi-synthetic")).toContain("3");
  });

  it("says nothing about it when there is none", async () => {
    core.data.roi.synthetic = { history_rows: 0, runs_on_history: 0 };
    expect(await tile()).not.toMatch(/synthetic/i);
  });

  it("the screenshot fixture's numbers say what they are", async () => {
    desk.closeAllConnections();
    await new Promise((done) => desk.close(done));
    await startDesk(fixtureCore({ policyPath: POLICY }), true);
    const fixture = await view();
    expect(fixture.synthetic?.history_rows).toBeGreaterThan(0);
    expect(renderToStaticMarkup(<RoiTile data={fixture} />)).toMatch(/synthetic/i);
  });
});

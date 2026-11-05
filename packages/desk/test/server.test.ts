/** The Desk's server against a fake core over real HTTP: what it reads, what it refuses, how it fails. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AutonomyView, PeopleView, PolicyView, QueueView } from "../src/shared/api";
import { httpCore } from "../src/server/core-source";
import { fixtureCore } from "../src/server/fixture";
import { createDeskServer } from "../src/server/server";
import { FAKE_TOKEN, startFakeCore, type FakeCore } from "./fake-core";

const REPO = resolve(import.meta.dirname, "../../..");
const POLICY = resolve(REPO, "policy/clearance.policy.yaml");
const TEAM = resolve(REPO, "policy/team.yaml");

let core: FakeCore;
let desk: Server;
let base: string;
let dist: string;

async function startDesk(options: { synthetic?: boolean; allowedHosts?: string[]; token?: string } = {}) {
  const server = createDeskServer({
    core: options.synthetic ? fixtureCore({ policyPath: POLICY }) : httpCore({ url: core.url, token: options.token ?? FAKE_TOKEN }),
    synthetic: options.synthetic ?? false,
    distDir: dist,
    policyPath: POLICY,
    teamPath: TEAM,
    allowedHosts: options.allowedHosts ?? [],
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

beforeEach(async () => {
  core = await startFakeCore();
  dist = mkdtempSync(join(tmpdir(), "desk-dist-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>desk</title>");
  writeFileSync(join(dist, "assets/app-abc.js"), "console.log('desk')");
  const started = await startDesk();
  desk = started.server;
  base = started.url;
});

afterEach(async () => {
  desk.closeAllConnections();
  await new Promise((done) => desk.close(done));
  await core.close();
  rmSync(dist, { recursive: true, force: true });
});

const getJson = async <T,>(path: string) => (await (await fetch(`${base}${path}`)).json()) as T;

/** Sends a path and Host exactly as written. fetch would normalise both. */
function raw(path: string, host?: string): Promise<{ status: number; body: string }> {
  const url = new URL(base);
  return new Promise((done, fail) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path, method: "GET", headers: host ? { host } : {} }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => done({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

const READ_ROUTES = ["/api/health", "/api/queue", "/api/ledger", "/api/ledger/verify", "/api/coverage", "/api/autonomy", "/api/people", "/api/policy", "/api/export.csv"];

describe("the token stays on the server", () => {
  it("sends core's token on every call", async () => {
    for (const route of READ_ROUTES) await fetch(`${base}${route}`);
    expect(core.seen.length).toBeGreaterThan(READ_ROUTES.length);
    expect(core.seen.every((call) => call.authorization === `Bearer ${FAKE_TOKEN}`)).toBe(true);
  });

  it("never puts it in a response, even when core fails", async () => {
    const check = async () => {
      for (const route of [...READ_ROUTES, "/", "/api/meta", "/api/nope"]) {
        const res = await fetch(`${base}${route}`);
        const headers = JSON.stringify([...res.headers]);
        expect(await res.text(), route).not.toContain(FAKE_TOKEN);
        expect(headers, route).not.toContain(FAKE_TOKEN);
      }
    };
    await check();
    core.forceStatus = 500;
    await check();
    core.forceStatus = 401;
    await check();
  });

  it("does not hand the page anywhere to read it: no route echoes core's address with credentials", async () => {
    const meta = await (await fetch(`${base}/api/meta`)).text();
    expect(meta).toBe('{"synthetic":false}');
  });
});

describe("the Desk cannot act", () => {
  it.each([
    ["POST", "/api/check"],
    ["POST", "/api/v1/check"],
    ["POST", "/v1/check"],
    ["POST", "/api/requests/CLR-0011/cancel"],
    ["POST", "/v1/requests/CLR-0011/cancel"],
    ["POST", "/api/autonomy/simulate"],
    ["POST", "/api/ledger"],
    ["POST", "/api/queue"],
    ["PUT", "/api/policy"],
    ["DELETE", "/api/ledger"],
    ["PATCH", "/api/people"],
    ["POST", "/"],
  ])("%s %s is refused and core hears nothing", async (method, path) => {
    const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "DELETE" ? undefined : "{}" });
    expect([404, 405]).toContain(res.status);
    expect(core.seen).toEqual([]);
  });

  it("only ever calls core with GET, apart from the one simulation route", async () => {
    for (const route of READ_ROUTES) await fetch(`${base}${route}`);
    await fetch(`${base}/api/policy/simulate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: {} }) });
    const writes = core.seen.filter((call) => call.method !== "GET");
    expect(writes.map((call) => call.path)).toEqual(["/v1/policy/simulate"]);
  });

  it("has no generic passthrough: core's own paths are not routes here", async () => {
    for (const path of ["/v1/health", "/api/v1/health", "/api/v1/ledger", "/api/requests/CLR-0011", "/api/inbox?user=sam", "/api/hooks/claude"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(404);
    }
    expect(core.seen).toEqual([]);
  });
});

describe("who can reach it", () => {
  it("answers loopback hosts and refuses any other, so a page cannot rebind DNS to read through it", async () => {
    expect((await raw("/api/meta", "127.0.0.1:7900")).status).toBe(200);
    expect((await raw("/api/meta", "localhost:7900")).status).toBe(200);
    expect((await raw("/api/meta", "[::1]:7900")).status).toBe(200);
    expect((await raw("/api/queue", "evil.example")).status).toBe(403);
    expect((await raw("/", "abc.trycloudflare.com")).status).toBe(403);
    expect((await raw("/api/queue", "localhost.evil.example:7900")).status).toBe(403);
    expect(core.seen).toEqual([]);
  });

  it("lets someone name a host on purpose", async () => {
    const started = await startDesk({ allowedHosts: ["desk.example"] });
    const url = new URL(started.url);
    const status = await new Promise<number>((done) => {
      httpRequest({ host: url.hostname, port: url.port, path: "/api/meta", headers: { host: "desk.example" } }, (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      }).end();
    });
    started.server.closeAllConnections();
    await new Promise((done) => started.server.close(done));
    expect(status).toBe(200);
  });

  it("does not serve files outside its build", async () => {
    writeFileSync(join(dist, "..", "desk-secret-test.txt"), "secret");
    for (const path of ["/../desk-secret-test.txt", "/assets/../../desk-secret-test.txt", "/..%2fdesk-secret-test.txt", "/assets/nope.js"]) {
      const res = await raw(path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).not.toContain("secret");
    }
    rmSync(join(dist, "..", "desk-secret-test.txt"));
  });

  it("serves the page and its hashed assets, with a CSP that refuses inline scripts", async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const asset = await fetch(`${base}/assets/app-abc.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
  });
});

describe("failing honestly", () => {
  it("says core is unreachable, and gives no numbers", async () => {
    await core.close();
    for (const route of ["/api/health", "/api/queue", "/api/ledger", "/api/coverage", "/api/people", "/api/autonomy", "/api/policy"]) {
      const res = await fetch(`${base}${route}`);
      const body = (await res.json()) as { error: string; message: string };
      expect(res.status, route).toBe(502);
      expect(body.error, route).toBe("core_unreachable");
      expect(body.message, route).toContain("not answering");
    }
    core = await startFakeCore();
  });

  it("says core refused the token, when it does", async () => {
    const wrong = await startDesk({ token: "wrong-token" });
    const res = await fetch(`${wrong.url}/api/health`);
    const body = (await res.json()) as { error: string; message: string };
    wrong.server.closeAllConnections();
    await new Promise((done) => wrong.server.close(done));
    expect(res.status).toBe(502);
    expect(body.error).toBe("core_refused");
    expect(body.message).toContain("CLEARANCE_INTERNAL_TOKEN");
    expect(body.message).not.toContain("wrong-token");
  });

  it("refuses a shape it cannot read rather than guess a number", async () => {
    core.override.set("/v1/health", { status: 200, body: JSON.stringify({ ok: true, policy_hash: "x", policy_error: null, open_requests: "lots" }) });
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("core_shape");
    core.override.set("/v1/ledger", { status: 200, body: "not json" });
    expect((await fetch(`${base}/api/ledger`)).status).toBe(502);
  });

  it("reports a 5xx from core as core failing", async () => {
    core.forceStatus = 500;
    const res = await fetch(`${base}/api/queue`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("core_unreachable");
  });
});

describe("the Queue, built from core's real routes", () => {
  const queue = () => getJson<QueueView>("/api/queue");

  it("finds open requests in the ledger and takes the count from core's health", async () => {
    const view = await queue();
    expect(view.open_count).toBe(core.data.health.open_requests);
    expect(view.requests.map((item) => item.id)).toEqual(["CLR-0011", "CLR-0012"]);
    expect(view.disagreement).toBeNull();
  });

  it("does not ask about requests the ledger has closed", async () => {
    await queue();
    expect(core.seen.some((call) => call.path === "/v1/requests/CLR-0007")).toBe(false);
  });

  it("drops a request core says is closed, and reports when counts disagree", async () => {
    core.data.requests["CLR-0012"]!.state = "APPROVED";
    const view = await queue();
    expect(view.requests.map((item) => item.id)).toEqual(["CLR-0011"]);
    expect(view.disagreement).toContain("Core reports 2 open");
    expect(view.disagreement).toContain("found 1");
  });

  it("names who holds a card, with its handle, and the room by name", async () => {
    const [refund] = (await queue()).requests;
    expect(refund!.waiting_on).toEqual([
      { person: "Sam", handle: "A17" },
      { person: "Neha", handle: "A18" },
    ]);
    expect(refund!.room).toBe("#support");
    expect(refund!.asked_by).toEqual(["Priya"]);
  });

  it("uses team.yaml's vendor for the agent, because a gate call reports vendor gate", async () => {
    const [refund, merge] = (await queue()).requests;
    expect(refund!.vendor).toBe("Claude Code");
    expect(merge!.vendor).toBe("Claude Code");
  });

  it("gives the escalation step from the ledger, out of the policy's ladder", async () => {
    const [refund, merge] = (await queue()).requests;
    const ladder = (readFileSync(POLICY, "utf8").match(/after: \d+m/g) ?? []).length;
    expect(ladder).toBeGreaterThan(0);
    expect(refund!.escalation).toEqual({ fired: 1, of: 3, last: "Backup added: Neha" });
    expect(merge!.escalation).toEqual({ fired: 0, of: 0, last: null });
  });

  it("describes the other ladder steps in words", async () => {
    core.data.ledger.push({ seq: 13, at: new Date().toISOString(), type: "escalated", request_id: "CLR-0011", payload: { step: 1, kind: "post", room: "#approvals" }, prev_hash: "", entry_hash: "" });
    expect((await queue()).requests[0]!.escalation).toEqual({ fired: 2, of: 3, last: "Posted to #approvals" });
    core.data.ledger.push({ seq: 14, at: new Date().toISOString(), type: "escalated", request_id: "CLR-0011", payload: { step: 2, kind: "notify", notified: ["priya"] }, prev_hash: "", entry_hash: "" });
    expect((await queue()).requests[0]!.escalation).toEqual({ fired: 3, of: 3, last: "Requester told" });
  });

  it("shows the fallback group when nobody eligible could be chosen", async () => {
    const merge = (await queue()).requests[1]!;
    expect(merge.waiting_on).toEqual([]);
    expect(merge.fallback).toEqual({ group: "eng", room: "#eng", reason: "everyone in eng is excluded" });
  });

  it("counts approvals against the quorum", async () => {
    const merge = (await queue()).requests[1]!;
    expect(merge.quorum_required).toBe(2);
    expect(merge.approvals).toBe(1);
  });

  it("is empty, not broken, on a fresh ledger", async () => {
    core.data.ledger = [];
    core.data.health.open_requests = 0;
    expect(await queue()).toEqual({ open_count: 0, requests: [], disagreement: null });
  });

  it("does not show a drill as a drill, so an approver cannot spot one here", async () => {
    core.data.requests["CLR-0011"]!.is_drill = true;
    expect(JSON.stringify(await queue())).not.toMatch(/drill/i);
  });
});

describe("People", () => {
  it("lists everyone in team.yaml with core's stats and open cards", async () => {
    const { people } = await getJson<PeopleView>("/api/people");
    expect(people.map((person) => person.id)).toEqual(["priya", "sam", "neha", "alex", "dev"]);
    const sam = people.find((person) => person.id === "sam")!;
    expect(sam.stats).toEqual(core.data.stats.sam);
    expect(sam.inbox.map((item) => item.handle)).toEqual(["A17"]);
  });

  it("does not break when core doesn't know someone in the file", async () => {
    delete core.data.stats.dev;
    const dev = (await getJson<PeopleView>("/api/people")).people.find((person) => person.id === "dev")!;
    expect(dev.stats).toBeNull();
    expect(dev.inbox).toEqual([]);
  });

  it("carries only ids, names, groups and roles from team.yaml", async () => {
    const [first] = (await getJson<PeopleView>("/api/people")).people;
    expect(Object.keys(first!).sort()).toEqual(["groups", "id", "inbox", "name", "roles", "stats"]);
  });
});

describe("Autonomy", () => {
  it("gives core's levels, and history from the ledger's own entries", async () => {
    const view = await getJson<AutonomyView>("/api/autonomy");
    expect(view.levels).toEqual(core.data.levels);
    expect(view.history.map((entry) => entry.type)).toEqual(["promotion_proposed", "demoted"]);
  });
});

describe("Policy", () => {
  const hash = createHash("sha256").update(readFileSync(POLICY, "utf8")).digest("hex");

  it("says when the file on disk is what core is enforcing", async () => {
    core.data.health.policy_hash = hash;
    const view = await getJson<PolicyView>("/api/policy");
    expect(view.matches).toBe(true);
    expect(view.file_hash).toBe(hash);
    expect(view.text).toBe(readFileSync(POLICY, "utf8"));
  });

  it("says when it is not", async () => {
    const view = await getJson<PolicyView>("/api/policy");
    expect(view.matches).toBe(false);
    expect(view.core_hash).toBe("abc123def456");
  });

  it("passes on a refused reload", async () => {
    core.data.health.policy_error = "line 12: bad tier";
    expect((await getJson<PolicyView>("/api/policy")).policy_error).toBe("line 12: bad tier");
  });

  it("renders the real file's classes, tiers and quorums", async () => {
    const view = await getJson<PolicyView>("/api/policy");
    const refund = view.classes.find((row) => row.name === "refund")!;
    expect(refund).toMatchObject({ base: 20, approvers: "finance", reversible: false, escalation_steps: 3, max_level: "L3" });
    expect(refund.quorum).toContain("2 (critical)");
    expect(view.classes.find((row) => row.name === "protected_config")!.decision).toBe("deny");
    expect(view.tiers.map((tier) => tier.name)).toEqual(["low", "medium", "high", "critical"]);
    expect(view.tiers.find((tier) => tier.name === "critical")!.from).toBe(80);
  });
});

describe("the simulator route", () => {
  const post = (body: string, type = "application/json") => fetch(`${base}/api/policy/simulate`, { method: "POST", headers: { "content-type": type }, body });

  it("forwards the call to core and returns its answer", async () => {
    const res = await post(JSON.stringify({ action: { id: "x" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(core.data.simulation);
    expect(core.seen.at(-1)).toMatchObject({ method: "POST", path: "/v1/policy/simulate", body: '{"action":{"id":"x"}}' });
  });

  it("explains bad input in words", async () => {
    const notJson = await post("{nope");
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { error: string }).error).toContain("not valid JSON");
    const refused = await post("{}");
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe("expected {action}");
  });

  it("insists on JSON, which a cross-site form cannot send without a preflight", async () => {
    expect((await post("{}", "text/plain")).status).toBe(415);
    expect(core.seen).toEqual([]);
  });

  it("refuses an oversized body rather than buffering it", async () => {
    const res = await post(JSON.stringify({ action: "x".repeat(70_000) }));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toContain("too large");
    expect(core.seen).toEqual([]);
  });
});

describe("the export", () => {
  it("is the real CSV, as a download", async () => {
    const res = await fetch(`${base}/api/export.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("clearance-ledger.csv");
    expect(await res.text()).toBe("seq,at,type\n1,now,held\n");
  });
});

describe("fixture mode", () => {
  let fixture: Awaited<ReturnType<typeof startDesk>>;

  beforeEach(async () => {
    fixture = await startDesk({ synthetic: true });
  });

  afterEach(async () => {
    fixture.server.closeAllConnections();
    await new Promise((done) => fixture.server.close(done));
  });

  const read = async <T,>(path: string) => {
    const res = await fetch(`${fixture.url}${path}`);
    expect(res.status, path).toBe(200);
    return (await res.json()) as T;
  };

  it("tells the page it is synthetic. Real mode never does", async () => {
    expect(await read("/api/meta")).toEqual({ synthetic: true });
    expect(await getJson("/api/meta")).toEqual({ synthetic: false });
  });

  it("never touches a real core", async () => {
    for (const route of READ_ROUTES) await fetch(`${fixture.url}${route}`);
    expect(core.seen).toEqual([]);
  });

  it("goes through the same composition as real data, so every tab has something and counts agree", async () => {
    const queue = await read<QueueView>("/api/queue");
    expect(queue.requests.length).toBeGreaterThan(0);
    expect(queue.disagreement).toBeNull();
    expect((await read<PeopleView>("/api/people")).people.every((person) => person.stats !== null)).toBe(true);
    expect((await read<AutonomyView>("/api/autonomy")).history.length).toBeGreaterThan(0);
    expect((await read<PolicyView>("/api/policy")).matches).toBe(true);
    for (const route of READ_ROUTES) expect((await fetch(`${fixture.url}${route}`)).status, route).toBe(200);
  });

  it("labels its export as synthetic, in case it leaves the machine", async () => {
    expect(await (await fetch(`${fixture.url}/api/export.csv`)).text()).toContain("SYNTHETIC");
  });

  it("says its simulator answer is canned", async () => {
    const res = await fetch(`${fixture.url}/api/policy/simulate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: { business: { endpoint: "POST /acme/refunds" } } }) });
    expect(((await res.json()) as { reason: string }).reason).toMatch(/synthetic/i);
  });
});

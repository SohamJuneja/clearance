/** The Desk's server against a fake core over real HTTP: what it reads, what it refuses, how it fails. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AutonomyView, Health, PeopleView, PersonDetail, PolicyView, QueueView } from "../src/shared/api";
import { httpCore } from "../src/server/core-source";
import { fixtureCore } from "../src/server/fixture";
import { createDeskServer } from "../src/server/server";
import { FAKE_TOKEN, POLICY_FILE_HASH, startFakeCore, type FakeCore } from "./fake-core";

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

const READ_ROUTES = ["/api/health", "/api/queue", "/api/ledger", "/api/ledger/verify", "/api/coverage", "/api/autonomy", "/api/people", "/api/people/sam", "/api/policy", "/api/export.csv"];

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
    ["POST", "/api/ledger"],
    ["POST", "/api/people/sam"],
    ["PUT", "/api/autonomy/simulate"],
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

  it("only ever calls core with GET, apart from the two simulations, which write nothing", async () => {
    for (const route of READ_ROUTES) await fetch(`${base}${route}`);
    await fetch(`${base}/api/policy/simulate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: {} }) });
    await fetch(`${base}/api/autonomy/simulate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "refunds-agent" }) });
    const writes = core.seen.filter((call) => call.method !== "GET");
    expect(writes.map((call) => call.path)).toEqual(["/v1/policy/simulate", "/v1/autonomy/simulate"]);
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
    core.override.set("/v1/health", { status: 200, body: JSON.stringify({ ok: true, policy_hash: 7, policy_error: null }) });
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

  it("takes the open requests from core's own list, and counts what it lists", async () => {
    const view = await queue();
    expect(view.requests.map((item) => item.id)).toEqual(["CLR-0011", "CLR-0012"]);
    expect(view.open_count).toBe(2);
    expect(core.seen.some((call) => call.path === "/v1/requests?state=open")).toBe(true);
  });

  it("does not go asking about requests one at a time", async () => {
    await queue();
    expect(core.seen.some((call) => /^\/v1\/requests\/CLR-/.test(call.path))).toBe(false);
  });

  it("drops a request core has closed", async () => {
    core.data.requests["CLR-0012"]!.state = "APPROVED";
    const view = await queue();
    expect(view.requests.map((item) => item.id)).toEqual(["CLR-0011"]);
    expect(view.open_count).toBe(1);
  });

  it("takes the ladder from the policy core is enforcing, not the file on disk", async () => {
    core.data.policy.text = `mode: enforce\ntiers: { low: [0, 100] }\nclasses:\n  refund: { escalate: [{ after: 3m }] }\n  merge: {}\n`;
    const [refund] = (await queue()).requests;
    expect(refund!.escalation.of).toBe(1);
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
    core.data.requests = {};
    expect(await queue()).toEqual({ open_count: 0, requests: [] });
  });
});

describe("Health", () => {
  it("is core's, less the open count, which would show the Queue being held still", async () => {
    expect(await getJson<Health>("/api/health")).toEqual({ ok: true, policy_hash: "abc123def456", mode: "enforce", policy_error: null });
  });
});

describe("People", () => {
  const team = () => getJson<PeopleView>("/api/people");
  const totals = (key: "answers" | "approvals" | "denials" | "fast_approvals" | "flags_ignored" | "batch_approvals" | "streaks") => Object.values(core.data.stats).reduce((sum, row) => sum + row[key], 0);

  it("lists core's roster, with only who they are and whether they are away", async () => {
    const { people } = await team();
    expect(people).toEqual(core.data.people);
    expect(Object.keys(people[0]!).sort()).toEqual(["away", "groups", "id", "name", "roles"]);
  });

  it("sums the team's numbers from each person's stats", async () => {
    const view = (await team()).team;
    for (const key of ["answers", "approvals", "denials", "fast_approvals", "flags_ignored", "batch_approvals", "streaks"] as const) expect(view[key], key).toBe(totals(key));
    expect(view.answers).toBe(80);
  });

  it("never puts one person's numbers in the team view, whatever the page does with them", async () => {
    const body = JSON.stringify(await team());
    for (const secret of ["137000", "by_tier", "median_latency_ms", "friction", "signals", "catch_rate"]) expect(body, secret).not.toContain(secret);
  });

  it("asks for one person's record only on its own route", async () => {
    const sam = await getJson<PersonDetail>("/api/people/sam");
    const { open_cards: _open, drills, ...shown } = core.data.stats.sam!;
    const { sent: _sent, ...finished } = drills;
    expect(sam.stats).toEqual({ ...shown, drills: finished });
    expect(sam).toMatchObject({ id: "sam", name: "Sam", groups: ["finance"] });
  });

  it("refuses an id that isn't on core's roster, without asking core about it", async () => {
    for (const path of ["/api/people/nobody", "/api/people/sam%2Fstats", "/api/people/..%2Fledger", "/api/people/%E0%A4%A"]) {
      core.seen.length = 0;
      expect((await fetch(`${base}${path}`)).status, path).toBe(404);
      expect(core.seen.filter((call) => call.path.includes("/stats")), path).toEqual([]);
    }
  });

  it("does not break when core doesn't know someone it lists", async () => {
    delete core.data.stats.dev;
    expect((await team()).people.map((person) => person.id)).toContain("dev");
  });
});

describe("Autonomy", () => {
  const post = (body: string, type = "application/json") => fetch(`${base}/api/autonomy/simulate`, { method: "POST", headers: { "content-type": type }, body });

  it("gives core's levels, proposals and replay, and history from the ledger's own entries", async () => {
    const view = await getJson<AutonomyView>("/api/autonomy");
    expect(view.levels).toEqual(core.data.levels);
    expect(view.proposals.map((proposal) => proposal.id)).toEqual(["PRO-0003"]);
    expect(view.proposals[0]!.signed_by).toEqual(["Sam"]);
    expect(view.buckets.map((row) => row.counted)).toEqual(core.data.buckets.map((row) => row.counted));
    expect(view.buckets[0]!.approvers).toBe(3);
    expect(view.evidence).toEqual(core.data.evidence);
    expect(view.human_load).toEqual(core.data.humanLoad);
    expect(view.history.map((entry) => entry.type)).toEqual(["promotion_proposed", "demoted"]);
  });

  it("replays one scope on request, forwarding only the scope", async () => {
    const res = await post(JSON.stringify({ agent: "ops-agent", class: "deploy", bucket: "staging" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { replays: { bucket: string }[] }).replays.map((row) => row.bucket)).toEqual(["staging"]);
    expect(core.seen.at(-1)).toMatchObject({ method: "POST", path: "/v1/autonomy/simulate", body: '{"agent":"ops-agent","class":"deploy","bucket":"staging"}' });
  });

  it("refuses anything that isn't a scope, and core hears nothing", async () => {
    for (const body of [JSON.stringify({ agent: "x", policy: "y" }), JSON.stringify({ agent: 7 }), JSON.stringify(["agent"]), "{nope"]) expect((await post(body)).status, body).toBe(400);
    expect((await post("{}", "text/plain")).status).toBe(415);
    expect((await post(JSON.stringify({ agent: "x".repeat(70_000) }))).status).toBe(413);
    expect(core.seen).toEqual([]);
  });
});

describe("Policy", () => {
  const policy = () => getJson<PolicyView>("/api/policy");
  const signedByTwo = () => {
    core.data.policy.hash = "c0ffee123456";
    core.data.ledger.push({ seq: 13, at: new Date().toISOString(), type: "policy_loaded", request_id: null, payload: { hash: "c0ffee123456", source: "proposal", approved_by: ["sam", "alex"] }, prev_hash: "", entry_hash: "" });
  };

  it("says when the file on disk is what core is enforcing", async () => {
    core.data.policy.hash = POLICY_FILE_HASH;
    const view = await policy();
    expect(view.relation).toBe("same");
    expect(view.file_hash).toBe(POLICY_FILE_HASH);
    expect(view.text).toBe(readFileSync(POLICY, "utf8"));
  });

  it("explains a difference that comes from signing through the API, naming who signed", async () => {
    signedByTwo();
    const view = await policy();
    expect(view.relation).toBe("signed");
    expect(view.core_hash).toBe("c0ffee123456");
    expect(view.signed_by).toEqual(["Sam", "Alex"]);
  });

  it("says when the file holds an edit waiting for signatures", async () => {
    core.data.policy.pending = { proposal: "PRO-0002", hash: POLICY_FILE_HASH, signed_by: ["neha"], quorum: 2, detail: "Raises the refund limit" };
    const view = await policy();
    expect(view.relation).toBe("file_pending");
    expect(view.pending).toEqual({ proposal: "PRO-0002", hash: POLICY_FILE_HASH, signed_by: ["Neha"], quorum: 2, detail: "Raises the refund limit" });
  });

  it("prefers the file's pending edit to an older signature, since that is the newer news", async () => {
    signedByTwo();
    core.data.policy.pending = { proposal: "PRO-0002", hash: POLICY_FILE_HASH, signed_by: [], quorum: 2, detail: "" };
    expect((await policy()).relation).toBe("file_pending");
  });

  it("says so, without a reason it doesn't have, when they differ and core gives none", async () => {
    const view = await policy();
    expect(view.relation).toBe("differs");
    expect(view.signed_by).toEqual([]);
  });

  it("passes on a refused reload and shadow counts", async () => {
    core.data.policy.error = "line 12: bad tier";
    core.data.policy.mode = "shadow";
    core.data.policy.shadow_would_hold = 23;
    expect(await policy()).toMatchObject({ policy_error: "line 12: bad tier", mode: "shadow", shadow_would_hold: 23 });
  });

  it("renders the classes, tiers and quorums of the policy core is enforcing", async () => {
    const view = await policy();
    const refund = view.classes.find((row) => row.name === "refund")!;
    expect(refund).toMatchObject({ base: 20, approvers: "finance", reversible: false, escalation_steps: 3, max_level: "L3" });
    expect(refund.quorum).toContain("2 (critical)");
    expect(view.classes.find((row) => row.name === "protected_config")!.decision).toBe("deny");
    expect(view.tiers.map((tier) => tier.name)).toEqual(["low", "medium", "high", "critical"]);
    expect(view.tiers.find((tier) => tier.name === "critical")!.from).toBe(80);
  });

  it("shows core's copy, not the file, when they differ", async () => {
    core.data.policy.text = `mode: enforce\ntiers: { low: [0, 100] }\nclasses:\n  only_this: { decision: deny }\n`;
    const view = await policy();
    expect(view.classes.map((row) => row.name)).toEqual(["only_this"]);
    expect(view.text).toContain("only_this");
  });

  it("calls an unreadable policy from core a shape problem, not a crash", async () => {
    core.data.policy.text = "tiers: nonsense";
    const res = await fetch(`${base}/api/policy`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("core_shape");
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
  it("is a CSV of the ledger, as a download, in core's columns", async () => {
    const res = await fetch(`${base}/api/export.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("clearance-ledger.csv");
    const lines = (await res.text()).trim().split("\n");
    expect(lines[0]).toBe("seq,at,type,request_id,payload,prev_hash,entry_hash");
    expect(lines).toHaveLength(core.data.ledger.length + 1);
    expect(lines[6]).toContain('"CLR-0011"');
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
    const people = await read<PeopleView>("/api/people");
    expect(people.team.answers).toBeGreaterThan(0);
    expect(people.team.drills.finished).toBe(3);
    expect((await read<AutonomyView>("/api/autonomy")).history.length).toBeGreaterThan(0);
    expect((await read<AutonomyView>("/api/autonomy")).buckets.length).toBeGreaterThan(0);
    expect((await read<PolicyView>("/api/policy")).relation).toBe("same");
    expect((await read<PolicyView>("/api/policy")).pending).not.toBeNull();
    for (const route of READ_ROUTES) expect((await fetch(`${fixture.url}${route}`)).status, route).toBe(200);
  });

  it("labels its export as synthetic, in case it leaves the machine", async () => {
    expect(await (await fetch(`${fixture.url}/api/export.csv`)).text()).toContain("SYNTHETIC");
  });

  it("keeps to the same drill rule as real data: its closed drills are in no list", async () => {
    expect(await (await fetch(`${fixture.url}/api/ledger`)).text()).not.toMatch(/drill_|CLR-0033/);
    expect(await (await fetch(`${fixture.url}/api/export.csv`)).text()).not.toMatch(/drill_|CLR-0033/);
  });

  it("replays a scope", async () => {
    const res = await fetch(`${fixture.url}/api/autonomy/simulate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "ops-agent", class: "deploy", bucket: "staging" }) });
    expect(((await res.json()) as { replays: unknown[] }).replays).toHaveLength(1);
  });

  it("says its simulator answer is canned", async () => {
    const res = await fetch(`${fixture.url}/api/policy/simulate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: { business: { endpoint: "POST /acme/refunds" } } }) });
    expect(((await res.json()) as { reason: string }).reason).toMatch(/synthetic/i);
  });
});

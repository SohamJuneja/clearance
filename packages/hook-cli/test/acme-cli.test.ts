import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACME_BIN, deadUrl, run, startServer, type FakeServer } from "./helpers.js";

const TOKEN = "gate-token-for-this-agent";
const HELD_BODY = JSON.stringify({
  status: "pending",
  request_id: "CLR-0042",
  poll_after_s: 15,
  message: "HELD CLR-0042: refunds over ₹10,000 need finance approval.",
});

let gate: FakeServer;
let emptyDir: string;

beforeAll(() => {
  emptyDir = mkdtempSync(join(tmpdir(), "acme-cli-"));
});
afterAll(() => rmSync(emptyDir, { recursive: true, force: true }));
beforeEach(async () => {
  gate = await startServer();
});
afterEach(() => gate.close());

const acme = (args: string[], env: Record<string, string> = {}, cwd = emptyDir) =>
  run("node", [ACME_BIN, ...args], {
    cwd,
    env: { CLEARANCE_GATE_URL: gate.url, ACME_GATE_TOKEN: TOKEN, ...env },
  });

describe("writes map to the contract", () => {
  it.each([
    [
      "refund, the short form",
      ["refund", "--order", "A-1931", "--amount", "4000"],
      "POST",
      "/acme/refunds",
      { order_id: "A-1931", amount: 4000 },
    ],
    [
      "refund, every flag",
      [
        "refund",
        "--order",
        "A-1931",
        "--amount",
        "40000",
        "--customer",
        "cus_8812",
        "--destination",
        "meera.k@okaxis",
      ],
      "POST",
      "/acme/refunds",
      {
        order_id: "A-1931",
        amount: 40000,
        customer_id: "cus_8812",
        destination: "meera.k@okaxis",
      },
    ],
    [
      "refund, with --dest as another name for --destination",
      ["refund", "--order", "A-1931", "--amount", "5", "--dest", "meera.k@okaxis"],
      "POST",
      "/acme/refunds",
      { order_id: "A-1931", amount: 5, destination: "meera.k@okaxis" },
    ],
    [
      "deploy",
      ["deploy", "checkout", "v2.14.0", "--env", "prod"],
      "POST",
      "/acme/deploys",
      { service: "checkout", env: "prod", version: "v2.14.0" },
    ],
    [
      "rollback",
      ["rollback", "checkout", "--env", "prod"],
      "POST",
      "/acme/rollbacks",
      { service: "checkout", env: "prod" },
    ],
    [
      "email with attachments",
      [
        "email",
        "--to",
        "meera@example.com",
        "--subject",
        "Hi",
        "--body",
        "Text",
        "--attach",
        "customers.csv",
        "--attach",
        "b.pdf",
      ],
      "POST",
      "/acme/emails",
      {
        to: "meera@example.com",
        subject: "Hi",
        body: "Text",
        attachments: ["customers.csv", "b.pdf"],
      },
    ],
    [
      "email, the short form",
      ["email", "--to", "meera@example.com", "--attach", "customers.csv"],
      "POST",
      "/acme/emails",
      { to: "meera@example.com", subject: "", body: "", attachments: ["customers.csv"] },
    ],
    [
      "payout destination",
      ["add-destination", "--customer", "cus_8812", "--upi", "meera.k@okaxis"],
      "POST",
      "/acme/payouts/destinations",
      { customer_id: "cus_8812", upi: "meera.k@okaxis" },
    ],
    [
      "merge",
      ["merge", "--repo", "acme/acme-mini-app", "--pr", "42"],
      "POST",
      "/github/merge",
      { repo: "acme/acme-mini-app", pr: 42 },
    ],
    [
      "delete",
      ["delete", "customers", "cus_8812"],
      "DELETE",
      "/acme/records/customers/cus_8812",
      null,
    ],
  ])("%s", async (_name, args, method, url, body) => {
    const out = await acme(args);
    expect(out.code).toBe(0);
    expect(gate.hits).toHaveLength(1);
    expect(gate.hits[0]).toMatchObject({ method, url });
    expect(gate.hits[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    if (body) expect(JSON.parse(gate.hits[0]!.body)).toEqual(body);
    else expect(gate.hits[0]!.body).toBe("");
  });
});

describe("reads map to the contract", () => {
  it.each([
    ["order", ["order", "A-1931"], "/acme/orders/A-1931"],
    ["ticket", ["ticket", "T-77"], "/acme/tickets/T-77"],
    ["customer", ["customer", "cus_8812"], "/acme/customers/cus_8812"],
    ["customers", ["customers", "--query", "meera k"], "/acme/customers?query=meera%20k"],
    ["destination", ["destination", "meera.k@okaxis"], "/acme/destinations/meera.k%40okaxis"],
    ["services", ["services"], "/acme/services"],
    ["service", ["service", "checkout"], "/acme/services/checkout"],
    ["ci", ["ci", "v2.14.0"], "/acme/ci/v2.14.0"],
    ["pull", ["pull", "42"], "/acme/pulls/42"],
    ["pending", ["pending", "CLR-0042"], "/pending/CLR-0042"],
    ["status, another name for pending", ["status", "CLR-0042"], "/pending/CLR-0042"],
    ["file", ["file", "customers.csv"], "/acme/files/customers.csv"],
    ["templates", ["templates"], "/acme/emails/templates"],
  ])("%s", async (_name, args, url) => {
    const out = await acme(args);
    expect(out.code).toBe(0);
    expect(gate.hits[0]).toMatchObject({ method: "GET", url });
  });
});

describe("prints gate responses verbatim", () => {
  it("success: the body as it came", async () => {
    const body = '{"id":"re_7731",   "amount":4000}';
    gate.respond(() => ({ status: 201, body }));
    const out = await acme(["refund", "--order", "A-1931", "--amount", "4000"]);
    expect(out.code).toBe(0);
    expect(out.stdout.trimEnd()).toBe(body);
  });

  it("held: HELD first, so the agent cannot miss it, then the body, exit 2", async () => {
    gate.respond(() => ({ status: 202, body: HELD_BODY }));
    const out = await acme(["refund", "--order", "A-1931", "--amount", "40000"]);
    expect(out.code).toBe(2);
    const lines = out.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("HELD CLR-0042: refunds over ₹10,000 need finance approval.");
    expect(lines[1]).toBe(HELD_BODY);
  });

  it("denied: the message then the body, exit 1", async () => {
    const body = JSON.stringify({ status: "denied", message: "not your class" });
    gate.respond(() => ({ status: 403, body }));
    const out = await acme(["deploy", "checkout", "v1", "--env", "prod"]);
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("not your class");
    expect(out.stdout).toContain(body);
  });

  it("gate failing closed: the message then the body, exit 1", async () => {
    const body = JSON.stringify({ status: "unavailable", message: "nothing was executed" });
    gate.respond(() => ({ status: 503, body }));
    const out = await acme(["deploy", "checkout", "v1", "--env", "prod"]);
    expect(out.code).toBe(1);
    expect(out.stdout.split("\n")[0]).toBe("nothing was executed");
    expect(out.stdout).toContain(body);
  });

  it("other errors: the body, exit 1", async () => {
    const body = JSON.stringify({ status: "invalid", message: "amount: bad" });
    gate.respond(() => ({ status: 400, body }));
    const out = await acme(["refund", "--order", "A-1", "--amount", "4"]);
    expect(out.code).toBe(1);
    expect(out.stdout).toContain(body);
  });

  it("a read's 404 is not success", async () => {
    gate.respond(() => ({ status: 404, body: '{"error":"not found"}' }));
    const out = await acme(["order", "nope"]);
    expect(out.code).toBe(1);
  });

  it("an unreachable gate says so and exits 1", async () => {
    const out = await acme(["order", "A-1931"], { CLEARANCE_GATE_URL: await deadUrl() });
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/gate/i);
  });
});

describe("gate URL", () => {
  it("also reads ACME_GATE_URL, the name packages/acme uses", async () => {
    const out = await acme(["order", "A-1931"], {
      CLEARANCE_GATE_URL: "",
      ACME_GATE_URL: gate.url,
    });
    expect(out.code).toBe(0);
    expect(gate.hits).toHaveLength(1);
  });
});

describe("token", () => {
  const noEnvToken = { ACME_GATE_TOKEN: "" };

  it("reads .clearance/gate-token when the env has none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acme-token-"));
    mkdirSync(join(dir, ".clearance"));
    writeFileSync(join(dir, ".clearance", "gate-token"), "token-from-file\n");
    const out = await acme(["order", "A-1931"], noEnvToken, dir);
    expect(out.code).toBe(0);
    expect(gate.hits[0]!.headers.authorization).toBe("Bearer token-from-file");
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds the file from a subdirectory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acme-token-"));
    mkdirSync(join(dir, ".clearance"));
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    writeFileSync(join(dir, ".clearance", "gate-token"), "token-from-file\n");
    const out = await acme(["order", "A-1931"], noEnvToken, join(dir, "src", "deep"));
    expect(out.code).toBe(0);
    expect(gate.hits[0]!.headers.authorization).toBe("Bearer token-from-file");
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers the env over the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acme-token-"));
    mkdirSync(join(dir, ".clearance"));
    writeFileSync(join(dir, ".clearance", "gate-token"), "token-from-file\n");
    await acme(["order", "A-1931"], { ACME_GATE_TOKEN: "token-from-env" }, dir);
    expect(gate.hits[0]!.headers.authorization).toBe("Bearer token-from-env");
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to call the gate with no token", async () => {
    const out = await acme(["order", "A-1931"], noEnvToken);
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/ACME_GATE_TOKEN/);
    expect(gate.hits).toHaveLength(0);
  });

  it("never prints the token", async () => {
    gate.respond(() => ({ status: 500, body: "{}" }));
    const out = await acme(["order", "A-1931"]);
    expect(out.stdout + out.stderr).not.toContain(TOKEN);
  });
});

describe("usage", () => {
  it.each([
    ["no command", []],
    ["an unknown command", ["frobnicate"]],
    ["refund with no amount", ["refund", "--order", "A-1"]],
    ["refund with no order", ["refund", "--customer", "cus_8812", "--amount", "5"]],
    ["a non-numeric amount", ["refund", "--order", "A-1", "--amount", "lots"]],
    ["a fractional amount", ["refund", "--order", "A-1", "--amount", "40.5"]],
    ["a partly numeric amount", ["refund", "--order", "A-1", "--amount", "40000abc"]],
    ["deploy with no env", ["deploy", "checkout", "v2"]],
    ["deploy with no version", ["deploy", "checkout", "--env", "prod"]],
    ["email with no recipient", ["email", "--attach", "a.csv"]],
    ["an unknown flag", ["refund", "--order", "A-1", "--amount", "5", "--force"]],
    ["merge with a non-numeric pr", ["merge", "--repo", "r", "--pr", "abc"]],
    ["delete with one argument", ["delete", "customers"]],
    ["order with no id", ["order"]],
  ])("%s exits 1, never the held code, without calling the gate", async (_name, args) => {
    const out = await acme(args);
    expect(out.code).toBe(1);
    expect(out.stderr.length).toBeGreaterThan(0);
    expect(gate.hits).toHaveLength(0);
  });

  it("help prints usage and exits 0", async () => {
    const out = await acme(["--help"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("acme refund");
    expect(gate.hits).toHaveLength(0);
  });
});

describe("hints", () => {
  it("passes the room and thread from the env as hints", async () => {
    await acme(["order", "A-1931"], { CLEARANCE_ROOM: "!room", CLEARANCE_THREAD: "t-1" });
    expect(gate.hits[0]!.headers["x-clearance-room"]).toBe("!room");
    expect(gate.hits[0]!.headers["x-clearance-thread"]).toBe("t-1");
  });

  it("sends no agent identity of its own", async () => {
    await acme(["refund", "--order", "A-1", "--amount", "5"]);
    expect(gate.hits[0]!.body).not.toContain("agent");
    expect(Object.keys(gate.hits[0]!.headers).join(",")).not.toContain("agent-name");
  });
});

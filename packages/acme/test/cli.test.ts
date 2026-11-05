import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli";

type Seen = { method: string; url: string; auth: string | undefined; room: string | undefined; body: unknown };

let server: Server;
let baseUrl: string;
let seen: Seen[];
let respond: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;

beforeEach(async () => {
  seen = [];
  respond = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  };
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const entry: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        room: req.headers["x-clearance-room"] as string | undefined,
        body: raw ? JSON.parse(raw) : undefined,
      };
      seen.push(entry);
      respond(req, res, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function run(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    env: { ACME_GATE_URL: baseUrl, ACME_GATE_TOKEN: "agent-token", ...env },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("acme CLI", () => {
  it("prints a held response from the gate verbatim and exits non-zero", async () => {
    const held = '{"status":"pending","request_id":"CLR-0042","poll_after_s":15,"message":"HELD CLR-0042: refunds over ₹10,000 need finance approval."}';
    respond = (_req, res) => {
      res.writeHead(202, { "content-type": "application/json" });
      res.end(held);
    };
    const res = await run(["refund", "--order", "A-1931", "--customer", "cus_8812", "--dest", "meera.k@okaxis", "--amount", "40000"]);
    expect(res.out.trimEnd()).toBe(held);
    expect(res.code).toBe(2);
  });

  it("refund posts the gate's contract body with the agent token", async () => {
    await run(["refund", "--order", "A-1931", "--customer", "cus_8812", "--dest", "meera.k@okaxis", "--amount", "4000"]);
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "/acme/refunds",
      auth: "Bearer agent-token",
      body: { order_id: "A-1931", customer_id: "cus_8812", amount: 4000, destination: "meera.k@okaxis" },
    });
  });

  it("the PLAN's short form `acme refund --order --amount` fills customer and destination from the gate", async () => {
    respond = (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/acme/orders/A-1931") res.end('{"id":"A-1931","customer_id":"cus_8812","total":4000}');
      else if (req.url === "/acme/customers/cus_8812") res.end('{"id":"cus_8812","default_destination":"meera.k@oksbi"}');
      else res.end('{"id":"re_7731"}');
    };
    const res = await run(["refund", "--order", "A-1931", "--amount", "4000"]);
    expect(res.code).toBe(0);
    expect(res.out.trimEnd()).toBe('{"id":"re_7731"}');
    expect(seen.at(-1)).toMatchObject({
      url: "/acme/refunds",
      body: { order_id: "A-1931", customer_id: "cus_8812", amount: 4000, destination: "meera.k@oksbi" },
    });
  });

  it("deploy, rollback, email, delete and merge hit the gate's paths", async () => {
    await run(["deploy", "checkout", "v2.14.0", "--env", "prod"]);
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/acme/deploys", body: { service: "checkout", env: "prod", version: "v2.14.0" } });

    await run(["rollback", "checkout", "--env", "prod"]);
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/acme/rollbacks", body: { service: "checkout", env: "prod" } });

    await run(["email", "--to", "a@b.example", "--subject", "Hi", "--body", "Hello", "--attach", "customers.csv"]);
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/acme/emails", body: { to: "a@b.example", subject: "Hi", body: "Hello", attachments: ["customers.csv"] } });

    await run(["delete", "customers", "cus_8812"]);
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", url: "/acme/records/customers/cus_8812" });

    await run(["merge", "--repo", "acme/acme-mini-app", "--pr", "412"]);
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/github/merge", body: { repo: "acme/acme-mini-app", pr: 412 } });
  });

  it("reads go through the gate's GET passthrough, URL-encoded", async () => {
    const reads: [string[], string][] = [
      [["order", "A-1931"], "/acme/orders/A-1931"],
      [["customer", "cus_8812"], "/acme/customers/cus_8812"],
      [["customers", "--query", "meera k"], "/acme/customers?query=meera%20k"],
      [["destination", "meera.k@okaxis"], "/acme/destinations/meera.k%40okaxis"],
      [["ticket", "T-77"], "/acme/tickets/T-77"],
      [["services"], "/acme/services"],
      [["service", "checkout"], "/acme/services/checkout"],
      [["ci", "v2.14.0"], "/acme/ci/v2.14.0"],
      [["pull", "412"], "/acme/pulls/412"],
      [["status", "CLR-0042"], "/pending/CLR-0042"],
    ];
    for (const [argv, url] of reads) {
      await run(argv);
      expect(seen.at(-1)).toMatchObject({ method: "GET", url });
    }
  });

  it("prints 403 and 503 bodies verbatim and exits 1", async () => {
    respond = (_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end('{"status":"denied","message":"nope"}');
    };
    const denied = await run(["deploy", "checkout", "v2.14.0", "--env", "prod"]);
    expect(denied.out.trimEnd()).toBe('{"status":"denied","message":"nope"}');
    expect(denied.code).toBe(1);
  });

  it("forwards X-Clearance-Room when it is set in the environment", async () => {
    await run(["services"], { CLEARANCE_ROOM: "!room" });
    expect(seen.at(-1)!.room).toBe("!room");
  });

  it("fails without a gate token, before calling anything", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(["services"], { env: { ACME_GATE_URL: baseUrl }, stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
    expect(code).toBe(1);
    expect(err.join("")).toContain("ACME_GATE_TOKEN");
    expect(seen).toHaveLength(0);
  });

  it("reports an unreachable gate and exits 1 rather than pretending", async () => {
    const res = await run(["services"], { ACME_GATE_URL: "http://127.0.0.1:1" });
    expect(res.code).toBe(1);
    expect(res.err).toMatch(/cannot reach the gate/i);
  });

  it("rejects a non-integer amount and an unknown command without calling the gate", async () => {
    expect((await run(["refund", "--order", "A-1", "--customer", "c", "--dest", "d", "--amount", "12.5"])).code).toBe(1);
    expect((await run(["frobnicate"])).code).toBe(1);
    expect(seen).toHaveLength(0);
  });
});

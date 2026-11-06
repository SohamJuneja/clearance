/** The real `bin/acme` against the real gate, with fake core and Acme behind it. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  ADMIN_KEY,
  HELD_TEXT,
  INTERNAL_TOKEN,
  TOK_REFUNDS,
  bearer,
  buildGateServer,
  gateConfig,
  holdFor,
  startFakeAcme,
  startFakeCore,
  tempDb,
  type FakeAcme,
  type FakeCore,
  type TempDb,
} from "./helpers.js";

// These spawn the real CLI through a Node shim, so a busy host can take longer than the default 5 s.
vi.setConfig({ testTimeout: 30_000 });

const ACME_BIN = join(import.meta.dirname, "..", "..", "..", "acme-mini-app", "bin", "acme");

let core: FakeCore;
let acme: FakeAcme;
let db: TempDb;
let gate: FastifyInstance;
let gateUrl: string;
let cwd: string;

beforeEach(async () => {
  core = await startFakeCore();
  acme = await startFakeAcme();
  db = tempDb();
  gate = buildGateServer(gateConfig(core, acme, db));
  gateUrl = await gate.listen({ port: 0, host: "127.0.0.1" });
  const dir = mkdtempSync(join(tmpdir(), "acme-e2e-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  cwd = dir;
});

afterEach(async () => {
  await gate.close();
  await core.close();
  await acme.close();
  db.cleanup();
});

/**
 * `node` on the demo host is a Volta shim, so killing the child alone can leave the real process
 * running. The child leads its own process group, and the group is killed when it finishes or
 * overruns.
 */
function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [ACME_BIN, ...args], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        CLEARANCE_GATE_URL: gateUrl,
        ACME_GATE_TOKEN: TOK_REFUNDS,
      },
    });
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone, which is the normal case.
      }
    };
    const limit = setTimeout(killGroup, 30_000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(limit);
      killGroup();
      resolve({ code, stdout, stderr });
    });
  });
}

describe("acme CLI through the gate", () => {
  it("held refund: the agent reads HELD, approval executes once, polling shows the result", async () => {
    core.decide(holdFor("CLR-0042"));
    const refund = await cli(["refund", "--order", "A-1931", "--amount", "40000"]);
    expect(refund.code).toBe(2);
    expect(refund.stdout.split("\n")[0]).toBe(HELD_TEXT);
    expect(refund.stdout + refund.stderr).not.toContain(ADMIN_KEY);
    expect(core.checks[0]!.action.agent.name).toBe("refunds-agent");
    const heldArgs = {
      order_id: "A-1931",
      amount: 40000,
      customer_id: "cus_8812",
      destination: "meera.old@okhdfcbank",
    };
    expect(core.checks[0]!.action.business).toEqual({
      endpoint: "POST /acme/refunds",
      args: heldArgs,
    });
    expect(acme.mutations()).toHaveLength(0);

    const execute = () =>
      gate.inject({
        method: "POST",
        url: "/internal/execute/CLR-0042",
        payload: { call_hash: "hash-CLR-0042" },
        headers: bearer(INTERNAL_TOKEN),
      });
    expect((await execute()).json()).toMatchObject({ ok: true, alreadyExecuted: false });
    expect((await execute()).json()).toMatchObject({ ok: true, alreadyExecuted: true });
    expect(acme.mutations()).toHaveLength(1);
    expect(acme.mutations()[0]!.body).toEqual(heldArgs);

    core.requests.set("CLR-0042", { status: 200, body: JSON.stringify({ state: "EXECUTED" }) });
    const poll = await cli(["pending", "CLR-0042"]);
    expect(poll.code).toBe(0);
    expect(JSON.parse(poll.stdout)).toMatchObject({
      status: "executed",
      result: { id: "re_7731" },
    });
  });

  it("allowed read and allowed refund print Acme's answer and exit 0", async () => {
    const order = await cli(["order", "A-1931"]);
    expect(order.code).toBe(0);
    expect(JSON.parse(order.stdout)).toMatchObject({ id: "A-1931", total: 4000 });
    const refund = await cli(["refund", "--order", "A-1931", "--amount", "100"]);
    expect(refund.code).toBe(0);
    expect(JSON.parse(refund.stdout)).toMatchObject({ id: "re_7731" });
  });

  it("an action outside the token's classes is denied, and the agent reads why", async () => {
    const deploy = await cli(["deploy", "checkout", "v2.14.0", "--env", "prod"]);
    expect(deploy.code).toBe(1);
    expect(deploy.stdout).toContain("refunds-agent is not allowed");
    expect(core.checks).toHaveLength(0);
  });

  it("core down: exit 1 and nothing ran", async () => {
    await core.close();
    const refund = await cli(["refund", "--order", "A-1931", "--amount", "100"]);
    expect(refund.code).toBe(1);
    expect(refund.stdout).toContain("nothing was executed");
    expect(acme.mutations()).toHaveLength(0);
    core = await startFakeCore();
  });
});

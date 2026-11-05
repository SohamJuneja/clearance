/**
 * `pnpm policy:test`: every example call in policy/tests/*.yaml maps to the expected class, tier and
 * decision. Action objects are built directly here; adapters are tested in their own package.
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Action, Vendor } from "@clearance/contracts";
import { openDatabase, type Db } from "../src/db/index.js";
import { evaluateAction } from "../src/policy/engine.js";
import { AggregateStore } from "../src/risk/aggregates.js";
import { AutonomyStore } from "../src/autonomy/store.js";
import { parsePolicy, type CompiledPolicy } from "../src/policy/load.js";
import { FakeClock, FakeLookup, type World } from "./fakes.js";

const POLICY_DIR = new URL("../../../policy/", import.meta.url);
const TESTS_DIR = new URL("tests/", POLICY_DIR);
const policy: CompiledPolicy = parsePolicy(
  readFileSync(new URL("clearance.policy.yaml", POLICY_DIR), "utf8"),
  "clearance.policy.yaml",
);
const world = parse(readFileSync(new URL("world.yaml", TESTS_DIR), "utf8")) as World;

/** A Wednesday, 14:00 IST: inside business hours, not a Friday evening. */
const DEFAULT_NOW = "2026-11-04T14:00:00+05:30";

type Case = {
  name: string;
  vendor?: Vendor;
  agent?: string;
  at?: string;
  shell?: string;
  file_write?: string;
  file_read?: string;
  http?: { method: string; url: string; body?: unknown };
  mcp?: { server: string; tool: string; args?: unknown };
  gate?: { endpoint: string; args?: Record<string, unknown> };
  malformed?: "shell" | "file_write" | "file_read" | "http" | "mcp" | "business";
  prior?: { cls: string; by: string; key: string; value: number; hours_ago: number }[];
  autonomy?: { cls: string; bucket: string; level: "L0" | "L1" | "L2" | "L3" };
  lookups_down?: boolean;
  expect: {
    decision: "allow" | "hold" | "deny";
    class?: string | null;
    tier?: string | null;
    score?: number;
    step?: string;
    flags?: string[];
  };
};

function buildAction(testCase: Case, atIso: string): Action {
  const vendor: Vendor = testCase.vendor ?? (testCase.gate ? "gate" : "claude");
  const base = {
    id: `action-${testCase.name}`,
    at: atIso,
    source: testCase.gate ? ("gate" as const) : ("hook" as const),
    vendor,
    agent: { name: testCase.agent ?? "refunds-agent", cwd: "/agents/refunds-agent" },
    raw: testCase,
  };
  if (testCase.malformed) return { ...base, kind: testCase.malformed };
  if (testCase.shell !== undefined) return { ...base, kind: "shell", shell: { command: testCase.shell } };
  if (testCase.file_write !== undefined) return { ...base, kind: "file_write", file: { path: testCase.file_write } };
  if (testCase.file_read !== undefined) return { ...base, kind: "file_read", file: { path: testCase.file_read } };
  if (testCase.http) return { ...base, kind: "http", http: testCase.http };
  if (testCase.mcp) {
    return {
      ...base,
      kind: "mcp",
      mcp: { server: testCase.mcp.server, tool: testCase.mcp.tool, args: testCase.mcp.args ?? {} },
    };
  }
  if (testCase.gate) {
    return { ...base, kind: "business", business: { endpoint: testCase.gate.endpoint, args: testCase.gate.args ?? {} } };
  }
  throw new Error(`case ${testCase.name} has no call`);
}

const files = readdirSync(TESTS_DIR)
  .filter((name) => name.endsWith(".yaml") && name !== "world.yaml")
  .sort();
const groups = files.map((file) => ({
  file,
  cases: (parse(readFileSync(new URL(file, TESTS_DIR), "utf8")) as { cases: Case[] }).cases,
}));

const dir = mkdtempSync(join(tmpdir(), "clearance-policy-table-"));
const openDbs: Db[] = [];
afterAll(() => openDbs.forEach((db) => db.close()));

describe("policy table", () => {
  it("has at least 60 cases across claude, codex, opencode, cursor and the gate", () => {
    const all = groups.flatMap((group) => group.cases);
    expect(all.length).toBeGreaterThanOrEqual(60);
    const vendors = new Set(all.map((c) => c.vendor ?? (c.gate ? "gate" : "claude")));
    for (const vendor of ["claude", "codex", "opencode", "cursor", "gate"]) expect(vendors).toContain(vendor);
  });

  for (const { file, cases } of groups) {
    describe(file, () => {
      cases.forEach((testCase, index) => {
        it(testCase.name, async () => {
          const db = openDatabase(join(dir, `${file}-${index}.sqlite`));
          openDbs.push(db);
          const atIso = testCase.at ?? DEFAULT_NOW;
          const clock = new FakeClock(Date.parse(atIso));
          const aggregates = new AggregateStore(db);
          const autonomy = new AutonomyStore(db);
          for (const prior of testCase.prior ?? []) {
            aggregates.record({
              cls: prior.cls,
              byField: prior.by,
              key: prior.key,
              value: prior.value,
              agent: "refunds-agent",
              actionId: `seed-${index}`,
              requestId: null,
              atMs: clock.nowMs() - prior.hours_ago * 3_600_000,
            });
          }
          if (testCase.autonomy) {
            autonomy.setLevel(
              testCase.agent ?? "refunds-agent",
              testCase.autonomy.cls,
              testCase.autonomy.bucket,
              testCase.autonomy.level,
              clock.nowMs(),
            );
          }
          const lookup = new FakeLookup(world);
          lookup.failing = testCase.lookups_down ?? false;
          const result = await evaluateAction(buildAction(testCase, atIso), {
            policy,
            lookup,
            clock,
            aggregates,
            autonomy,
          });
          const expected = testCase.expect;
          expect(result.decision, result.reason).toBe(expected.decision);
          if ("class" in expected) expect(result.cls ?? null).toBe(expected.class);
          if ("tier" in expected) expect(result.tier ?? null).toBe(expected.tier);
          if (expected.score !== undefined) expect(result.score).toBe(expected.score);
          if (expected.step !== undefined) expect(result.step).toBe(expected.step);
          if (expected.flags !== undefined) {
            expect(result.flags.map((flag) => flag.code).sort()).toEqual([...expected.flags].sort());
          }
        });
      });
    });
  }
});

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../lib/paths.ts";
import { acmeEffects, assertIsolated, EVAL_PORTS, SHARED_PORTS } from "./world.ts";

const inside = join(REPO_ROOT, ".tmp/eval/test");

describe("isolation", () => {
  it("accepts its own ports and a directory under .tmp", () => {
    expect(() => assertIsolated(EVAL_PORTS, inside)).not.toThrow();
  });

  it("refuses any port of the shared stack", () => {
    for (const port of SHARED_PORTS) {
      expect(() => assertIsolated({ ...EVAL_PORTS, core: port }, inside)).toThrow(/shared stack/);
      expect(() => assertIsolated({ ...EVAL_PORTS, gate: port }, inside)).toThrow(/shared stack/);
      expect(() => assertIsolated({ ...EVAL_PORTS, acme: port }, inside)).toThrow(/shared stack/);
    }
  });

  it("refuses a directory outside .tmp, such as data/", () => {
    expect(() => assertIsolated(EVAL_PORTS, join(REPO_ROOT, "data"))).toThrow(/isn't under \.tmp/);
    expect(() => assertIsolated(EVAL_PORTS, "/tmp/eval")).toThrow(/isn't under \.tmp/);
    expect(() => assertIsolated(EVAL_PORTS, join(REPO_ROOT, ".tmp"))).toThrow(/isn't under \.tmp/);
  });

  it("uses no shared port by default", () => {
    for (const port of Object.values(EVAL_PORTS)) {
      expect(SHARED_PORTS as readonly number[]).not.toContain(port);
    }
  });
});

describe("acmeEffects", () => {
  const empty = {
    money_out: 0,
    refunds: [],
    deploys: [],
    outbox: [],
    deleted_records: [],
    merges: [],
    destinations_added: [],
  };

  it("is zero on an untouched Acme", () => {
    expect(acmeEffects(empty)).toBe(0);
  });

  it("counts every kind of effect, so 'nothing happened' can't miss one", () => {
    const one = { id: "x", order_id: "x", amount: 1, destination: "x" };
    expect(acmeEffects({ ...empty, refunds: [one] })).toBe(1);
    expect(acmeEffects({ ...empty, deploys: [{}] })).toBe(1);
    expect(acmeEffects({ ...empty, outbox: [{}] })).toBe(1);
    expect(acmeEffects({ ...empty, deleted_records: [{}] })).toBe(1);
    expect(acmeEffects({ ...empty, merges: [{}] })).toBe(1);
    expect(acmeEffects({ ...empty, destinations_added: [{}] })).toBe(1);
  });
});

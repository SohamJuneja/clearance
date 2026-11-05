import { describe, expect, it } from "vitest";
import {
  compileExpression,
  evaluateExpression,
  ExpressionError,
  UNKNOWN,
  type EvalScope,
} from "../src/policy/expr.js";

function scope(vars: Record<string, unknown>, extra: Partial<EvalScope> = {}): EvalScope {
  return {
    vars,
    structuredArgs: true,
    helpers: {
      lookup: async (kind: unknown, id: unknown) => (kind === "orders" && id === "A-1" ? { total: 4000 } : UNKNOWN),
      domain: (value: unknown) => (typeof value === "string" ? value.split("@")[1] : UNKNOWN),
      len: (value: unknown) => (Array.isArray(value) ? value.length : UNKNOWN),
      count_rows: (value: unknown) => (Array.isArray(value) ? value.length * 10 : UNKNOWN),
      touches: () => UNKNOWN,
      outside_hours: () => false,
      friday_after: () => true,
    },
    ...extra,
  };
}

const run = (source: string, vars: Record<string, unknown> = {}) =>
  evaluateExpression(compileExpression(source), scope(vars));

describe("expression evaluator", () => {
  it.each([
    ["1 + 2 * 3", 7],
    ["3 * order_total", 12000],
    ["amount > 3 * order_total", true],
    ["amount <= 5000", false],
    ['env == "prod"', true],
    ['env != "prod"', false],
    ['domain in ["acme.in", "acme.com"]', true],
    ['not (domain in ["acme.in"])', false],
    ["a and b", false],
    ["a or b", true],
    ["not b", true],
    ["amount % 7 == 0", false],
    ["10 / 4", 2.5],
    ["-amount < 0", true],
  ])("%s", async (source, expected) => {
    const vars = { order_total: 4000, amount: 40000, env: "prod", domain: "acme.in", a: true, b: false };
    expect(await run(source, vars)).toBe(expected);
  });

  it("reads through member access and helper calls", async () => {
    expect(await run('lookup("orders", args.order_id).total', { args: { order_id: "A-1" } })).toBe(4000);
    expect(await run("domain(args.to)", { args: { to: "x@acme.in" } })).toBe("acme.in");
    expect(await run('args["to"]', { args: { to: "x" } })).toBe("x");
  });

  it("compares strings without regard to case, so PROD is still prod", async () => {
    expect(await run('env == "prod"', { env: "PROD" })).toBe(true);
    expect(await run('env in ["prod"]', { env: " Prod " })).toBe(true);
  });

  it("coerces numeric strings but nothing else", async () => {
    expect(await run("amount > 10000", { amount: "40000" })).toBe(true);
    expect(await run("amount > 10000", { amount: "40,000" })).toBe(UNKNOWN);
    expect(await run("amount > 10000", { amount: "0x9c40" })).toBe(UNKNOWN);
    expect(await run("amount > 10000", { amount: true })).toBe(UNKNOWN);
  });

  describe("three-valued logic: missing data never reads as false", () => {
    it.each([
      ["missing > 1", UNKNOWN],
      ["3 * missing", UNKNOWN],
      ["amount > 3 * missing", UNKNOWN],
      ['missing == "x"', UNKNOWN],
      ['missing != "x"', UNKNOWN],
      ['missing in ["x"]', UNKNOWN],
      ["not missing", UNKNOWN],
      ["missing and yes", UNKNOWN],
      ["missing and no", false],
      ["yes and missing", UNKNOWN],
      ["no and missing", false],
      ["missing or yes", true],
      ["missing or no", UNKNOWN],
      ["args.nothing > 1", UNKNOWN],
      ["args.nothing.deeper > 1", UNKNOWN],
      ['lookup("orders", "nope").total > 1', UNKNOWN],
      ["1 / 0", UNKNOWN],
    ])("%s", async (source, expected) => {
      expect(await run(source, { amount: 5, yes: true, no: false, args: {} })).toBe(expected);
    });
  });

  it("treats an argument the call simply did not pass as empty for len and count_rows", async () => {
    expect(await run("len(args.attachments)", { args: {} })).toBe(0);
    expect(await run("count_rows(args.attachments)", { args: {} })).toBe(0);
    const unstructured = await evaluateExpression(
      compileExpression("len(args.attachments)"),
      scope({ args: {} }, { structuredArgs: false }),
    );
    expect(unstructured).toBe(UNKNOWN);
  });

  describe("refuses anything that is not plain data access", () => {
    it.each([
      ['"".constructor.constructor("return 1")()'],
      ["args.toString()"],
      ["eval('1')"],
      ["process.exit(1)"],
      ["a ? b : c"],
      ["this.x"],
      ["a = 1"],
      ["a | b"],
      ["a << 1"],
      ["unknown_helper(1)"],
      ["1 +"],
      [""],
    ])("%s", (source) => {
      expect(() => compileExpression(source)).toThrow(ExpressionError);
    });

    it("blocks prototype walks at evaluation time", async () => {
      expect(await run("args.__proto__", { args: {} })).toBe(UNKNOWN);
      expect(await run("args.constructor", { args: {} })).toBe(UNKNOWN);
      expect(await run('args["__proto__"]', { args: {} })).toBe(UNKNOWN);
      expect(await run("args.inherited", { args: Object.create({ inherited: 1 }) })).toBe(UNKNOWN);
    });

    it("rejects 'not x in y', which would parse as (not x) in y", () => {
      expect(() => compileExpression('not domain in ["a"]')).toThrow(/parenthes/i);
    });
  });

  it("names the identifiers an expression reads", () => {
    const compiled = compileExpression('amount > 3 * order_total and lookup("x", args.y).z');
    expect([...compiled.identifiers].sort()).toEqual(["amount", "args", "order_total"]);
  });
});

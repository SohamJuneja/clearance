/**
 * The policy expression language. jsep parses; a whitelist validates; a small tree-walker evaluates.
 * There is no `eval`, no `Function`, and nothing can be called except the named helpers.
 *
 * Evaluation is three-valued. Anything that cannot be known (a lookup that found nothing, an argument
 * that isn't there, a value of the wrong type) is UNKNOWN, and UNKNOWN propagates. The caller decides
 * what an UNKNOWN condition means, and for risk rules it means "assume the worst and flag it", so
 * missing data can never silently lower risk.
 */
import jsep from "jsep";

jsep.addBinaryOp("or", 1);
jsep.addBinaryOp("and", 2);
jsep.addBinaryOp("in", 7);
jsep.addUnaryOp("not");

export const UNKNOWN = Symbol("unknown");
export type Unknown = typeof UNKNOWN;

export class ExpressionError extends Error {}

export const HELPERS = ["lookup", "domain", "touches", "count_rows", "outside_hours", "friday_after", "len"] as const;
export type HelperName = (typeof HELPERS)[number];
const HELPER_SET = new Set<string>(HELPERS);

const BINARY_OPS = new Set(["==", "!=", "<", "<=", ">", ">=", "+", "-", "*", "/", "%", "and", "or", "&&", "||", "in"]);
const UNARY_OPS = new Set(["not", "!", "-", "+"]);
const COMPARISONS = new Set(["==", "!=", "<", "<=", ">", ">=", "in"]);
const FORBIDDEN_PROPERTIES = new Set(["__proto__", "constructor", "prototype"]);

type Node = jsep.Expression;

export type CompiledExpression = {
  source: string;
  ast: Node;
  identifiers: Set<string>;
};

export type HelperFn = (...args: unknown[]) => unknown;

export type EvalScope = {
  vars: Record<string, unknown>;
  helpers: Record<HelperName, HelperFn>;
  /** True when `args` is the call's real argument object (gate, MCP), so an absent key means "not passed". */
  structuredArgs: boolean;
};

export function compileExpression(source: string): CompiledExpression {
  if (!source.trim()) throw new ExpressionError("empty expression");
  let ast: Node;
  try {
    ast = jsep(source);
  } catch (error) {
    throw new ExpressionError((error as Error).message);
  }
  const identifiers = new Set<string>();
  validate(ast, identifiers);
  return { source, ast, identifiers };
}

function validate(node: Node, identifiers: Set<string>): void {
  switch (node.type) {
    case "Literal":
      return;
    case "Identifier":
      identifiers.add(node.name as string);
      return;
    case "ArrayExpression":
      for (const element of node.elements as (Node | null)[]) {
        if (!element) throw new ExpressionError("empty array element");
        validate(element, identifiers);
      }
      return;
    case "UnaryExpression":
      if (!UNARY_OPS.has(node.operator as string)) throw new ExpressionError(`operator ${node.operator} is not allowed`);
      validate(node.argument as Node, identifiers);
      return;
    case "BinaryExpression": {
      const operator = node.operator as string;
      if (!BINARY_OPS.has(operator)) throw new ExpressionError(`operator ${operator} is not allowed`);
      const left = node.left as Node;
      if (COMPARISONS.has(operator) && left.type === "UnaryExpression" && left.operator !== "-" && left.operator !== "+") {
        throw new ExpressionError(`'${left.operator} a ${operator} b' reads as '(${left.operator} a) ${operator} b'; add parentheses`);
      }
      validate(left, identifiers);
      validate(node.right as Node, identifiers);
      return;
    }
    case "MemberExpression": {
      validate(node.object as Node, identifiers);
      if (node.computed) validate(node.property as Node, identifiers);
      return;
    }
    case "CallExpression": {
      const callee = node.callee as Node;
      if (callee.type !== "Identifier" || !HELPER_SET.has(callee.name as string)) {
        throw new ExpressionError("only the policy helpers can be called");
      }
      for (const argument of node.arguments as Node[]) validate(argument, identifiers);
      return;
    }
    case "Compound":
      throw new ExpressionError("expected a single expression");
    default:
      throw new ExpressionError(`${node.type} is not allowed`);
  }
}

export function evaluateExpression(expression: CompiledExpression, scope: EvalScope): Promise<unknown> {
  return walk(expression.ast, scope);
}

async function walk(node: Node, scope: EvalScope): Promise<unknown> {
  switch (node.type) {
    case "Literal":
      return node.value;
    case "Identifier":
      return lookupVar(scope.vars, node.name as string);
    case "ArrayExpression":
      return Promise.all((node.elements as Node[]).map((element) => walk(element, scope)));
    case "UnaryExpression":
      return unary(node.operator as string, await walk(node.argument as Node, scope));
    case "BinaryExpression":
      return binary(node, scope);
    case "MemberExpression":
      return member(node, scope);
    case "CallExpression":
      return call(node, scope);
    default:
      return UNKNOWN;
  }
}

function lookupVar(vars: Record<string, unknown>, name: string): unknown {
  if (!Object.hasOwn(vars, name)) return UNKNOWN;
  const value = vars[name];
  return value === undefined || value === null ? UNKNOWN : value;
}

async function member(node: Node, scope: EvalScope): Promise<unknown> {
  const object = await walk(node.object as Node, scope);
  if (object === UNKNOWN || typeof object !== "object" || object === null) return UNKNOWN;
  const property = node.property as Node;
  const key = node.computed ? await walk(property, scope) : property.name;
  if (typeof key !== "string" && typeof key !== "number") return UNKNOWN;
  if (FORBIDDEN_PROPERTIES.has(String(key))) return UNKNOWN;
  if (!Object.hasOwn(object, key)) return UNKNOWN;
  const value = (object as Record<string, unknown>)[key];
  return value === undefined || value === null ? UNKNOWN : value;
}

async function call(node: Node, scope: EvalScope): Promise<unknown> {
  const name = (node.callee as Node).name as HelperName;
  const argNodes = node.arguments as Node[];
  const args: unknown[] = [];
  for (const argNode of argNodes) {
    args.push(notPassed(name, argNode, scope) ? [] : await walk(argNode, scope));
  }
  return scope.helpers[name](...args);
}

/** `len(args.attachments)` on a gate call that passed no attachments is 0, not unknown. */
function notPassed(helper: HelperName, node: Node, scope: EvalScope): boolean {
  if (helper !== "len" && helper !== "count_rows") return false;
  if (!scope.structuredArgs || node.type !== "MemberExpression" || node.computed) return false;
  const object = node.object as Node;
  if (object.type !== "Identifier" || object.name !== "args") return false;
  const args = scope.vars.args;
  const key = (node.property as Node).name as string;
  return typeof args === "object" && args !== null && (!Object.hasOwn(args, key) || (args as Record<string, unknown>)[key] == null);
}

function unary(operator: string, value: unknown): unknown {
  if (value === UNKNOWN) return UNKNOWN;
  if (operator === "not" || operator === "!") return typeof value === "boolean" ? !value : UNKNOWN;
  const number = toNumeric(value);
  if (number === null) return UNKNOWN;
  return operator === "-" ? -number : number;
}

async function binary(node: Node, scope: EvalScope): Promise<unknown> {
  const operator = node.operator as string;
  const left = await walk(node.left as Node, scope);
  if (operator === "and" || operator === "&&") {
    if (left === false) return false;
    const right = await walk(node.right as Node, scope);
    if (right === false) return false;
    return left === true && right === true ? true : UNKNOWN;
  }
  if (operator === "or" || operator === "||") {
    if (left === true) return true;
    const right = await walk(node.right as Node, scope);
    if (right === true) return true;
    return left === false && right === false ? false : UNKNOWN;
  }
  const right = await walk(node.right as Node, scope);
  if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
  switch (operator) {
    case "==":
      return looseEqual(left, right);
    case "!=":
      return !looseEqual(left, right);
    case "in":
      return Array.isArray(right) ? right.some((item) => looseEqual(left, item)) : UNKNOWN;
    default:
      return numeric(operator, left, right);
  }
}

function numeric(operator: string, left: unknown, right: unknown): unknown {
  const a = toNumeric(left);
  const b = toNumeric(right);
  if (a === null || b === null) return UNKNOWN;
  switch (operator) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return b === 0 ? UNKNOWN : a / b;
    case "%":
      return b === 0 ? UNKNOWN : a % b;
    default:
      return UNKNOWN;
  }
}

function toNumeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

function looseEqual(left: unknown, right: unknown): boolean {
  if (typeof left === "string" && typeof right === "string") {
    return left.trim().toLowerCase() === right.trim().toLowerCase();
  }
  const a = toNumeric(left);
  const b = toNumeric(right);
  if (a !== null && b !== null) return a === b;
  return left === right;
}

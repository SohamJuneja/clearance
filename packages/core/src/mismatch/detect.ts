/**
 * Mismatch detection (F6 P1), deterministic: pull amounts, ids, addresses, versions and names out of what the
 * agent said and out of the call, and flag a value in the call that differs from the text or is missing from
 * it. A flag is evidence for the approver and never changes a decision.
 *
 * False flags teach people to ignore the real ones, so the rules lean quiet: a value of a type the agent never
 * mentioned is only flagged when it is the class's main value and the agent clearly talked about doing the
 * action. Anything said beside the right value ("order total ₹40,000, refunding ₹4,000") is fine.
 */
import type { Flag } from "@clearance/contracts";
import { formatMoney, oneLine, toNumber } from "../format.js";

export type MismatchInput = {
  cls: string;
  extracted: Record<string, unknown>;
  args: Record<string, unknown>;
  target: string;
  /** The agent's own words: its last messages in the origin thread, and any claim the adapter passed along. */
  said: string[];
  currency: string;
  /** Service names the team knows, so another service's name in the text can be recognised. */
  services: string[];
};

type Found = { raw: string; key: string };

type Check = {
  found: Found[];
  /** The call's value, comparable with `Found.key`. */
  key: string;
  /** The call's value as a person reads it. */
  display: string;
  /** The value the agent is told to state (PLAN 8.5 rule 4): silence about it counts. */
  primary: boolean;
};

const SCALE: Record<string, number> = { k: 1e3, lakh: 1e5, lac: 1e5, crore: 1e7, cr: 1e7 };
const NUMBER = String.raw`\d+(?:,\d+)*(?:\.\d+)?`;
const AMOUNT_PATTERNS: RegExp[] = [
  // ₹4,000  Rs. 4000  INR 40k
  new RegExp(String.raw`(?:₹|\bRs\.?|\bINR)\s*(${NUMBER})\s*(k|lakh|lac|crore|cr)?\b`, "gi"),
  // 40,000 rupees
  new RegExp(String.raw`\b(${NUMBER})\s*(k|lakh|lac|crore|cr)?\s*(?:rupees|rs\b|inr\b)`, "gi"),
  // 4 lakh
  new RegExp(String.raw`\b(${NUMBER})\s*(lakh|lac|crore)\b`, "gi"),
];
// "refund 4000": a bare number counts only right after the word, or dates and counts would read as money.
const CONTEXT_AMOUNT = new RegExp(String.raw`\b(?:refund(?:ing)?|amount|pay(?:ing|out)?)\s+(?:of\s+)?(${NUMBER})\b`, "gi");

function amountsIn(text: string): Found[] {
  const found: Found[] = [];
  const seen = new Set<number>();
  const add = (raw: string, digits: string, scale: string | undefined) => {
    const value = Number(digits.replace(/,/g, "")) * (scale ? (SCALE[scale.toLowerCase()] ?? 1) : 1);
    if (!Number.isFinite(value) || seen.has(value)) return;
    seen.add(value);
    found.push({ raw: raw.trim(), key: String(value) });
  };
  for (const pattern of AMOUNT_PATTERNS) {
    for (const match of text.matchAll(pattern)) add(match[0], match[1] as string, match[2]);
  }
  for (const match of text.matchAll(CONTEXT_AMOUNT)) {
    const digits = match[1] as string;
    if (digits.replace(/\D/g, "").length >= 3) add(digits, digits, undefined);
  }
  return found;
}

function matchesOf(text: string, pattern: RegExp, normalise: (raw: string) => string = (raw) => raw.toLowerCase()): Found[] {
  const seen = new Set<string>();
  const found: Found[] = [];
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const key = normalise(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ raw, key });
  }
  return found;
}

const CUSTOMER_IDS = /\bcus_[A-Za-z0-9]+\b/g;
const ORDER_IDS = /\bA-\d+\b/g;
const ADDRESSES = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*/g;
/** The whole version, suffix and all: `v3.4.0-rc.2` is not `v3.4.0`. A sentence's full stop is not part of it. */
const VERSIONS = /\bv\d+(?:\.\d+)+(?:[-+][0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?/g;
const ENVIRONMENTS = /\b(?:prod|production|staging)\b/gi;
const BRANCHES = /\b(?:(?:feature|fix|hotfix|bugfix|release)\/[\w./-]*\w|main|master|develop)\b/g;
const PULLS = /(?:\bPR\s*#?|\bpull request\s*#?|#)(\d+)\b/gi;

function pullsIn(text: string): Found[] {
  return [...text.matchAll(PULLS)].map((match) => ({ raw: `#${match[1]}`, key: match[1] as string }));
}

function normaliseEnv(raw: string): string {
  const env = raw.trim().toLowerCase();
  return env === "production" ? "prod" : env;
}

function servicesIn(text: string, services: string[]): Found[] {
  return services.flatMap((service) => {
    const escaped = service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(String.raw`(?<![\w-])${escaped}(?![\w-])`, "i").test(text)
      ? [{ raw: service, key: service.toLowerCase() }]
      : [];
  });
}

/** `git push --force origin main` is main; `git push origin HEAD:main` is main too. */
function branchFromCommand(command: unknown): string | null {
  if (typeof command !== "string") return null;
  const match = /\bgit\s+push\b([^;&|]*)/.exec(command);
  if (!match) return null;
  const words = (match[1] as string).trim().split(/\s+/).filter((word) => word && !word.startsWith("-"));
  const last = words.length >= 2 ? words[words.length - 1] : null;
  return last ? (last.split(":").pop() as string) : null;
}

const present = (value: unknown): boolean => value !== undefined && value !== null && value !== "";

const stringKey = (value: unknown): string => String(value).trim().toLowerCase();

const SAYS_THE_ACTION: Record<string, RegExp> = {
  refund: /\brefund/i,
  payout_change: /\b(?:payout|destination)/i,
  deploy: /\b(?:deploy|ship|release|roll)/i,
  rollback: /\b(?:roll|revert)/i,
  merge: /\b(?:merg|push)/i,
  customer_email: /\b(?:e-?mail|send|sending|sent|mail)/i,
  delete: /\b(?:delet|remov|drop)/i,
};

function refundChecks(input: MismatchInput, text: string): Check[] {
  const { extracted } = input;
  const checks: Check[] = [];
  const amount = toNumber(extracted.amount);
  if (amount !== null) {
    checks.push({
      found: amountsIn(text),
      key: String(amount),
      display: formatMoney(amount, input.currency),
      primary: true,
    });
  }
  if (present(extracted.customer)) {
    const customer = oneLine(extracted.customer);
    checks.push({ found: matchesOf(text, CUSTOMER_IDS), key: stringKey(customer), display: customer, primary: false });
  }
  if (present(extracted.order)) {
    const order = oneLine(extracted.order);
    checks.push({ found: matchesOf(text, ORDER_IDS), key: stringKey(order), display: order, primary: false });
  }
  if (present(extracted.destination)) {
    const destination = oneLine(extracted.destination);
    checks.push({ found: matchesOf(text, ADDRESSES), key: stringKey(destination), display: destination, primary: false });
  }
  return checks;
}

function payoutChecks(input: MismatchInput, text: string): Check[] {
  const { extracted } = input;
  const checks: Check[] = [];
  if (present(extracted.customer)) {
    const customer = oneLine(extracted.customer);
    checks.push({ found: matchesOf(text, CUSTOMER_IDS), key: stringKey(customer), display: customer, primary: false });
  }
  if (present(extracted.upi)) {
    const upi = oneLine(extracted.upi);
    checks.push({ found: matchesOf(text, ADDRESSES), key: stringKey(upi), display: upi, primary: true });
  }
  return checks;
}

function deployChecks(input: MismatchInput, text: string): Check[] {
  const { extracted } = input;
  const checks: Check[] = [];
  if (present(extracted.service)) {
    const service = oneLine(extracted.service);
    checks.push({ found: servicesIn(text, input.services), key: stringKey(service), display: service, primary: false });
  }
  if (present(extracted.version)) {
    const version = oneLine(extracted.version);
    checks.push({ found: matchesOf(text, VERSIONS), key: stringKey(version), display: version, primary: false });
  }
  if (present(extracted.env)) {
    const env = oneLine(extracted.env);
    checks.push({ found: matchesOf(text, ENVIRONMENTS, normaliseEnv), key: normaliseEnv(env), display: env, primary: true });
  }
  return checks;
}

function mergeChecks(input: MismatchInput, text: string): Check[] {
  const checks: Check[] = [];
  if (present(input.extracted.pr)) {
    const pr = oneLine(input.extracted.pr);
    checks.push({ found: pullsIn(text), key: pr, display: `#${pr}`, primary: true });
  }
  const branch = branchFromCommand(input.args.command);
  if (branch) {
    checks.push({ found: matchesOf(text, BRANCHES), key: stringKey(branch), display: oneLine(branch), primary: true });
  }
  return checks;
}

function emailChecks(input: MismatchInput, text: string): Check[] {
  if (!present(input.extracted.to)) return [];
  const to = oneLine(input.extracted.to);
  return [{ found: matchesOf(text, ADDRESSES), key: stringKey(to), display: to, primary: true }];
}

function deleteChecks(input: MismatchInput, text: string): Check[] {
  const record = /\/([^/]+)$/.exec(input.target)?.[1];
  if (!record) return [];
  const pattern = record.startsWith("cus_") ? CUSTOMER_IDS : record.startsWith("A-") ? ORDER_IDS : null;
  if (!pattern) return [];
  return [{ found: matchesOf(text, pattern), key: stringKey(record), display: oneLine(record), primary: true }];
}

function checksFor(input: MismatchInput, text: string): Check[] {
  switch (input.cls) {
    case "refund":
      return refundChecks(input, text);
    case "payout_change":
      return payoutChecks(input, text);
    case "deploy":
    case "rollback":
      return deployChecks(input, text);
    case "merge":
      return mergeChecks(input, text);
    case "customer_email":
      return emailChecks(input, text);
    case "delete":
      return deleteChecks(input, text);
    default:
      return [];
  }
}

export function detectMismatch(input: MismatchInput): Flag[] {
  const text = input.said.join("\n");
  if (!text.trim()) return [];
  const talksAboutIt = SAYS_THE_ACTION[input.cls]?.test(text) ?? false;
  const flags: Flag[] = [];
  for (const check of checksFor(input, text)) {
    if (check.found.some((found) => found.key === check.key)) continue;
    const other = check.found[0];
    if (other) {
      flags.push({
        code: "mismatch",
        text: `The agent wrote "${oneLine(other.raw, 80)}" in the thread; the call says ${check.display}`,
      });
    } else if (check.primary && talksAboutIt) {
      flags.push({ code: "mismatch", text: `The agent did not say ${check.display} in the thread, but the call does` });
    }
  }
  return flags;
}

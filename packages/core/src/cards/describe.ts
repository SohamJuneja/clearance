/**
 * The call in business terms, from the parsed call and systems of record, never from the agent's sentence.
 * Everything from the call goes through `oneLine`: it is agent-controlled, and must not be able to fake a
 * line of the card.
 */
import type { CanonicalCall } from "@clearance/contracts";
import { formatMoney, oneLine, toNumber } from "../format.js";
import { formatAgeHours } from "../time.js";

export type DescribeInput = {
  cls: string;
  call: CanonicalCall;
  extracted: Record<string, unknown>;
  lookups: Record<string, Record<string, unknown>>;
  currency: string;
  agent: string;
  /** Already in the 24 h sum for this customer, before this call. Null when the class has no such rule. */
  priorSum: number | null;
  /** This agent's calls of this class in the window, before this one. */
  agentActivity: { count: number; largest: number } | null;
  /** Name of the service's owner, if the team has one on file. */
  serviceOwner: string | null;
  /** The whole shell line, when the call covers only the risky part of it. */
  asWritten?: string;
};

export type CallDescription = { headline: string; call: string[]; context: string[] };

function money(value: unknown, currency: string): string {
  const number = toNumber(value);
  return number === null ? oneLine(value) : formatMoney(number, currency);
}

function lookedUp(input: DescribeInput, kind: string, id: unknown): Record<string, unknown> | null {
  if (id === undefined || id === null) return null;
  return input.lookups[`${kind}:${String(id)}`] ?? null;
}

const present = (value: unknown): boolean => value !== undefined && value !== null && value !== "";

function fromShell(input: DescribeInput): string[] | null {
  const command = input.call.args.command;
  return typeof command === "string" ? [`Run: ${oneLine(command, 300)}`] : null;
}

function describeRefund(input: DescribeInput): CallDescription {
  const { extracted: fields, currency } = input;
  const hasAmount = present(fields.amount);
  const amount = hasAmount ? money(fields.amount, currency) : "an unknown amount";
  const customer = oneLine(fields.customer ?? "unknown");
  const who = present(fields.customer_name) ? `${oneLine(fields.customer_name)} (${customer})` : customer;
  const call = fromShell(input) ?? [`Refund ${amount} to customer ${who}`];
  if (present(fields.destination)) {
    const destination = oneLine(fields.destination);
    call.push(`Destination: ${destination.includes("@") ? "UPI " : ""}${destination}`);
  }
  if (present(fields.order)) {
    const total = present(fields.order_total) ? money(fields.order_total, currency) : "unknown";
    call.push(`Order ${oneLine(fields.order)} · total ${total}`);
  }
  const context: string[] = [];
  if (input.priorSum !== null) context.push(`Refunds to this customer in 24 h: ${formatMoney(input.priorSum, currency)}`);
  const age = toNumber(fields.destination_age_hours);
  if (age !== null) context.push(`Destination added ${formatAgeHours(age)}`);
  else if (present(fields.destination)) context.push("Destination is not on file");
  if (input.agentActivity) {
    const { count, largest } = input.agentActivity;
    const biggest = count > 0 ? ` (largest ${formatMoney(largest, currency)})` : "";
    context.push(`${input.agent} refunds today: ${count}${biggest}`);
  }
  return { headline: hasAmount ? `REFUND ${amount}` : "REFUND", call, context };
}

function describeDeploy(input: DescribeInput): CallDescription {
  const { extracted: fields } = input;
  if (!present(fields.service)) {
    return { headline: "DEPLOY", call: fromShell(input) ?? [`Call: ${oneLine(input.call.target)}`], context: [] };
  }
  const service = oneLine(fields.service);
  const version = oneLine(fields.version ?? "unknown version");
  const env = oneLine(fields.env ?? "unknown environment");
  const context: string[] = [];
  if (input.serviceOwner) context.push(`Service owner: ${input.serviceOwner}`);
  if (present(fields.live_version)) context.push(`Live now: ${oneLine(fields.live_version)}`);
  const ci = lookedUp(input, "ci", fields.version);
  if (ci) {
    const failing = Array.isArray(ci.failing) ? ci.failing.map((name) => oneLine(name)) : [];
    const detail = failing.length > 0 ? ` (${failing.length} failing: ${failing.join(", ")})` : "";
    context.push(`Checks: ${oneLine(ci.status)}${detail}`);
  } else {
    context.push("Checks: not known to CI");
  }
  return {
    headline: `DEPLOY ${service} ${version} ${env}`,
    call: [`Deploy ${service} ${version} to ${env}`],
    context,
  };
}

function describeMerge(input: DescribeInput): CallDescription {
  const { extracted: fields } = input;
  const shell = fromShell(input);
  if (shell) return { headline: "MERGE", call: shell, context: ["Not a tracked pull request: nothing to look up"] };
  const repo = oneLine(fields.repo ?? "unknown repo");
  const pr = oneLine(fields.pr ?? "unknown");
  const context: string[] = [];
  if (present(fields.author)) context.push(`Author: ${oneLine(fields.author)}`);
  if (present(fields.diff_lines)) context.push(`Diff: ${oneLine(fields.diff_lines)} lines`);
  const pull = lookedUp(input, "github", fields.pr);
  if (pull && Array.isArray(pull.files)) {
    context.push(`Files: ${oneLine(pull.files.map((file) => String(file)).join(", "), 300)}`);
  }
  if (pull && present(pull.checks)) context.push(`Checks: ${oneLine(pull.checks)}`);
  return { headline: `MERGE ${repo}#${pr}`, call: [`Merge PR #${pr} in ${repo}`], context };
}

function describeEmail(input: DescribeInput): CallDescription {
  const { extracted: fields } = input;
  const to = oneLine(fields.to ?? "unknown recipient");
  const shell = fromShell(input);
  const call = shell ?? [`Email to ${to}`];
  if (present(fields.subject)) call.push(`Subject: ${oneLine(fields.subject)}`);
  const attachments = input.call.args.attachments;
  if (Array.isArray(attachments) && attachments.length > 0) {
    call.push(`Attachments: ${oneLine(attachments.map((name) => String(name)).join(", "))}`);
  }
  const context: string[] = [];
  if (present(fields.domain)) context.push(`Recipient domain: ${oneLine(fields.domain)}`);
  const rows = toNumber(fields.rows);
  if (rows !== null && rows > 0) context.push(`Rows in attachments: ${new Intl.NumberFormat("en-IN").format(rows)}`);
  return { headline: shell ? "CUSTOMER EMAIL" : `CUSTOMER EMAIL ${to}`, call, context };
}

function describeDelete(input: DescribeInput): CallDescription {
  const shell = fromShell(input);
  if (shell) return { headline: "DELETE", call: shell, context: [] };
  const record = oneLine(input.call.target.replace(/^DELETE\s+\/acme\/records\//, ""));
  return { headline: `DELETE ${record}`, call: [`Delete ${record}`], context: [] };
}

function describeGeneric(input: DescribeInput): CallDescription {
  const headline =
    input.cls === "unknown_protected"
      ? "PROTECTED"
      : input.cls === "unparsed"
        ? "UNREADABLE SHELL"
        : input.cls.toUpperCase().replace(/_/g, " ");
  const shell = fromShell(input);
  if (shell) return { headline, call: shell, context: [] };
  const call = [`Call: ${oneLine(input.call.target, 300)}`];
  const entries = Object.keys(input.call.args);
  if (entries.length > 0) call.push(`Arguments: ${oneLine(JSON.stringify(input.call.args), 400)}`);
  return { headline, call, context: [] };
}

export function describeCall(input: DescribeInput): CallDescription {
  const description = describeByClass(input);
  if (input.asWritten) description.context.push(`As written: ${oneLine(input.asWritten, 300)}`);
  return description;
}

function describeByClass(input: DescribeInput): CallDescription {
  switch (input.cls) {
    case "refund":
      return describeRefund(input);
    case "deploy":
      return describeDeploy(input);
    case "merge":
      return describeMerge(input);
    case "customer_email":
      return describeEmail(input);
    case "delete":
      return describeDelete(input);
    default:
      return describeGeneric(input);
  }
}

/** "refund re_7731 for ₹40,000", the agent notification's account of what ran. */
export function describeResult(
  cls: string,
  extracted: Record<string, unknown>,
  target: string,
  result: unknown,
  currency: string,
): string {
  const id =
    typeof result === "object" && result !== null && "id" in result ? oneLine((result as { id: unknown }).id) : null;
  switch (cls) {
    case "refund": {
      const amount = present(extracted.amount) ? ` for ${money(extracted.amount, currency)}` : "";
      return `refund${id ? ` ${id}` : ""}${amount}`;
    }
    case "deploy":
      return `deploy of ${oneLine(extracted.service ?? target)} ${oneLine(extracted.version ?? "")} to ${oneLine(extracted.env ?? "")}`.trim();
    case "merge":
      return `merge of PR #${oneLine(extracted.pr ?? "")}`;
    case "customer_email":
      return `email to ${oneLine(extracted.to ?? "")}`;
    default:
      return id ? `${cls} ${id}` : oneLine(target);
  }
}

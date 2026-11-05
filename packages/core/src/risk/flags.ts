/** Wording for risk flags, exactly as the card shows them (Appendix D). */
import type { Flag } from "@clearance/contracts";
import { formatMoney, oneLine, toNumber } from "../format.js";

function ratio(amount: number, total: number): string {
  const value = amount / total;
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function ruleFlag(code: string, extracted: Record<string, unknown>, currency: string): Flag {
  return { code, text: ruleFlagText(code, extracted, currency) };
}

function ruleFlagText(code: string, extracted: Record<string, unknown>, _currency: string): string {
  switch (code) {
    case "amount_vs_order": {
      const amount = toNumber(extracted.amount);
      const total = toNumber(extracted.order_total);
      if (amount !== null && total !== null && total > 0) return `Amount is ${ratio(amount, total)}x the order total`;
      return "Amount is far above the order total";
    }
    case "new_destination":
      return "Destination added in the last 24 h";
    case "failing_checks":
      return `Checks are not passing for ${oneLine(extracted.version ?? "this version")}`;
    case "touches_auth":
      return "The diff touches auth code";
    case "bulk_data":
      return `Attachments hold ${new Intl.NumberFormat("en-IN").format(toNumber(extracted.rows) ?? 0)} rows`;
    case "outside_hours":
      return "Outside business hours";
    default:
      return code.replace(/_/g, " ");
  }
}

export function aggregateFlag(prior: number, value: number, over: number, windowText: string, currency: string): Flag {
  const total = formatMoney(prior + value, currency);
  return {
    code: "aggregate_limit",
    text: `With this call the ${windowText} total reaches ${total}, over the ${formatMoney(over, currency)} limit`,
  };
}

export function missingDataFlag(fields: string[]): Flag {
  return {
    code: "missing_data",
    text: `Could not verify ${fields.join(", ")} from systems of record: treated as risky`,
  };
}

export const NO_RULE_FLAG: Flag = { code: "no_rule", text: "No policy rule covers this protected resource" };
export const MALFORMED_FLAG: Flag = { code: "malformed", text: "The call could not be read" };
export const REQUESTER_UNKNOWN_FLAG: Flag = {
  code: "requester_unknown",
  text: "Requester unknown: nobody addressed this agent in the last 10 minutes",
};

export function unparsedFlag(reason: string): Flag {
  return { code: "unparsed", text: `Could not read this shell line with confidence: ${reason}` };
}

export function dynamicArgsFlag(words: string[]): Flag {
  return { code: "dynamic_args", text: `Some values are only known when it runs: ${oneLine(words.join(", "), 120)}` };
}

export function authorUnknownFlag(field: string): Flag {
  return { code: `${field}_unknown`, text: `Could not tell who the ${field} is, so nobody was excluded for it` };
}

/** Lower-case and short, for "CLR-0042 denied by Sam: amount is 10x the order". */
export function denialReason(flags: Flag[]): string | null {
  const top = flags[0];
  if (!top) return null;
  if (top.code === "amount_vs_order") return top.text.replace(/^Amount/, "amount").replace(" total", "");
  return top.text.charAt(0).toLowerCase() + top.text.slice(1);
}

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

export function aboveNormalRangeFlag(amount: number, ceiling: number, currency: string): Flag {
  return {
    code: "above_normal_range",
    text: `${formatMoney(amount, currency)} is above this agent's normal range for this bucket (95th percentile ${formatMoney(ceiling, currency)})`,
  };
}

export function overCapFlag(spent: number, cap: number, money: boolean, currency: string): Flag {
  const show = (value: number) => (money ? formatMoney(value, currency) : String(value));
  return { code: "over_daily_cap", text: `Over today's budget for running alone: ${show(spent)} used of ${show(cap)}` };
}

export function missingDataFlag(fields: string[]): Flag {
  return {
    code: "missing_data",
    text: `Could not verify ${fields.join(", ")} from systems of record: treated as risky`,
  };
}

export const NO_RULE_FLAG: Flag = { code: "no_rule", text: "No policy rule covers this protected resource" };
export const MALFORMED_FLAG: Flag = { code: "malformed", text: "The call could not be read" };
export function outsideAgentDirFlag(path: string): Flag {
  return { code: "outside_agent_dir", text: `Reads outside this agent's own directory: ${oneLine(path, 160)}` };
}

const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five"];

export function requesterUnknownFlag(quorum: number): Flag {
  return {
    code: "requester_unknown",
    text: `Requester unknown: nobody can tell who asked, so this needs ${COUNT_WORDS[quorum] ?? quorum} approvals from different people.`,
  };
}

export function agentElsewhereFlag(quorum: number): Flag {
  return {
    code: "agent_elsewhere",
    text: `This agent is also working somewhere Clearance can't see, so this needs ${COUNT_WORDS[quorum] ?? quorum} approvals from different people.`,
  };
}

export function agentReachUnknownFlag(quorum: number): Flag {
  return {
    code: "agent_reach_unknown",
    text: `Clearance couldn't check where this agent is working, so this needs ${COUNT_WORDS[quorum] ?? quorum} approvals from different people.`,
  };
}

export function unparsedFlag(reason: string): Flag {
  return { code: "unparsed", text: `Could not read this shell line with confidence: ${reason}` };
}

export function dynamicArgsFlag(words: string[]): Flag {
  return { code: "dynamic_args", text: `Some values are only known when it runs: ${oneLine(words.join(", "), 120)}` };
}

export function authorUnknownFlag(field: string): Flag {
  return { code: `${field}_unknown`, text: `Could not tell who the ${field} is, so nobody was excluded for it` };
}

/**
 * Type-to-confirm (F6): on a critical card, or the next high card after a rubber-stamp flag, the approver types
 * a value from the card to approve. The field asked for rotates, because a habit forms around a fixed question.
 * All of this is plain string work on the call as held, so a typed value can never come from what the agent said.
 */
import { toNumber } from "../format.js";

export type ConfirmField = "amount" | "destination_last4" | "service" | "domain" | "pr" | "request_id";

const present = (value: unknown): boolean => value !== undefined && value !== null && String(value).trim() !== "";

/**
 * The approver types the value in quotes, and an agent can choose these values. One that would break the quotes, or
 * that nobody could be expected to type, is not something to ask for.
 */
const TYPEABLE_MAX = 60;
const typeable = (value: unknown): boolean => {
  const text = String(value).trim();
  return text.length <= TYPEABLE_MAX && !/["\r\n]/.test(text);
};

/** The fields this call can be asked about. The first group rotates; the rest is what a card without them has. */
export function confirmFieldsFor(extracted: Record<string, unknown>): ConfirmField[] {
  const fields: ConfirmField[] = [];
  if (toNumber(extracted.amount) !== null) fields.push("amount");
  const destination = String(extracted.destination ?? "").trim();
  if (destination.length >= 4 && typeable(destination.slice(-4)) && fields.length > 0) fields.push("destination_last4");
  const askable = (value: unknown) => present(value) && typeable(value);
  if (askable(extracted.service)) fields.push("service");
  if (fields.length > 0) return fields;
  if (askable(extracted.domain)) return ["domain"];
  if (askable(extracted.pr)) return ["pr"];
  return ["request_id"];
}

function moneyWords(currency: string): string {
  return currency === "INR" ? "in rupees" : `in ${currency}`;
}

/**
 * The question says how to reply and never what to type: the value is on the card's evidence, and looking there is the
 * point. Switch's rules, all measured: a bare `A19 38000` is silently ignored and `A19 "38000"` works, hence "in quotes";
 * a word like `A19 no` is refused on a questions card; `A19 1` picks option 1, which is the No. "The request code" is
 * the handle, which only Switch knows, and it writes it on the card's own request line.
 */
export function askText(field: ConfirmField, requestId: string, cls: string, currency: string): string {
  const what: Record<ConfirmField, string> = {
    amount: `the ${cls === "refund" ? "refund " : ""}amount ${moneyWords(currency)}`,
    destination_last4: "the last 4 characters of the destination",
    service: "the service name",
    domain: "the recipient's domain",
    pr: "the pull request number",
    request_id: "the CLR number from the title",
  };
  // Asked for the id itself, the question can't open with it. It's in the card's title, which is enough to look at.
  const opener = field === "request_id" ? "This" : requestId;
  return `${opener} is high risk. To approve, type ${what[field]}, in quotes, after the request code. Or choose No, deny.`;
}

export const DENY_OPTION_ID = "deny";

const QUOTE_PAIRS: [string, string][] = [
  ['"', '"'],
  ["'", "'"],
  ["\u201c", "\u201d"],
  ["\u2018", "\u2019"],
];

/** Switch hands over what was inside the quotes, and the Lab's box whatever was typed. Either way it's the same value. */
function unquoted(text: string): string {
  const trimmed = text.trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (trimmed.length >= 2 && trimmed.startsWith(open) && trimmed.endsWith(close)) return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

const SCALE: Record<string, number> = { k: 1e3, lakh: 1e5, lac: 1e5, crore: 1e7, cr: 1e7 };
const TYPED_AMOUNT = /^(?:₹|rs\.?|inr)?\s*(\d+(?:,\d+)*(?:\.\d+)?)\s*(k|lakh|lac|crore|cr)?\s*(?:rupees|rs\.?|inr)?$/i;

function typedAmount(text: string): number | null {
  const match = TYPED_AMOUNT.exec(text.trim());
  if (!match) return null;
  const value = Number((match[1] as string).replace(/,/g, ""));
  return value * (match[2] ? (SCALE[match[2].toLowerCase()] ?? 1) : 1);
}

export function typedMatches(
  field: ConfirmField,
  text: string,
  extracted: Record<string, unknown>,
  requestId: string,
): boolean {
  const typed = unquoted(text);
  switch (field) {
    case "amount": {
      const expected = toNumber(extracted.amount);
      const given = typedAmount(typed);
      return expected !== null && given !== null && Math.abs(expected - given) < 1e-6;
    }
    case "destination_last4":
      return present(extracted.destination) && typed.toLowerCase() === String(extracted.destination).trim().slice(-4).toLowerCase();
    case "service":
      return present(extracted.service) && typed.toLowerCase() === String(extracted.service).trim().toLowerCase();
    case "domain":
      return present(extracted.domain) && typed.toLowerCase() === String(extracted.domain).trim().toLowerCase();
    case "pr":
      return present(extracted.pr) && typed.replace(/^#/, "") === String(extracted.pr).trim();
    case "request_id":
      return typed.toUpperCase() === requestId.toUpperCase();
  }
}

export type QuestionReading = { kind: "deny" } | { kind: "typed"; text: string } | { kind: "none" };

const SAYS_NO = new Set(["no", "n", "deny", "denied", "reject", "rejected", "decline", "declined"]);

/** Switch's stored shape: `{question_id, selected_option_ids, custom_text}`. Anything else is no answer. */
export function readQuestionAnswer(answers: Record<string, unknown>[] | null | undefined, questionId: string): QuestionReading {
  const entry = answers?.find((answer) => answer.question_id === questionId);
  if (!entry) return { kind: "none" };
  const selected = Array.isArray(entry.selected_option_ids) ? entry.selected_option_ids : [];
  if (selected.includes(DENY_OPTION_ID)) return { kind: "deny" };
  if (typeof entry.custom_text !== "string") return { kind: "none" };
  const text = unquoted(entry.custom_text);
  if (!text) return { kind: "none" };
  return SAYS_NO.has(text.toLowerCase().replace(/[.!]+$/, "")) ? { kind: "deny" } : { kind: "typed", text };
}

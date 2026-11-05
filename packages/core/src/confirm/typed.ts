/**
 * Type-to-confirm (F6): on a critical card, or the next high card after a rubber-stamp flag, the approver types
 * a value from the card to approve. The field asked for rotates, because a habit forms around a fixed question.
 * All of this is plain string work on the call as held, so a typed value can never come from what the agent said.
 */
import { toNumber } from "../format.js";

export type ConfirmField = "amount" | "destination_last4" | "service" | "domain" | "pr" | "request_id";

const present = (value: unknown): boolean => value !== undefined && value !== null && String(value).trim() !== "";

/**
 * The value goes in quotes in the card's how-to, and in the approver's reply. An agent can choose these values, so
 * one that would break the quotes or swamp the card is not something to ask for.
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

/** The value as the how-to shows it, and as `typedMatches` accepts it. */
export function typedValue(field: ConfirmField, extracted: Record<string, unknown>, requestId: string): string {
  switch (field) {
    case "amount":
      return String(toNumber(extracted.amount));
    case "destination_last4":
      return String(extracted.destination).trim().slice(-4);
    case "service":
      return String(extracted.service).trim();
    case "domain":
      return String(extracted.domain).trim();
    case "pr":
      return String(extracted.pr).trim();
    case "request_id":
      return requestId;
  }
}

/**
 * Switch's real rules, all measured: a word like `A19 no` is refused on a questions card, a bare `A19 38000` is
 * silently ignored, `A19 "38000"` works, and `A19 1` picks option 1, which is the No. The handle is only ever written
 * into the post by Switch, after we've opened the card, so the how-to names it with a placeholder and Switch's own
 * request line shows the real one.
 */
export const HANDLE_PLACEHOLDER = "<handle>";

export function askText(field: ConfirmField, requestId: string, cls: string, currency: string, extracted: Record<string, unknown>): string {
  const what: Record<ConfirmField, string> = {
    amount: `the ${cls === "refund" ? "refund " : ""}amount ${moneyWords(currency)}`,
    destination_last4: "the last 4 characters of the destination",
    service: "the service name",
    domain: "the recipient's domain",
    pr: "the pull request number",
    request_id: "this request's id",
  };
  const reply = `${HANDLE_PLACEHOLDER} "${typedValue(field, extracted, requestId)}"`;
  return `${requestId} is high risk. Type ${what[field]} to approve: ${reply}. Or choose No.`;
}

export const DENY_OPTION_ID = "deny";

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
  const typed = text.trim();
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
  const text = entry.custom_text.trim();
  if (!text) return { kind: "none" };
  return SAYS_NO.has(text.toLowerCase().replace(/[.!]+$/, "")) ? { kind: "deny" } : { kind: "typed", text };
}

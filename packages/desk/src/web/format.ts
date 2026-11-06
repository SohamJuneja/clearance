/** Display formatting. The numbers themselves always come from the API; these only spell them. */

/** "2m 14s", "45s", "1h 05m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d`;
}

/** "in 22m 46s", or "overdue" when the moment has passed and core has not yet closed it. */
export function formatUntil(iso: string, nowMs: number): string {
  const ms = Date.parse(iso) - nowMs;
  return ms <= 0 ? "overdue" : `in ${formatDuration(ms)}`;
}

export const formatAge = (iso: string, nowMs: number): string => formatDuration(nowMs - Date.parse(iso));

/** The team's clock, whichever machine shows the page. */
const CLOCK = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

export function formatClock(ms: number): string {
  return `${CLOCK.format(ms)} IST`;
}

export function formatDateTime(ms: number): string {
  return `${DAY.format(ms)}, ${CLOCK.format(ms)}`;
}

export const formatCount = (value: number): string => new Intl.NumberFormat("en-IN").format(value);

/** Whole seconds for latency, because that is what a person feels. */
export function formatLatency(ms: number | null): string {
  return ms === null ? "–" : formatDuration(ms);
}

export const shortHash = (hash: string): string => hash.slice(0, 8);

/** Core's rate as core rounded it. Null is no traffic yet, which is not a rate of zero. */
export const formatRate = (value: number | null): string => (value === null ? "–" : String(value));

export const formatPercent = (rate: number | null): string => (rate === null ? "–" : `${Math.round(rate * 100)}%`);

/** "Sam", "Sam and Alex", "Sam, Alex and Neha". */
export function joinNames(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

const FRICTION_WORDS: Record<string, string> = {
  drill_miss: "a missed drill",
  fast: "fast approvals",
  streak: "a streak of approvals",
  batch: "approvals in a batch",
  flag_ignored: "approving past a flag",
};

export const frictionWords = (friction: string | null): string | null => (friction === null ? null : (FRICTION_WORDS[friction] ?? friction.replace(/_/g, " ")));

export function sentenceCase(text: string): string {
  const spaced = text.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const PLAIN_NAMES: Record<string, string> = {
  HELD: "Held",
  ROUTED: "With approver",
};

export const stateName = (state: string): string => PLAIN_NAMES[state] ?? sentenceCase(state.toLowerCase());

/** One readable line for a ledger entry. Everything else is one click away in its raw payload. */
export function summariseEntry(type: string, payload: Record<string, unknown>, names: Record<string, string> = {}): string {
  const text = (key: string) => (typeof payload[key] === "string" || typeof payload[key] === "number" ? String(payload[key]) : null);
  const list = (key: string) => (Array.isArray(payload[key]) ? (payload[key] as unknown[]).map(String) : null);
  const name = (id: string | null) => (id === null ? null : (names[id] ?? id));
  const people = (key: string) => list(key)?.map((id) => names[id] ?? id).join(", ");
  const scope = [text("agent"), text("class"), text("bucket")]
    .filter(Boolean)
    .map((part) => (part as string).replace(/_/g, " "))
    .join(" · ");
  switch (type) {
    case "held":
      return [text("agent"), text("class")?.replace(/_/g, " "), text("tier")].filter(Boolean).join(" · ");
    case "routed":
      return `To ${people("chosen") || "nobody yet"}`;
    case "answered": {
      // Answer times are per person, so they stay off team views (PLAN F10). The admin view has them.
      return `${name(text("user_id")) ?? "Someone"}: ${text("decision") ?? "answered"}`;
    }
    case "ineligible_answer":
      return `${name(text("user_id")) ?? "Someone"}'s answer refused: ${
        list("reasons")
          ?.map((reason) => reason.replace(/_/g, " "))
          .join(", ") ?? "not eligible"
      }`;
    case "approved":
      return `By ${people("approved_by") ?? "unknown"}`;
    case "denied":
      return text("denied_by") ? `By ${name(text("denied_by"))}` : (text("reason") ?? "");
    case "escalated":
      return payload.kind === "add" ? `Backup added: ${name(text("added")) ?? "nobody available"}` : payload.kind === "post" ? `Posted to ${text("room")}` : "Requester told";
    case "executed":
      return payload.ok === true ? "Ran" : `Failed: ${text("error") ?? "unknown error"}`;
    case "expired":
      return "Nothing was executed";
    case "cancelled":
      return text("by") ? `By ${text("by")}` : "";
    case "policy_loaded":
      if (!text("hash")) return "";
      return `Version ${shortHash(text("hash") as string)}${people("approved_by") ? `, signed by ${people("approved_by")}` : ""}`;
    case "policy_proposed":
      return text("hash") ? `Version ${shortHash(text("hash") as string)}, needs ${text("quorum") ?? "?"} signatures` : "";
    case "promotion_proposed":
      return `${scope}: ${text("from") ?? "?"} to ${text("level") ?? "?"}`;
    case "promotion_signed":
      return `${scope}: ${text("level") ?? "?"}, signed by ${people("signed_by") ?? "unknown"}`;
    case "promotion_rejected":
      return `Not promoted: ${(text("reason") ?? "no reason given").replace(/_/g, " ")}`;
    case "demoted":
      return `${scope}: ${text("from") ?? "?"} to ${text("to") ?? "?"}`;
    case "incident":
      return `Reported by ${name(text("reported_by")) ?? "someone"}: ${text("note") ?? "no note"}`;
    case "break_glass":
      return `By ${name(text("by")) ?? "someone"}: ${text("reason") ?? "no reason given"}`;
    case "outcome_unknown":
      return `Nobody can say whether it ran: ${text("error") ?? "the gate never said"}`;
    case "edit_proposed":
      return `${name(text("by")) ?? "Someone"} offered ${text("to") ?? "?"} instead of ${text("from") ?? "?"}`;
    case "edit_withdrawn":
      return `Offer of ${text("to") ?? "?"} dropped: ${(text("reason") ?? "no reason given").replace(/_/g, " ")}`;
    case "edited":
      return text("edited_to")
        ? `Edited by ${name(text("by")) ?? "someone"} to ${text("to") ?? "?"}, as ${text("edited_to")}. This call did not run.`
        : `${text("edit_of") ?? "Another request"} edited by ${name(text("by")) ?? "someone"}: ${text("to") ?? "?"} instead of ${text("from") ?? "?"}`;
    default:
      return "";
  }
}

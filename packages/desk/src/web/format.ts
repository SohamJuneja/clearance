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
  switch (type) {
    case "held":
      return [text("agent"), text("class")?.replace(/_/g, " "), text("tier")].filter(Boolean).join(" · ");
    case "routed":
      return `To ${people("chosen") || "nobody yet"}`;
    case "answered": {
      const latency = typeof payload.latency_ms === "number" ? ` in ${formatDuration(payload.latency_ms)}` : "";
      return `${name(text("user_id")) ?? "Someone"}: ${text("decision") ?? "answered"}${latency}`;
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
      return text("hash") ? `Version ${shortHash(text("hash") as string)}` : "";
    case "promotion_proposed":
    case "promotion_signed":
    case "demoted":
      return [text("agent"), text("class"), text("bucket"), text("level") ?? text("to")].filter(Boolean).join(" · ");
    default:
      return "";
  }
}

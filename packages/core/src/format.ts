/** Money and text helpers shared by flags, cards and messages. */

export function formatMoney(amount: number, currency: string): string {
  if (currency === "INR") return `₹${new Intl.NumberFormat("en-IN").format(amount)}`;
  return `${currency} ${new Intl.NumberFormat("en-US").format(amount)}`;
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

/**
 * Characters that change how text reads without being seen: bidi overrides, zero-width and other format characters,
 * controls. `evil.example` can read as something else with one of these in it. A joiner stays only between two non-ASCII
 * characters, where Indic names and emoji need it to spell correctly, since it can't hide anything in an ASCII address.
 */
const HIDDEN = /[\u200C\u200D](?![^\x00-\x7F])|(?<![^\x00-\x7F])[\u200C\u200D]|[^\P{Cf}\u200C\u200D]|\p{Cc}/gu;

function cleanLine(value: unknown): string {
  return String(value ?? "")
    .replace(/\uFEFF/g, "") // A space to `\s`, but it's a zero-width character and should go like the rest.
    .replace(/\s+/g, " ")
    .replace(HIDDEN, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** The same check for text already laid out on a card, where a newline is meant. The last thing every card goes through. */
export function withoutHidden(text: string): string {
  return text.replace(HIDDEN, (char) => (char === "\n" || char === "\t" ? char : ""));
}

/** Agent-controlled text going onto a card: one line, bounded, so it cannot forge other card lines. */
/** Never prints an object: a system of record answering with an unexpected shape shows as "unknown". */
export function oneLine(value: unknown, max = 200): string {
  if (typeof value === "object" && value !== null) return "unknown";
  const text = cleanLine(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * For an address or a domain, whose end is what says where it goes: clipping `ceo@acme.in.aaa….evil.example` from the
 * end would leave only the part that looks fine. An ordinary address fits, and comes back as it went in.
 */
export function oneLineKeepingEnd(value: unknown, max = 200): string {
  if (typeof value === "object" && value !== null) return "unknown";
  const text = cleanLine(value);
  if (text.length <= max) return text;
  const head = Math.min(24, Math.floor(max / 4));
  return `${text.slice(0, head)}…${text.slice(text.length - (max - head - 1))}`;
}

/** Characters of what would be written or sent that a card shows. All of it is in the hash; this is only for a person to read. */
export const PREVIEW_CHARS = 160;

/** Cleaned first, so padding of spaces or zero-width characters can't push the real text out of the part that's shown. */
export function previewOf(text: string): string {
  return cleanLine(text).slice(0, PREVIEW_CHARS);
}

/** Labelled as what it is, with how much it leaves out, since the rest is approved too. */
export function previewLine(what: string, preview: string, chars: number): string {
  const shown = preview.length >= PREVIEW_CHARS && chars > preview.length ? `first ${preview.length} of ${chars} characters` : `all ${chars} characters`;
  return `Preview of ${what} (${shown}): ${preview}`;
}

/** "Sam", "Sam and Neha", "Sam, Neha and Alex". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

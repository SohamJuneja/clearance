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

/** Agent-controlled text going onto a card: one line, bounded, so it cannot forge other card lines. */
/** Never prints an object: a system of record answering with an unexpected shape shows as "unknown". */
export function oneLine(value: unknown, max = 200): string {
  if (typeof value === "object" && value !== null) return "unknown";
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** "Sam", "Sam and Neha", "Sam, Neha and Alex". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

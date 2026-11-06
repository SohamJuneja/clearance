/**
 * One person's open requests across rooms (F7), and how they read as text.
 *
 * A handle is `A<n>` counted per channel, so `A12` in someone's direct room and `A12` in #support are
 * different cards. A list that shows a handle outside its card's room invites `A12 yes` on the wrong
 * card, so the chat text shows a handle only for a card in the room being written to.
 */
import type { Db } from "../db/index.js";
import type { Directory } from "../people/directory.js";
import type { RequestStore } from "../requests/store.js";
import type { RouteRow, RouteStore } from "../router/routes.js";
import type { TraceStore } from "../router/traces.js";

export type InboxItem = {
  request_id: string;
  handle: string | null;
  class: string;
  tier: string;
  /** This card asks for a typed value, and refuses a word answer. */
  typed: boolean;
  what: string;
  room: string | null;
  age_s: number;
  expires_at: string;
  /** The room the card is in: the only room its handle means anything in. */
  card_room: string;
  /** The room's name when the card waits in a shared room rather than this person's direct room. */
  shared_in: string | null;
};

export type InboxSources = {
  db: Db;
  routes: RouteStore;
  requests: RequestStore;
  traces: TraceStore;
  directory: Directory;
  nowMs: number;
};

type EvidenceWithHeadline = { description: { headline: string } };

/** "REFUND ₹40,000" reads "refund ₹40,000" in a list. Only the class word is shouting; values keep their case. */
function inboxWhat(headline: string): string {
  return headline.replace(/^[A-Z]+(?: [A-Z]+)*(?= |$)/, (word) => word.toLowerCase());
}

function inboxAge(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h`;
}

/** Cards waiting in a shared room that this person is one of the people asked to answer. */
function sharedRoutesFor(sources: InboxSources, userId: string): RouteRow[] {
  const rows = sources.db
    .prepare(
      `SELECT r.* FROM routes r JOIN requests q ON q.id = r.request_id
       WHERE r.user_id IS NULL AND r.step IN ('fallback', 'group') AND r.closed_at IS NULL AND q.state IN ('HELD', 'ROUTED')`,
    )
    .all() as RouteRow[];
  return rows.filter((row) => {
    const trace = sources.traces.latest(row.request_id);
    if (!trace) return false;
    const asked = row.step === "fallback" ? (trace.fallback?.eligible ?? []) : trace.ranked.map((entry) => entry.id);
    return asked.includes(userId);
  });
}

/**
 * A drill may have come from no room, and then its line would be the odd one out in a list where every real
 * request names one. It reads as coming from where real requests of its kind come from.
 */
function drillRoom(sources: InboxSources, cls: string): string | null {
  const row = sources.db
    .prepare(`SELECT origin_room FROM requests WHERE class = ? AND is_drill = 0 AND origin_room IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(cls) as { origin_room: string } | undefined;
  return row?.origin_room ?? null;
}

/** Newest request first. A person's own card wins over a shared one for the same request. */
export function listInbox(sources: InboxSources, userId: string): InboxItem[] {
  const { routes, requests, directory, nowMs } = sources;
  const seen = new Set<string>();
  const found: { createdAtMs: number; item: InboxItem }[] = [];
  const add = (row: RouteRow, sharedIn: string | null) => {
    if (seen.has(row.request_id)) return;
    seen.add(row.request_id);
    const request = requests.require(row.request_id);
    const { headline } = (request.evidence as unknown as EvidenceWithHeadline).description;
    const room = request.originRoom ?? (request.isDrill ? drillRoom(sources, request.cls) : null);
    found.push({
      createdAtMs: request.createdAtMs,
      item: {
        request_id: request.id,
        handle: row.handle,
        class: request.cls,
        tier: request.tier,
        typed: row.confirm_field !== null,
        what: inboxWhat(headline),
        room: room ? directory.roomName(room) : null,
        age_s: Math.round((nowMs - request.createdAtMs) / 1000),
        expires_at: new Date(request.expiresAtMs).toISOString(),
        card_room: row.card_room,
        shared_in: sharedIn,
      },
    });
  };
  for (const row of routes.openFor(userId)) add(row, null);
  for (const row of sharedRoutesFor(sources, userId)) add(row, directory.roomName(row.card_room));
  found.sort((a, b) => b.createdAtMs - a.createdAtMs || b.item.request_id.localeCompare(a.item.request_id));
  return found.map((entry) => entry.item);
}

/** Appendix D's flat form, for the API. The handle appears when Switch gave one; the CLR id always does. */
export function inboxText(items: InboxItem[]): string {
  const lines = items.map((item) => {
    const handle = item.handle && !item.shared_in ? `${item.handle} ` : "";
    const room = item.room ? ` · ${item.room}` : "";
    return `${handle}${item.request_id} ${item.what}${room} · ${inboxAge(item.age_s)}`;
  });
  return [`Needs your response (${items.length})`, ...lines].join(" · ");
}

function inboxLine(item: InboxItem, roomId: string): string {
  const here = item.card_room === roomId;
  const handle = here && item.handle ? `${item.handle} ` : "";
  const room = item.room ? ` · ${item.room}` : "";
  const elsewhere = item.shared_in && !here ? ` · card in ${item.shared_in}` : "";
  return `${handle}${item.request_id} ${item.what}${room} · ${inboxAge(item.age_s)}${elsewhere}`;
}

function howToAnswer(items: InboxItem[], roomId: string): string {
  const here = items.filter((item) => item.card_room === roomId);
  const coded = here.filter((item) => item.handle);
  // A critical card asks for a typed value, and so does any card after a missed drill. "yes" is no example for those.
  const example = coded.find((item) => item.tier !== "critical" && !item.typed)?.handle;
  if (example) return `Reply here with a code, like \`${example} yes\` or \`${example} no\`, or use the card's buttons.`;
  if (coded.length > 0) return "Reply here with a code as its card says, or use the card's buttons.";
  if (here.length > 0) return "Use the buttons on the cards above.";
  return items.some((item) => item.shared_in)
    ? "Answer in your direct room with Clearance, or where a line says."
    : "Answer in your direct room with Clearance.";
}

/** One line per open request. `asOf` is for a post that stays up, whose ages stop being true. */
export function inboxMessage(items: InboxItem[], options: { roomId: string; asOf?: string }): string {
  const head = `**Needs your response (${items.length})**`;
  if (items.length === 0) return `${head}\nNothing is waiting on you.`;
  const lines = items.map((item) => inboxLine(item, options.roomId));
  const how = howToAnswer(items, options.roomId);
  return [head, ...lines, options.asOf ? `Ages as of ${options.asOf}. ${how}` : how].join("\n");
}

/** Recognises a post of ours, with or without the mention Switch puts in front of a targeted message. */
export function isInboxMessage(text: string): boolean {
  return /^(?:@\S+\s+)*\*\*Needs your response \(\d+\)\*\*/.test(text);
}

/**
 * `@clearance` commands (6.8). A command is a message that addresses Clearance and starts with the mention, or an
 * addressed message in a direct room. A mention in passing is talk. Who is asking comes from the event's sender,
 * so nothing here reads a name out of the text except a delegate, which core then checks.
 */
import type { Action } from "@clearance/contracts";
import { zonedParts } from "../time.js";

export type Command = {
  verb: string;
  /** Everything after the verb. */
  args: string;
  words: string[];
};

const MENTION = /^@clearance\b[:,]?\s*/i;
const ZERO_WIDTH = /[​‌‍⁠﻿]/g;

export function parseCommand(evt: { body: string; addressed: boolean; channelType?: string | null | undefined }): Command | null {
  if (!evt.addressed) return null;
  const body = evt.body.replace(ZERO_WIDTH, "").trim();
  const mention = MENTION.exec(body);
  if (!mention && evt.channelType !== "direct") return null;
  const rest = mention ? body.slice(mention[0].length) : body;
  const [verb, ...words] = rest.split(/\s+/).filter(Boolean);
  if (!verb) return null;
  return { verb: verb.toLowerCase(), args: words.join(" "), words };
}

/** What Clearance answers to. Anything else after its name is someone saying something. */
const VERBS = new Set(["why", "status", "inbox", "autonomy", "policy", "incident", "away", "back", "breakglass", "counter", "resolve", "drills", "install", "uninstall", "help"]);

/** Whether this message reads as a command to Clearance, whoever it reached, rather than something said with its name in it. */
export function isCommandToClearance(evt: { body: string; channelType?: string | null | undefined }): boolean {
  const command = parseCommand({ ...evt, addressed: true });
  return command !== null && VERBS.has(command.verb);
}

const AWAY = /^until\s+(\d{1,2}):(\d{2})(?:\s+delegate\s+@?(\S+))?$/i;
const DAY_MINUTES = 24 * 60;

/** "until 18:00 delegate @alex": the next time that clock comes round in the team's zone. Null when it can't be read. */
export function parseAway(args: string, nowMs: number, tz: string): { untilMs: number; delegate: string | null } | null {
  const match = AWAY.exec(args.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const ahead = (hours * 60 + minutes - zonedParts(nowMs, tz).minutes + DAY_MINUTES) % DAY_MINUTES || DAY_MINUTES;
  return { untilMs: nowMs + ahead * 60_000, delegate: match[3] ?? null };
}

const ENDPOINT = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)(?:\s+(.*))?$/i;

function valueOf(text: string): string | number | boolean {
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (text === "true" || text === "false") return text === "true";
  return text;
}

/** `key=value` words, or one JSON object. Anything else isn't a set of arguments, and reads as nothing. */
function argumentsOf(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  if (text.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  const out: Record<string, unknown> = {};
  for (const word of text.split(/\s+/)) {
    const at = word.indexOf("=");
    if (at > 0) out[word.slice(0, at)] = valueOf(word.slice(at + 1));
  }
  return out;
}

/**
 * `policy test <text>`: a verb and a path is a gate call, anything else a shell line. Asked as an agent that holds
 * no credentials and on no one's behalf, because this only ever goes to the simulator.
 */
export function describedAction(text: string, agent: string, nowMs: number): Action {
  const base = { id: `policy-test-${nowMs}`, at: new Date(nowMs).toISOString(), agent: { name: agent } };
  const endpoint = ENDPOINT.exec(text.trim());
  if (endpoint) {
    const args = argumentsOf(endpoint[3]);
    return {
      ...base,
      source: "gate",
      vendor: "gate",
      kind: "business",
      raw: args,
      business: { endpoint: `${(endpoint[1] as string).toUpperCase()} ${endpoint[2]}`, args },
    };
  }
  return { ...base, source: "hook", vendor: "claude", kind: "shell", raw: { command: text }, shell: { command: text } };
}

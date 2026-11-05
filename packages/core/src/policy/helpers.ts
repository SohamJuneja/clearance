/** The helpers policy expressions can call. Each answers UNKNOWN rather than guessing. */
import type { Action, Clock, LookupPort } from "@clearance/contracts";
import { toNumber } from "../format.js";
import { isFridayAfter, withinSchedule } from "../time.js";
import { UNKNOWN, type EvalScope } from "./expr.js";
import type { CompiledPolicy } from "./load.js";

export type HelperContext = {
  action: Action;
  args: Record<string, unknown>;
  policy: CompiledPolicy;
  lookup: LookupPort;
  clock: Clock;
  /** Everything systems of record answered during this evaluation, keyed `kind:id`; also the memo. */
  lookups: Record<string, Record<string, unknown>>;
  lookupMisses: Set<string>;
};

export function globToPathRegExp(glob: string): RegExp {
  const body = glob
    .split(/(\*\*|\*|\?)/)
    .map((part) => {
      if (part === "**") return ".*";
      if (part === "*") return "[^/]*";
      if (part === "?") return "[^/]";
      return part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${body}$`);
}

export function makeHelpers(ctx: HelperContext): EvalScope["helpers"] {
  const lookup = async (kind: unknown, id: unknown): Promise<unknown> => {
    if (typeof kind !== "string" || (typeof id !== "string" && typeof id !== "number")) return UNKNOWN;
    const key = `${kind}:${id}`;
    if (ctx.lookups[key]) return ctx.lookups[key];
    if (ctx.lookupMisses.has(key)) return UNKNOWN;
    try {
      const found = await ctx.lookup.lookup(kind, String(id));
      if (found) {
        ctx.lookups[key] = found;
        return found;
      }
    } catch {
      // A systems-of-record outage is missing data, not an error and never a pass.
    }
    ctx.lookupMisses.add(key);
    return UNKNOWN;
  };

  const countRows = async (value: unknown): Promise<unknown> => {
    if (!Array.isArray(value)) return UNKNOWN;
    let total = 0;
    for (const item of value) {
      let rows: number | null = null;
      if (typeof item === "object" && item !== null) {
        rows = toNumber((item as Record<string, unknown>).rows);
      } else if (typeof item === "string") {
        const found = await lookup("files", item);
        if (found !== UNKNOWN) rows = toNumber((found as Record<string, unknown>).rows);
      }
      if (rows === null) return UNKNOWN;
      total += rows;
    }
    return total;
  };

  const touchedFiles = async (): Promise<string[] | null> => {
    if (Array.isArray(ctx.args.files)) return ctx.args.files.map(String);
    if (ctx.args.pr !== undefined) {
      const pull = await lookup("github", ctx.args.pr);
      if (pull !== UNKNOWN) {
        const files = (pull as Record<string, unknown>).files;
        if (Array.isArray(files)) return files.map(String);
      }
      return null;
    }
    if (ctx.action.file) return [ctx.action.file.path];
    return null;
  };

  return {
    lookup,
    domain: (value: unknown) => {
      if (typeof value !== "string") return UNKNOWN;
      const at = value.lastIndexOf("@");
      return at >= 0 && at < value.length - 1 ? value.slice(at + 1).trim().toLowerCase() : UNKNOWN;
    },
    len: (value: unknown) => (Array.isArray(value) ? value.length : UNKNOWN),
    count_rows: countRows,
    touches: async (glob: unknown) => {
      if (typeof glob !== "string") return UNKNOWN;
      const files = await touchedFiles();
      if (!files) return UNKNOWN;
      const re = globToPathRegExp(glob);
      return files.some((file) => re.test(file));
    },
    outside_hours: () => {
      const hours = ctx.policy.defaults.business_hours;
      return !withinSchedule(hours, ctx.clock.nowMs(), hours.tz);
    },
    friday_after: (hhmm: unknown) => {
      if (typeof hhmm !== "string") return UNKNOWN;
      return isFridayAfter(hhmm, ctx.clock.nowMs(), ctx.policy.defaults.business_hours.tz);
    },
  };
}

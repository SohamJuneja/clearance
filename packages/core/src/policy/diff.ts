/** What a policy edit changes, as paths a person can check against the file: `classes.refund.risk.base`. */
import { parseDocument } from "yaml";

const MAX_SHOWN = 12;

/** A patch applied to the file's text, so its comments and layout stay. Throws when a path doesn't fit the file. */
export function patchedPolicyText(text: string, patch: Record<string, unknown>): string {
  const doc = parseDocument(text);
  const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const apply = (path: string[], value: Record<string, unknown>): void => {
    for (const [key, child] of Object.entries(value)) {
      if (plain(child)) apply([...path, key], child);
      else doc.setIn([...path, key], child);
    }
  };
  apply([], patch);
  return doc.toString({ lineWidth: 0 });
}

function changedPaths(before: unknown, after: unknown, path: string, out: string[]): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!plain(before) || !plain(after)) {
    out.push(path);
    return;
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const next = path ? `${path}.${key}` : key;
    if (!(key in after)) out.push(`${next} (removed)`);
    else if (!(key in before)) out.push(`${next} (added)`);
    else changedPaths(before[key], after[key], next, out);
  }
}

export function policyChanges(before: unknown, after: unknown): string[] {
  const out: string[] = [];
  changedPaths(before, after, "", out);
  return out;
}

export function changeSummary(paths: string[]): string {
  if (paths.length === 0) return "comments or formatting only";
  const shown = paths.slice(0, MAX_SHOWN).join(", ");
  return paths.length > MAX_SHOWN ? `${shown}, and ${paths.length - MAX_SHOWN} more` : shown;
}

/**
 * `node:path` for the browser build of Clearance's classifier: the five posix functions it calls, with Node's results.
 * site/playground/shims.test.ts checks each one against Node's own on a few thousand paths.
 */

/** A relative `resolve` starts from here: the process's directory under Node, the root in a browser. */
const cwd = (): string => (typeof process !== "undefined" && typeof process.cwd === "function" ? process.cwd() : "/");

/** Collapses `.`, `..` and repeated slashes. Above the root is the root; above a relative start stays as `..`. */
function collapse(path: string, absolute: boolean): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

function normalize(path: string): string {
  if (path.length === 0) return ".";
  const absolute = path.startsWith("/");
  const trailing = path.endsWith("/");
  const body = collapse(path, absolute);
  if (body.length === 0) return absolute ? "/" : trailing ? "./" : ".";
  return `${absolute ? "/" : ""}${body}${trailing ? "/" : ""}`;
}

function join(...parts: string[]): string {
  const kept = parts.filter((part) => part.length > 0);
  return kept.length === 0 ? "." : normalize(kept.join("/"));
}

function resolve(...parts: string[]): string {
  let joined = "";
  let absolute = false;
  for (let index = parts.length - 1; index >= -1 && !absolute; index -= 1) {
    const part = index >= 0 ? (parts[index] as string) : cwd();
    if (part.length === 0) continue;
    joined = joined ? `${part}/${joined}` : part;
    absolute = part.startsWith("/");
  }
  const body = collapse(joined, absolute);
  return absolute ? `/${body}` : body || ".";
}

function relative(from: string, to: string): string {
  if (from === to) return "";
  const a = resolve(from).split("/").filter(Boolean);
  const b = resolve(to).split("/").filter(Boolean);
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same += 1;
  return [...a.slice(same).map(() => ".."), ...b.slice(same)].join("/");
}

function dirname(path: string): string {
  if (path.length === 0) return ".";
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed.length === 0) return "/";
  const slash = trimmed.lastIndexOf("/");
  if (slash === -1) return ".";
  if (slash === 0) return "/";
  // Node keeps a leading `//` as it is: `//a` lives in `//`.
  if (slash === 1 && trimmed.startsWith("/")) return "//";
  return trimmed.slice(0, slash);
}

const isAbsolute = (path: string): boolean => path.startsWith("/");

export const posix = { normalize, join, resolve, relative, dirname, isAbsolute, sep: "/" };
export default { posix, ...posix };

/**
 * Whether a read leaves the agent's own directory. A guardrail, with an OS fence as the boundary: one run's agent left
 * its clone and read our demo scripts, and a hosted model could otherwise reach the rest of the home directory.
 *
 * Only what can be told from the words: symlinks aren't followed, and `$FILE` isn't known, so it isn't held for this.
 */
import { posix } from "node:path";

const HOME_FORMS = /^(~|\$HOME|\$\{HOME\})(\/|$)/;

function within(path: string, root: string): boolean {
  const base = root.replace(/\/$/, "");
  return path === base || path.startsWith(`${base}/`);
}

/** `readable` is the short list of places normal tools read: /usr, /bin, /etc/hosts. */
export function readsOutside(path: string, cwd: string | undefined, readable: string[]): boolean {
  const text = path.trim();
  if (HOME_FORMS.test(text)) return true;
  if (text.startsWith("$")) return false; // Only known at run time.
  const normal = posix.normalize(text);
  if (normal.startsWith("/")) {
    if (cwd && within(normal, posix.normalize(cwd))) return false;
    return !readable.some((allowed) => within(normal, allowed));
  }
  return normal === ".." || normal.startsWith("../");
}

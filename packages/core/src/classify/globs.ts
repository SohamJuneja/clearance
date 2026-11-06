/**
 * What the shell, or a search tool, does to a word before anything sees it: brace expansion, which is plain text work and
 * can be done here, and file name globs, which can't, because they depend on what's on disk.
 *
 * So a glob is read as the names it could reach that a rule cares about. `cat .en?` is `cat .env` if that file exists, and
 * nothing here can say it doesn't. Only a glob that's aimed counts: `*` and `*.ts` could reach anything, so saying they
 * reach `.env` would deny every `ls *`, and the shell doesn't let them match a leading dot anyway.
 */

/** One piece of a word. `live` is an unquoted character, which the shell gets to interpret. */
export type Atom = { text: string; bound: string; live: boolean; dynamic: boolean };

/** Past this many words from one, it's an attack or a mistake, and nobody could review what it means. */
const MAX_BRACE_WORDS = 64;
const MAX_CANDIDATES = 32;

/**
 * The names the policy's rules are about. A glob that could mean one of these is read as meaning it, so whichever rule
 * covers the name applies. This list holds names and not rules, so it stays small, and a name missing from it only means a
 * glob aimed at that name is judged as the text it is.
 */
const SENSITIVE_NAMES = [
  ".env", ".env.local", ".env.production", ".env.development", "secrets", ".github", ".git", "infra", "migrations",
  ".claude", ".codex", ".opencode", ".cursor", ".clearance", ".ssh", ".aws", ".gnupg", ".netrc", ".config",
  "hook-tokens.json", "gate-tokens.json", "secrets.json", "identities.json", "clearance.policy.yaml",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "key.pem", "key.key", "key.p12", "key.pfx", "key.ppk",
];

const isLive = (atom: Atom | undefined, char: string): boolean => atom !== undefined && atom.live && atom.text === char;

/** A pattern given as a string, as a search tool takes it. A backslash quotes the next character. */
export function atomsOf(pattern: string): Atom[] {
  const atoms: Atom[] = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === "\\" && index + 1 < pattern.length) {
      index += 1;
      atoms.push({ text: pattern[index] as string, bound: `\\${pattern[index]}`, live: false, dynamic: false });
    } else {
      atoms.push({ text: char, bound: char, live: true, dynamic: false });
    }
  }
  return atoms;
}

type Braces = { close: number; commas: number[] };

/** The `}` that closes the `{` at `open`, and its commas at this depth. Null when it has no close. */
function bracesAt(atoms: Atom[], open: number): Braces | null {
  let depth = 0;
  const commas: number[] = [];
  for (let index = open + 1; index < atoms.length; index += 1) {
    const atom = atoms[index];
    if (isLive(atom, "{")) depth += 1;
    else if (isLive(atom, "}")) {
      if (depth === 0) return { close: index, commas };
      depth -= 1;
    } else if (depth === 0 && isLive(atom, ",")) commas.push(index);
  }
  return null;
}

const literalAtoms = (text: string): Atom[] => [...text].map((char) => ({ text: char, bound: char, live: true, dynamic: false }));

/** `{1..3}`, `{a..e}`, `{01..10..2}`. Null when it isn't one, or is so long it's a counter, which stays as it was written. */
function sequence(atoms: Atom[]): Atom[][] | null {
  if (!atoms.every((atom) => atom.live)) return null;
  const match = /^(-?\d+|[a-zA-Z])\.\.(-?\d+|[a-zA-Z])(?:\.\.(-?\d+))?$/.exec(atoms.map((atom) => atom.text).join(""));
  if (!match) return null;
  const [, from = "", to = "", step] = match;
  const numeric = /\d/.test(from) && /\d/.test(to);
  if (!numeric && (/\d/.test(from) || /\d/.test(to))) return null;
  const start = numeric ? Number(from) : from.charCodeAt(0);
  const end = numeric ? Number(to) : to.charCodeAt(0);
  const stride = Math.max(1, Math.abs(Number(step ?? 1)) || 1);
  const count = Math.floor(Math.abs(end - start) / stride) + 1;
  if (count > MAX_BRACE_WORDS) return null;
  const width = numeric && (/^-?0\d/.test(from) || /^-?0\d/.test(to)) ? Math.max(from.length, to.length) : 0;
  const words: Atom[][] = [];
  for (let index = 0; index < count; index += 1) {
    const value = start + (end >= start ? index : -index) * stride;
    words.push(literalAtoms(numeric ? String(value).padStart(width, "0") : String.fromCharCode(value)));
  }
  return words;
}

/** What the shell's brace expansion makes of a word. Null when there's too much of it to read. */
export function expandBraces(atoms: Atom[]): Atom[][] | null {
  for (let open = 0; open < atoms.length; open += 1) {
    if (!isLive(atoms[open], "{")) continue;
    const braces = bracesAt(atoms, open);
    if (!braces) continue;
    const inside = atoms.slice(open + 1, braces.close);
    let alternatives: Atom[][] | null;
    if (braces.commas.length > 0) {
      const cuts = [open, ...braces.commas, braces.close];
      alternatives = cuts.slice(1).map((cut, index) => atoms.slice((cuts[index] as number) + 1, cut));
    } else {
      alternatives = sequence(inside);
    }
    if (!alternatives) continue; // Not an expansion, so this `{` is only a character, and an inner one may still be one.
    const before = atoms.slice(0, open);
    const tails = expandBraces(atoms.slice(braces.close + 1));
    if (!tails) return null;
    const words: Atom[][] = [];
    for (const alternative of alternatives) {
      const middles = expandBraces(alternative);
      if (!middles) return null;
      for (const middle of middles) {
        for (const tail of tails) words.push([...before, ...middle, ...tail]);
        if (words.length > MAX_BRACE_WORDS) return null;
      }
    }
    return words;
  }
  return [atoms];
}

/** An unquoted `*`, `?`, or `[` with a `]` after it. `[` alone is a command, and `[[` is the shell's own. */
export function hasGlob(atoms: Atom[]): boolean {
  return atoms.some((atom, index) => {
    if (isLive(atom, "*") || isLive(atom, "?")) return true;
    if (!isLive(atom, "[")) return false;
    return atoms.slice(index + 1).some((later) => isLive(later, "]"));
  });
}

/** The word as a pattern: quoted text stays quoted, so a quoted `*` can't count as a glob. */
export function patternOf(atoms: Atom[]): string {
  return atoms.map((atom) => (atom.live ? atom.text : atom.text.replace(/[\\*?[\]/]/g, "\\$&"))).join("");
}

const GLOB_CHARS = /(?<!\\)[*?[]/;

/** Aimed at something: it says more than "anything", or it starts with a dot, which the shell only matches when told to. */
function isAimed(segment: string): boolean {
  if (!GLOB_CHARS.test(segment)) return false;
  if (segment.startsWith(".")) return true;
  if (/^\*\.[\w-]+$/.test(segment)) return false; // `*.ts`: a kind of file, not a file.
  return segment.replace(/\\.|\[[^\]]*\]|[*?]/g, "").length >= 2;
}

function segmentMatcher(segment: string): RegExp | null {
  let source = "";
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index] as string;
    if (char === "\\") {
      index += 1;
      source += (segment[index] ?? "").replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
    } else if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else if (char === "[") {
      const close = segment.indexOf("]", index + 2);
      if (close === -1) source += "\\[";
      else {
        const inner = segment.slice(index + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\");
        source += `[${inner}]`;
        index = close;
      }
    } else source += char.replace(/[.+^${}()|\\/-]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return null;
  }
}

/** The names this one part of a path could be. With `dot` false it follows the shell: only a written dot matches a leading dot. */
function namesFor(segment: string, dot: boolean): string[] {
  if (!isAimed(segment)) return [];
  const matcher = segmentMatcher(segment);
  if (!matcher) return [];
  return SENSITIVE_NAMES.filter((name) => matcher.test(name) && (dot || !name.startsWith(".") || segment.startsWith(".")));
}

const unquoted = (segment: string): string => segment.replace(/\\(.)/g, "$1");

/**
 * The paths a pattern could reach, that a rule might care about. Empty when it isn't aimed at anything. A part with nothing
 * aimed in it stays as written, so `.github/*` is still `.github/*`, and `**` keeps reading as what it is.
 */
export function sensitivePaths(pattern: string, { dot }: { dot: boolean }): string[] {
  const parts = pattern.split(/(?<!\\)\//);
  const choices = parts.map((part) => namesFor(part, dot));
  if (choices.every((names) => names.length === 0)) return [];
  let paths: string[] = [""];
  parts.forEach((part, index) => {
    const names = (choices[index] as string[]).length > 0 ? (choices[index] as string[]) : [unquoted(part)];
    paths = paths.flatMap((path) => names.map((name) => (index === 0 ? name : `${path}/${name}`))).slice(0, MAX_CANDIDATES);
  });
  return paths;
}

/** For a search tool, whose globs are its own: braces too, and its wildcards match a leading dot. */
export function pathsASearchReaches(pattern: string): string[] {
  if (!/[*?[{]/.test(pattern)) return [];
  const expanded = (expandBraces(atomsOf(pattern)) ?? [atomsOf(pattern)]).map(patternOf);
  // `{.env,x}` names `.env` outright, with no wildcard left in it to aim.
  const spelledOut = expanded.length > 1 ? expanded.filter((one) => !GLOB_CHARS.test(one)).map(unquoted) : [];
  return [...new Set([...spelledOut, ...expanded.flatMap((one) => sensitivePaths(one, { dot: true }))])];
}

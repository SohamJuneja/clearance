/**
 * A small deterministic shell reader. Real agents write `git -C <dir> push`, compound lines, subshells,
 * `bash -c "..."`, `env X=1 cmd`, `sudo`. Classifying the raw string would miss those and would also match text
 * that only mentions a command, so this splits a line into the commands it would really run and takes the
 * wrappers off. It does not evaluate anything.
 *
 * What it cannot read with confidence comes back `ok: false`, and the policy engine holds that. Being unsure is
 * never a reason to allow.
 */

export type SubCommand = {
  /** As written, for a reader. */
  raw: string;
  /** Wrappers and git's global options off, quotes removed: what classification patterns read. */
  effective: string;
  /** Every word that changes what runs, one space apart, redirects off: what a grant binds to. */
  canonical: string;
  /** Paths this command writes to, through redirects, tee, sed -i, cp, mv or dd. */
  writes: string[];
  /** Paths it reads through a `<` redirect. */
  reads: string[];
  /** Words whose value only the shell knows: `$BRANCH`, `$(...)`. */
  dynamic: string[];
};

export type ParsedShell = { ok: boolean; reason?: string; commands: SubCommand[] };

type Word = { text: string; dynamic: boolean; procSub: boolean };

type Builder = {
  start: number;
  words: Word[];
  writes: Word[];
  reads: Word[];
  pipedIn: boolean;
  /** Fed by a heredoc, here-string or `<`: if it is an interpreter, its commands are not on this line. */
  fed: boolean;
  grouped: boolean;
};

const MAX_DEPTH = 4;
/** Subshells and substitutions, one inside another. Past this it is an attack or a bug, not a command. */
const MAX_NESTING = 64;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);
const INTERPRETERS = /^(python[\d.]*|node|perl|ruby|php|deno|bun)$/;
const INLINE_CODE_FLAGS = new Set(["-c", "-e", "-m", "-p", "-E", "--eval", "--print", "-r"]);
const NOT_REAL_FILES = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;
const LEADING_KEYWORDS = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "{"]);
const CLOSING_KEYWORDS = new Set(["fi", "done", "}", "esac"]);

function baseName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

function isAssignment(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(text);
}

/** Flags that consume the next word, for commands that merely run another command. */
const WRAPPERS: Record<string, { flagsWithValue: Set<string>; positionals?: number; assignments?: boolean }> = {
  sudo: { flagsWithValue: new Set(["-u", "-g", "-h", "-p", "-C", "-r", "-t", "-T", "-U", "-D"]) },
  env: { flagsWithValue: new Set(["-u", "-C", "--unset", "--chdir"]), assignments: true },
  nice: { flagsWithValue: new Set(["-n", "--adjustment"]) },
  ionice: { flagsWithValue: new Set(["-c", "-n", "-p"]) },
  timeout: { flagsWithValue: new Set(["-k", "-s", "--kill-after", "--signal"]), positionals: 1 },
  stdbuf: { flagsWithValue: new Set(["-i", "-o", "-e"]) },
  xargs: { flagsWithValue: new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "-J", "-R", "-S"]) },
  exec: { flagsWithValue: new Set(["-a"]) },
  nohup: { flagsWithValue: new Set() },
  time: { flagsWithValue: new Set() },
  command: { flagsWithValue: new Set() },
  builtin: { flagsWithValue: new Set() },
  setsid: { flagsWithValue: new Set() },
};

const GIT_GLOBALS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);

class ShellParser {
  pos = 0;
  failure: string | null = null;
  readonly commands: SubCommand[] = [];
  private nesting = 0;

  constructor(
    private readonly src: string,
    private readonly depth: number,
  ) {}

  private fail(reason: string): void {
    this.failure ??= reason;
    this.pos = this.src.length;
  }

  private builder(pipedIn = false): Builder {
    return { start: this.pos, words: [], writes: [], reads: [], pipedIn, fed: false, grouped: false };
  }

  /** Reads commands until the terminator, or the end of input when there is none. */
  parseList(terminator: ")" | null): void {
    if (this.nesting >= MAX_NESTING) return this.fail("commands nested too deeply");
    this.nesting += 1;
    try {
      this.readList(terminator);
    } finally {
      this.nesting -= 1;
    }
  }

  private readList(terminator: ")" | null): void {
    let current = this.builder();
    const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
    const end = (pipedIn = false) => {
      this.finish(current);
      current = this.builder(pipedIn);
    };

    while (this.pos < this.src.length && !this.failure) {
      const c = this.src[this.pos] as string;
      if (c !== "\n" && /\s/.test(c)) {
        this.pos += 1;
      } else if (c === "\n") {
        this.pos += 1;
        end();
        this.skipHeredocs(heredocs);
      } else if (c === "#") {
        while (this.pos < this.src.length && this.src[this.pos] !== "\n") this.pos += 1;
      } else if (c === ";") {
        if (this.src[this.pos + 1] === ";") return this.fail("a case statement");
        this.pos += 1;
        end();
      } else if (c === "|") {
        const next = this.src[this.pos + 1];
        this.pos += next === "|" || next === "&" ? 2 : 1;
        end(next !== "|");
      } else if (c === "&" && this.src[this.pos + 1] === "&") {
        this.pos += 2;
        end();
      } else if (c === "&" && this.src[this.pos + 1] === ">") {
        this.readRedirect(current, heredocs);
      } else if (c === "&") {
        this.pos += 1;
        end();
      } else if (c === ")") {
        if (terminator !== ")") return this.fail("a closing parenthesis with nothing to close");
        this.pos += 1;
        end();
        return;
      } else if (c === "(") {
        if (current.words.length > 0) return this.fail("a function definition");
        this.pos += 1;
        this.parseList(")");
        current.grouped = true;
      } else if (c === "<" && this.src[this.pos + 1] === "(") {
        current.words.push(this.readProcessSubstitution());
      } else if (c === ">" && this.src[this.pos + 1] === "(") {
        current.words.push(this.readProcessSubstitution());
      } else if (c === "<" || c === ">" || /^\d+[<>]/.test(this.src.slice(this.pos, this.pos + 12))) {
        this.readRedirect(current, heredocs);
      } else {
        const word = this.readWord();
        if (word) current.words.push(word);
      }
    }
    if (this.failure) return;
    this.finish(current);
    if (terminator) this.fail("an unbalanced parenthesis");
  }

  private skipHeredocs(heredocs: { delimiter: string; stripTabs: boolean }[]): void {
    for (const { delimiter, stripTabs } of heredocs.splice(0)) {
      while (this.pos < this.src.length) {
        const lineEnd = this.src.indexOf("\n", this.pos);
        const stop = lineEnd === -1 ? this.src.length : lineEnd;
        const line = this.src.slice(this.pos, stop);
        this.pos = lineEnd === -1 ? this.src.length : lineEnd + 1;
        if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
      }
    }
  }

  private readRedirect(current: Builder, heredocs: { delimiter: string; stripTabs: boolean }[]): void {
    while (/\d/.test(this.src[this.pos] ?? "")) this.pos += 1;
    const operators = ["&>>", "&>", "<<<", "<<-", "<<", "<&", "<>", ">>", ">&", ">|", "<", ">"];
    const op = operators.find((candidate) => this.src.startsWith(candidate, this.pos));
    if (!op) return this.fail("an unreadable redirect");
    this.pos += op.length;
    while (this.src[this.pos] !== "\n" && /\s/.test(this.src[this.pos] ?? "")) this.pos += 1;
    const target = this.readWord();
    if (!target) return this.fail("a redirect with no target");
    if (op === "<<" || op === "<<-") {
      current.fed = true;
      heredocs.push({ delimiter: target.text, stripTabs: op === "<<-" });
    } else if (op === "<<<") {
      current.fed = true;
    } else if (op === "<") {
      current.fed = true;
      current.reads.push(target);
    } else if (op === ">&" || op === "<&") {
      if (op === ">&" && !/^(\d+|-)$/.test(target.text)) current.writes.push(target);
    } else {
      current.writes.push(target);
    }
  }

  private readProcessSubstitution(): Word {
    const opener = this.src[this.pos] as string;
    this.pos += 2;
    this.parseList(")");
    return { text: `${opener}(…)`, dynamic: true, procSub: true };
  }

  /** One shell word, with quotes and escapes resolved. Null when there is no word here. */
  private readWord(): Word | null {
    let text = "";
    let dynamic = false;
    let any = false;
    while (this.pos < this.src.length && !this.failure) {
      const c = this.src[this.pos] as string;
      if (/[\s;&|()<>]/.test(c)) break;
      if (c === "\\" && this.src[this.pos + 1] === "\n") {
        // A line continuation disappears, and is not a word by itself.
        this.pos += 2;
        continue;
      }
      any = true;
      if (c === "'") {
        const close = this.src.indexOf("'", this.pos + 1);
        if (close === -1) {
          this.fail("an unbalanced single quote");
          break;
        }
        text += this.src.slice(this.pos + 1, close);
        this.pos = close + 1;
      } else if (c === '"') {
        const inner = this.readDoubleQuoted();
        text += inner.text;
        dynamic ||= inner.dynamic;
      } else if (c === "\\") {
        const next = this.src[this.pos + 1];
        if (next === undefined) {
          this.fail("a trailing backslash");
          break;
        }
        text += next;
        this.pos += 2;
      } else if (c === "`") {
        text += this.readBacktick();
        dynamic = true;
      } else if (c === "$") {
        const expansion = this.readDollar();
        text += expansion.text;
        dynamic ||= expansion.dynamic;
      } else {
        text += c;
        this.pos += 1;
      }
    }
    return any ? { text, dynamic, procSub: false } : null;
  }

  private readDoubleQuoted(): { text: string; dynamic: boolean } {
    this.pos += 1;
    let text = "";
    let dynamic = false;
    while (this.pos < this.src.length && !this.failure) {
      const c = this.src[this.pos] as string;
      if (c === '"') {
        this.pos += 1;
        return { text, dynamic };
      }
      if (c === "\\") {
        const next = this.src[this.pos + 1];
        if (next === undefined) break;
        if (next === "\n") {
          // A line continuation disappears.
        } else if ('$`"\\'.includes(next)) {
          text += next;
        } else {
          text += `\\${next}`;
        }
        this.pos += 2;
      } else if (c === "`") {
        text += this.readBacktick();
        dynamic = true;
      } else if (c === "$") {
        const expansion = this.readDollar();
        text += expansion.text;
        dynamic ||= expansion.dynamic;
      } else {
        text += c;
        this.pos += 1;
      }
    }
    this.fail("an unbalanced double quote");
    return { text, dynamic };
  }

  private readBacktick(): string {
    let inner = "";
    let cursor = this.pos + 1;
    while (cursor < this.src.length && this.src[cursor] !== "`") {
      if (this.src[cursor] === "\\" && cursor + 1 < this.src.length) cursor += 1;
      inner += this.src[cursor];
      cursor += 1;
    }
    if (cursor >= this.src.length) {
      this.fail("an unbalanced backtick");
      return "";
    }
    this.pos = cursor + 1;
    this.absorb(inner);
    return "`…`";
  }

  private readDollar(): { text: string; dynamic: boolean } {
    const next = this.src[this.pos + 1];
    if (next === "(" && this.src[this.pos + 2] === "(") {
      const close = this.src.indexOf("))", this.pos + 3);
      if (close === -1) {
        this.fail("unbalanced arithmetic");
        return { text: "", dynamic: true };
      }
      this.pos = close + 2;
      return { text: "$((…))", dynamic: true };
    }
    if (next === "(") {
      this.pos += 2;
      this.parseList(")");
      return { text: "$(…)", dynamic: true };
    }
    if (next === "{") {
      const close = this.src.indexOf("}", this.pos + 2);
      if (close === -1) {
        this.fail("an unbalanced ${");
        return { text: "", dynamic: true };
      }
      const text = this.src.slice(this.pos, close + 1);
      this.pos = close + 1;
      return { text, dynamic: true };
    }
    const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9?!#@*$-])/.exec(this.src.slice(this.pos + 1, this.pos + 64));
    if (name) {
      this.pos += 1 + name[0].length;
      return { text: `$${name[0]}`, dynamic: true };
    }
    this.pos += 1;
    return { text: "$", dynamic: false };
  }

  /** Commands inside a string the shell will run: backticks and `bash -c`. */
  private absorb(script: string): void {
    if (this.depth >= MAX_DEPTH) return this.fail("commands nested too deeply");
    const inner = new ShellParser(script, this.depth + 1);
    inner.parseList(null);
    this.commands.push(...inner.commands);
    if (inner.failure) this.fail(inner.failure);
  }

  private finish(builder: Builder): void {
    if (this.failure) return;
    const raw = this.src.slice(builder.start, this.pos).trim();
    const writes = this.resolvePaths(builder.writes);
    const reads = this.resolvePaths(builder.reads);
    if (writes === null || reads === null) return;
    if (builder.words.length === 0) {
      if (writes.length > 0 || reads.length > 0) {
        this.commands.push({ raw, effective: "", canonical: "", writes, reads, dynamic: [] });
      }
      return;
    }

    // Leading keywords and `{` carry no meaning of their own: what follows them is the command.
    let words = builder.words;
    while (words[0] && LEADING_KEYWORDS.has(words[0].text)) words = words.slice(1);
    if (words.length === 0 || (words.length === 1 && CLOSING_KEYWORDS.has((words[0] as Word).text))) {
      if (writes.length > 0 || reads.length > 0) {
        this.commands.push({ raw, effective: "", canonical: "", writes, reads, dynamic: [] });
      }
      return;
    }
    const first = (words[0] as Word).text;
    if (first === "for") return; // The body comes as its own commands, after `do`.
    if (first === "case" || first === "select" || first === "function") return this.fail(`a ${first} statement`);

    this.finishCommand(words, builder, raw, writes, reads);
  }

  private resolvePaths(words: Word[]): string[] | null {
    const paths: string[] = [];
    for (const word of words) {
      if (word.dynamic) {
        this.fail(`a path only known at run time: ${word.text}`);
        return null;
      }
      if (!NOT_REAL_FILES.test(word.text)) paths.push(word.text);
    }
    return paths;
  }

  private finishCommand(all: Word[], builder: Builder, raw: string, writes: string[], reads: string[]): void {
    const kept: string[] = []; // Wrappers and assignments: they change what runs, so a grant binds to them.
    let rest = all;
    for (;;) {
      const word = rest[0];
      if (!word) {
        // Assignments and wrappers with nothing to run. A redirect on one still writes.
        if (writes.length > 0 || reads.length > 0) {
          this.commands.push({ raw, effective: "", canonical: "", writes, reads, dynamic: [] });
        }
        return;
      }
      if (isAssignment(word.text)) {
        kept.push(word.text);
        rest = rest.slice(1);
        continue;
      }
      const wrapper = word.dynamic ? undefined : WRAPPERS[baseName(word.text)];
      if (!wrapper) break;
      kept.push(word.text);
      rest = rest.slice(1);
      let positionals = wrapper.positionals ?? 0;
      while (rest[0]) {
        const next = rest[0];
        if (next.text === "--") {
          kept.push(next.text);
          rest = rest.slice(1);
          break;
        }
        if (baseName(word.text) === "env" && next.text === "-S") return this.fail("env -S");
        if (next.text.startsWith("-") && next.text.length > 1) {
          const takesValue = wrapper.flagsWithValue.has(next.text);
          kept.push(next.text);
          rest = rest.slice(1);
          if (takesValue && rest[0]) {
            kept.push(rest[0].text);
            rest = rest.slice(1);
          }
          continue;
        }
        if (wrapper.assignments && isAssignment(next.text)) {
          kept.push(next.text);
          rest = rest.slice(1);
          continue;
        }
        if (positionals > 0) {
          positionals -= 1;
          kept.push(next.text);
          rest = rest.slice(1);
          continue;
        }
        break;
      }
    }

    const command = rest[0] as Word;
    if (command.dynamic) return this.fail(`a command only known at run time: ${command.text}`);
    const name = baseName(command.text);
    if (name === "eval") return this.fail("eval");
    if (name === "source" || name === ".") return this.fail(`${name}: the script's commands are not on this line`);
    if (SHELLS.has(name)) {
      const inner = this.readShellInvocation(rest);
      if (inner === "absorbed") return;
      if (inner === "failed") return;
    } else if (INTERPRETERS.test(name) && !hasScript(rest) && (builder.pipedIn || builder.fed)) {
      return this.fail(`${name} reads its program from input`);
    }

    const writtenBy = writesOf(rest);
    if (writtenBy === null) return this.fail("a path only known at run time");
    const effective = (name === "git" ? stripGitGlobals(rest) : rest).map((word) => word.text).join(" ");
    const canonical = [...kept, ...rest.map((word) => word.text)].join(" ");
    this.commands.push({
      raw,
      effective,
      canonical,
      writes: [...writes, ...writtenBy],
      reads,
      dynamic: all.filter((word) => word.dynamic).map((word) => word.text),
    });
  }

  /** `bash -c "..."` is the commands in the string. A shell with no script on this line reads them from elsewhere. */
  private readShellInvocation(words: Word[]): "absorbed" | "failed" | "script" {
    const name = baseName((words[0] as Word).text);
    let index = 1;
    let inline = false;
    while (words[index] && (words[index] as Word).text.startsWith("-") && (words[index] as Word).text.length > 1) {
      const flag = (words[index] as Word).text;
      if (flag === "--") {
        index += 1;
        break;
      }
      if (!flag.startsWith("--") && flag.includes("c")) inline = true;
      if (flag === "-O" || flag === "+O" || flag === "-o") index += 1;
      index += 1;
    }
    const next = words[index];
    if (inline) {
      if (!next) {
        this.fail(`${name} -c with no script`);
        return "failed";
      }
      if (next.dynamic) {
        this.fail(`${name} -c with a script only known at run time`);
        return "failed";
      }
      this.absorb(next.text);
      return this.failure ? "failed" : "absorbed";
    }
    if (!next || next.text === "-") {
      this.fail(`${name} reads its commands from input`);
      return "failed";
    }
    if (next.procSub || next.dynamic) {
      this.fail(`${name} runs a script only known at run time`);
      return "failed";
    }
    return "script";
  }
}

function hasScript(words: Word[]): boolean {
  for (const word of words.slice(1)) {
    if (INLINE_CODE_FLAGS.has(word.text)) return true;
    if (word.text === "-") return false;
    if (!word.text.startsWith("-")) return true;
  }
  return false;
}

function stripGitGlobals(words: Word[]): Word[] {
  const out: Word[] = [words[0] as Word];
  let index = 1;
  while (words[index]) {
    const word = words[index] as Word;
    if (!word.text.startsWith("-")) break;
    index += GIT_GLOBALS_WITH_VALUE.has(word.text) ? 2 : 1;
  }
  return [...out, ...words.slice(index)];
}

/** Files a command writes by its arguments. Null when one of those is only known at run time. */
function writesOf(words: Word[]): string[] | null {
  const name = baseName((words[0] as Word).text);
  const args = words.slice(1);
  let targets: Word[] = [];
  if (name === "tee") {
    targets = args.filter((word) => !word.text.startsWith("-"));
  } else if (name === "cp" || name === "mv") {
    const paths = args.filter((word) => !word.text.startsWith("-"));
    const last = paths[paths.length - 1];
    if (last && paths.length >= 2) targets = [last];
  } else if (name === "dd") {
    targets = args
      .filter((word) => word.text.startsWith("of="))
      .map((word) => ({ ...word, text: word.text.slice("of=".length) }));
  } else if (name === "sed") {
    targets = sedTargets(args);
  }
  const paths: string[] = [];
  for (const target of targets) {
    if (target.dynamic) return null;
    if (!NOT_REAL_FILES.test(target.text)) paths.push(target.text);
  }
  return paths;
}

function sedTargets(args: Word[]): Word[] {
  let inPlace = false;
  let scriptGiven = false;
  const positional: Word[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const text = (args[index] as Word).text;
    if (text === "-e" || text === "--expression" || text === "-f" || text === "--file") {
      scriptGiven = true;
      index += 1;
    } else if (text.startsWith("-i") || text.startsWith("--in-place")) {
      inPlace = true;
    } else if (text.startsWith("-")) {
      continue;
    } else {
      positional.push(args[index] as Word);
    }
  }
  if (!inPlace) return [];
  return scriptGiven ? positional : positional.slice(1);
}

export function parseShell(source: string): ParsedShell {
  const parser = new ShellParser(source, 0);
  parser.parseList(null);
  return parser.failure
    ? { ok: false, reason: parser.failure, commands: parser.commands }
    : { ok: true, commands: parser.commands };
}

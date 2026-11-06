/**
 * A small deterministic shell reader. Real agents write `git -C <dir> push`, compound lines, subshells,
 * `bash -c "..."`, `env X=1 cmd`, `sudo`. Classifying the raw string would miss those and would also match text
 * that only mentions a command, so this splits a line into the commands it would really run and takes the
 * wrappers off. It does not evaluate anything.
 *
 * What it cannot read with confidence comes back `ok: false`, and the policy engine holds that. Being unsure is
 * never a reason to allow.
 */
import { posix } from "node:path";
import { inlineCodeProblem } from "./inline-code.js";

export type SubCommand = {
  /** As written, for a reader. */
  raw: string;
  /** Wrappers and git's global options off, quotes removed: what classification patterns read. */
  effective: string;
  /** Every word that changes what runs, one space apart, redirects off: what a grant binds to. */
  canonical: string;
  /** Paths this command writes to, through redirects, tee, sed -i, cp, mv or dd. */
  writes: string[];
  /** Paths it reads through a `<` redirect, and, for commands known to read their arguments, those that leave the tree. */
  reads: string[];
  /** Words whose value only the shell knows: `$BRANCH`, `$(...)`. */
  dynamic: string[];
  /** `effective` as words, so an argument with a space in it stays one argument. */
  words: string[];
  /** What came before the command: wrappers and assignments. An environment can change where a command goes. */
  wrappers: string[];
  /** The words as a grant binds them. Set only when `canonical` can't tell this command from another: see `Word.bound`. */
  boundWords?: string[];
  /** Earlier commands on this line that aren't known to leave things as they were: `cd`, `export`, `read`, `git remote`. */
  setup: string[][];
  /**
   * Where this runs, by the `cd`s before it on the line: "" for where the line starts. Relative to that, unless it's
   * absolute or starts with `~`. Null when only the shell knows, as after `cd "$X"`.
   */
  directory: string | null;
  /** It may run more than once: in a loop, or for each thing `find` or `xargs` reads. */
  repeats: boolean;
  /** What it does depends on more of the line than its words: a loop, a pipe, a heredoc, `bash -c '...' args`. */
  boundToLine: boolean;
};

export type ParsedShell = { ok: boolean; reason?: string; commands: SubCommand[] };

type Word = {
  /** With quotes and escapes resolved, and a substitution shortened: what patterns read and a person sees. */
  text: string;
  /**
   * What the shell would really do with it. Quoted text is marked as literal and a substitution keeps its source, so
   * `'$X'` and `$X`, `'*'` and `*`, or `$(echo a)` and `$(echo b)` stay different, while `"origin"` and `origin`,
   * which run the same, stay the same.
   */
  bound: string;
  dynamic: boolean;
  procSub: boolean;
  /** No quote or escape in it, so a keyword really is one: `"done"` is a command called done. */
  plain: boolean;
};

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
const LOOP_OPENERS = new Set(["while", "until"]);
/** What `time` can time besides a command, since it's the shell's own keyword: a loop, for one. */
const TIME_TAKES = new Set(["for", "while", "until", "if", "select", "case", "function", "{", "!"]);
/**
 * Commands known to leave things as they were, so a later command on the line does what it would have done alone. Anything
 * else might not, and there are too many ways to set a variable to list them all (`read`, `printf -v`, `mapfile`), so a
 * grant binds to it. This list stays short on purpose: a command missing from it only costs a new card if the agent rewords.
 */
const KNOWN_HARMLESS = new Set([
  "echo", "printf", "true", "false", ":", "test", "[", "[[", "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "cut", "tr", "nl",
  "pwd", "whoami", "id", "uname", "which", "type", "sleep", "seq", "basename", "dirname", "realpath", "readlink", "stat", "file", "du",
  "df", "cmp",
]);
const GIT_ONLY_READS = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "ls-remote", "describe", "blame", "shortlog", "cat-file"]);
/** A wrapper's own way of changing directory, for the one command it runs. */
const CHANGES_DIRECTORY: Record<string, { flags: Set<string>; attached?: string }> = {
  env: { flags: new Set(["-C", "--chdir"]), attached: "--chdir=" },
  sudo: { flags: new Set(["-D", "--chdir"]), attached: "--chdir=" },
  unshare: { flags: new Set(["-w", "--wd"]), attached: "--wd=" },
};

/** Marks text the shell won't interpret. Everything that means something when bare, so `'*'` can't pass for `*`. */
function literal(text: string): string {
  return text.replace(/[\\$`"'*?[\]{}~!,#=]/g, "\\$&");
}

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
  xargs: {
    flagsWithValue: new Set([
      "-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "-J", "-R", "-S",
      "--max-args", "--max-procs", "--max-lines", "--max-chars", "--delimiter", "--arg-file", "--eof", "--replace",
    ]),
  },
  exec: { flagsWithValue: new Set(["-a"]) },
  nohup: { flagsWithValue: new Set() },
  time: { flagsWithValue: new Set() },
  command: { flagsWithValue: new Set() },
  builtin: { flagsWithValue: new Set() },
  setsid: { flagsWithValue: new Set() },
  doas: { flagsWithValue: new Set(["-u", "-C"]) },
  pkexec: { flagsWithValue: new Set(["--user"]) },
  runuser: { flagsWithValue: new Set(["-u", "-g", "-G", "--user", "--group", "--supp-group"]) },
  busybox: { flagsWithValue: new Set() },
  toybox: { flagsWithValue: new Set() },
  flock: { flagsWithValue: new Set(["-w", "-E", "--timeout", "--wait", "--conflict-exit-code"]), positionals: 1 },
  taskset: { flagsWithValue: new Set(), positionals: 1 },
  unshare: { flagsWithValue: new Set(["-R", "-w", "-S", "-G", "--root", "--wd", "--setuid", "--setgid"]) },
  chroot: { flagsWithValue: new Set(["--userspec", "--groups"]), positionals: 1 },
  chrt: { flagsWithValue: new Set(["-T", "-P", "-D"]), positionals: 1 },
  nsenter: { flagsWithValue: new Set(["-t", "-S", "-G", "--target", "--setuid", "--setgid"]) },
  setpriv: { flagsWithValue: new Set() },
  strace: { flagsWithValue: new Set(["-o", "-e", "-p", "-s", "-u", "-a", "-I", "-b", "-E", "-O", "-P", "-S", "-X"]) },
  ltrace: { flagsWithValue: new Set(["-o", "-e", "-p", "-s", "-u", "-a", "-n", "-x", "-D", "-F", "-l", "-A"]) },
  fakeroot: { flagsWithValue: new Set(["-l", "-s", "-i", "-b", "--lib", "--faked"]) },
  prlimit: { flagsWithValue: new Set() },
  cpulimit: { flagsWithValue: new Set(["-l", "-p", "-e", "--limit", "--pid", "--exe"]) },
  numactl: { flagsWithValue: new Set(["-C", "-N", "-m", "-p", "-i", "--cpunodebind", "--membind", "--preferred", "--interleave", "--physcpubind"]) },
  unbuffer: { flagsWithValue: new Set() },
  rlwrap: { flagsWithValue: new Set() },
  "systemd-run": { flagsWithValue: new Set(["-u", "-p", "-M", "-H", "--unit", "--property", "--machine", "--host"]) },
};

/** Commands that run a string as a shell line, named by `-c` or `--command`. Without one, these read their commands from input. */
const RUNS_A_STRING = new Set(["script", "su", "sg"]);
/** These can be given a string the same way, and otherwise just wrap a command. */
const MAY_RUN_A_STRING = new Set(["flock", "runuser"]);
/** These run commands this reader has no way to see: they arrive on stdin or in a job file, or they're a shell's own forms. */
const RUNS_WHAT_IT_READS = new Set(["parallel", "at", "batch", "coproc", "repeat"]);

const GIT_GLOBALS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);

/**
 * Git settings that can't run anything. Many others can: `alias.x=!cmd`, `core.sshCommand`, `core.fsmonitor`, `core.pager`,
 * `diff.external`, `credential.helper`. So a setting on the command line has to be one of these, or the line isn't
 * what it looks like, and the only thing to do with that is hold it.
 */
const GIT_HARMLESS_SETTINGS = /^(color\.[\w.-]+|advice\.[\w.-]+|user\.(name|email)|core\.(quotepath|abbrev)|init\.defaultbranch|safe\.directory)$/i;
const GIT_RISKY_ENVIRONMENT = /^GIT_(CONFIG_(COUNT|PARAMETERS|GLOBAL|SYSTEM|KEY_\d+|VALUE_\d+)|SSH|SSH_COMMAND|PAGER|EDITOR|SEQUENCE_EDITOR|EXTERNAL_DIFF|ASKPASS|EXEC_PATH|PROXY_COMMAND)\+?=/;

/** What `find` runs for each thing it finds. Each one is a command of its own, up to its `;` or `+`. */
const FIND_RUNS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
/** Given a target only known at run time, these are a delete or an overwrite of who knows what. */
const DESTROYS_ITS_TARGET = new Set(["rm", "rmdir", "unlink", "shred", "truncate", "mv", "dd"]);
/** A path that climbs, so `./../x` and `src/../../x` read as what they are. Not a flag's value or a URL: those aren't paths here. */
const CLIMBS = /(^|\/)\.\.(\/|$)/;

/** Commands that read the files they're given. Others might too, but a word like `/x` is only a path if something reads it. */
const READS_ITS_ARGUMENTS = new Set([
  "cat", "tac", "head", "tail", "less", "more", "nl", "wc", "stat", "file", "ls", "tree", "du", "sort", "uniq", "cut", "diff",
  "cmp", "strings", "xxd", "hexdump", "od", "base64", "md5sum", "sha1sum", "sha256sum", "sha512sum", "tar", "zip", "unzip",
  "cp", "rsync", "cd", "pushd", "realpath", "readlink",
]);
/** The first argument is a pattern, which is free to look like a path: `grep "/api/" src`. */
const READS_AFTER_A_PATTERN = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "sed", "awk", "gawk", "jq", "yq"]);
const NAMES_ITS_PATTERN = new Set(["-e", "--regexp", "-f", "--file", "--expression"]);
const LEAVES_THE_TREE = /^(\/|~|\$HOME\b|\$\{HOME\})|(^|\/)\.\.(\/|$)/;

/** A command run by `find` or `xargs`: its arguments come from what those read, and so might the command itself. */
type Carried = { by: "find" | "xargs"; placeholder: string; prefix: Word[] };

/** Shared by every parser reading one line, however nested: what has run so far that the rest depends on. */
type LineState = { setup: string[][]; assigned: string[]; directory: string | null };

class ShellParser {
  pos = 0;
  failure: string | null = null;
  readonly commands: SubCommand[] = [];
  private nesting = 0;

  constructor(
    private readonly src: string,
    private readonly depth: number,
    private readonly line: LineState = { setup: [], assigned: [], directory: "" },
    /** By value into an inner script, so a stray `done` in a string can't close the loop around it. */
    private loops = 0,
    private readonly wholeLine = false,
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
    // A list in parentheses is a subshell, so a `cd` in it stops at the closing one.
    const { directory } = this.line;
    try {
      this.readList(terminator);
    } finally {
      this.nesting -= 1;
      if (terminator) this.line.directory = directory;
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
    const start = this.pos;
    const opener = this.src[this.pos] as string;
    this.pos += 2;
    this.parseList(")");
    const bound = this.src.slice(start, this.pos);
    return { text: `${opener}(…)`, bound, dynamic: true, procSub: true, plain: false };
  }

  /** One shell word, with quotes and escapes resolved. Null when there is no word here. */
  private readWord(): Word | null {
    let text = "";
    let bound = "";
    let dynamic = false;
    let any = false;
    let plain = true;
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
        bound += literal(this.src.slice(this.pos + 1, close));
        plain = false;
        this.pos = close + 1;
      } else if (c === '"') {
        const inner = this.readDoubleQuoted();
        text += inner.text;
        bound += inner.bound;
        plain = false;
        dynamic ||= inner.dynamic;
      } else if (c === "\\") {
        const next = this.src[this.pos + 1];
        if (next === undefined) {
          this.fail("a trailing backslash");
          break;
        }
        text += next;
        bound += literal(next);
        plain = false;
        this.pos += 2;
      } else if (c === "`") {
        const start = this.pos;
        text += this.readBacktick();
        bound += this.src.slice(start, this.pos);
        dynamic = true;
      } else if (c === "$") {
        const start = this.pos;
        const expansion = this.readDollar();
        text += expansion.text;
        bound += this.src.slice(start, this.pos);
        dynamic ||= expansion.dynamic;
      } else {
        text += c;
        bound += c;
        this.pos += 1;
      }
    }
    return any ? { text, bound, dynamic, procSub: false, plain } : null;
  }

  private readDoubleQuoted(): { text: string; bound: string; dynamic: boolean } {
    this.pos += 1;
    let text = "";
    let bound = "";
    let dynamic = false;
    while (this.pos < this.src.length && !this.failure) {
      const c = this.src[this.pos] as string;
      if (c === '"') {
        this.pos += 1;
        return { text, bound, dynamic };
      }
      if (c === "\\") {
        const next = this.src[this.pos + 1];
        if (next === undefined) break;
        if (next === "\n") {
          // A line continuation disappears.
        } else if ('$`"\\'.includes(next)) {
          text += next;
          bound += literal(next);
        } else {
          text += `\\${next}`;
          bound += literal(`\\${next}`);
        }
        this.pos += 2;
      } else if (c === "`" || c === "$") {
        // Inside double quotes it expands, but doesn't split into words, so it isn't the same as the bare form.
        const start = this.pos;
        const expansion = c === "`" ? { text: this.readBacktick(), dynamic: true } : this.readDollar();
        text += expansion.text;
        bound += `"${this.src.slice(start, this.pos)}"`;
        dynamic ||= expansion.dynamic;
      } else {
        text += c;
        bound += literal(c);
        this.pos += 1;
      }
    }
    this.fail("an unbalanced double quote");
    return { text, bound, dynamic };
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
  private absorb(script: string, how: { repeats?: boolean; wholeLine?: boolean } = {}): void {
    if (this.depth >= MAX_DEPTH) return this.fail("commands nested too deeply");
    const loops = this.loops + (how.repeats ? 1 : 0);
    const inner = new ShellParser(script, this.depth + 1, this.line, loops, this.wholeLine || how.wholeLine === true);
    const { directory } = this.line;
    inner.parseList(null);
    this.line.directory = directory;
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
      if (writes.length > 0 || reads.length > 0) this.pushNoCommand(raw, writes, reads);
      return;
    }

    // Leading keywords and `{` carry no meaning of their own: what follows them is the command.
    let words = builder.words;
    for (;;) {
      const timed = pastTime(words);
      if (timed) {
        words = timed;
      } else if (words[0] && LEADING_KEYWORDS.has(words[0].text)) {
        if (LOOP_OPENERS.has(words[0].text)) this.loops += 1;
        words = words.slice(1);
      } else {
        break;
      }
    }
    if (words.length === 0 || (words.length === 1 && CLOSING_KEYWORDS.has((words[0] as Word).text))) {
      const closing = words[0];
      if (closing?.plain && closing.text === "done") {
        // The loop it closes was opened in a way this didn't read, behind some prefix, so what repeats isn't known.
        if (this.loops === 0) return this.fail("a done with no loop this could read");
        this.loops -= 1;
      }
      if (writes.length > 0 || reads.length > 0) this.pushNoCommand(raw, writes, reads);
      return;
    }
    if ((words[0] as Word).plain && (words[0] as Word).text === "done") return this.fail("a done with more on it");
    const first = (words[0] as Word).text;
    if (first === "for") {
      this.loops += 1; // The body comes as its own commands, after `do`.
      return;
    }
    if (first === "case" || first === "select" || first === "function") return this.fail(`a ${first} statement`);

    this.finishCommand(words, builder, raw, writes, reads);
  }

  /** Only a redirect, or assignments with one: there is no command, but what it writes still counts. */
  private pushNoCommand(raw: string, writes: string[], reads: string[], wrappers: string[] = []): void {
    if (this.writesSomewhereUnknown(writes)) return;
    const { directory } = this.line;
    this.commands.push({ raw, effective: "", canonical: "", writes, reads, dynamic: [], words: [], wrappers, setup: [], directory, repeats: false, boundToLine: false });
    if (writes.length > 0) this.line.setup.push([">", ...writes]);
  }

  /** After `cd "$X"`, a relative path written to is as unknown as `> "$X/y"`, which is held. */
  private writesSomewhereUnknown(writes: string[]): boolean {
    if (this.line.directory !== null || !writes.some((path) => !/^(\/|~)/.test(path))) return false;
    this.fail("a path only known at run time, after a cd to one");
    return true;
  }

  /** Follows `cd` and `pushd`. Their subshells and strings get the old directory back, in parseList and absorb. */
  private changeDirectory(args: Word[]): void {
    const operands = args.filter((word, index) => !(word.text.startsWith("-") && word.text !== "-" && args.slice(0, index).every((before) => before.text.startsWith("-"))));
    const target = operands[0];
    if (!target) {
      this.line.directory = "~";
    } else if (target.dynamic || target.text === "-") {
      this.line.directory = null;
    } else if (/^(\/|~)/.test(target.text)) {
      this.line.directory = posix.normalize(target.text);
    } else if (this.line.directory !== null) {
      this.line.directory = posix.join(this.line.directory, target.text).replace(/^\.$/, "");
    }
  }

  /** From here on, what runs on this line runs under this. */
  private noteSetup(words: Word[]): void {
    if (words.length === 0) return;
    this.line.setup.push(words.map((word) => word.bound));
    this.line.assigned.push(...words.map((word) => word.text));
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

  private finishCommand(all: Word[], builder: Builder, raw: string, writes: string[], reads: string[], carriedBy?: Carried): void {
    const kept: Word[] = [...(carriedBy?.prefix ?? [])]; // Wrappers and assignments: they change what runs, so a grant binds to them.
    const lineDirectory = this.line.directory;
    let wrapperDirectory: Word | undefined;
    let carried = carriedBy;
    let rest = all;
    for (;;) {
      const word = rest[0];
      if (!word) {
        // Assignments and wrappers with nothing to run. A redirect on one still writes, and what comes next inherits it.
        this.noteSetup(kept);
        if (writes.length > 0 || reads.length > 0) this.pushNoCommand(raw, writes, reads, kept.map((one) => one.text));
        return;
      }
      if (isAssignment(word.text)) {
        kept.push(word);
        rest = rest.slice(1);
        continue;
      }
      const runner = word.dynamic ? "" : baseName(word.text);
      if (RUNS_WHAT_IT_READS.has(runner)) return this.fail(`${runner} runs commands that are not on this line`);
      if ((RUNS_A_STRING.has(runner) || MAY_RUN_A_STRING.has(runner) || runner === "watch") && this.readStringRunner(runner, rest, kept)) return;
      const wrapper = word.dynamic ? undefined : WRAPPERS[runner];
      if (!wrapper) break;
      kept.push(word);
      rest = rest.slice(1);
      if (baseName(word.text) === "xargs") carried = { by: "xargs", placeholder: xargsPlaceholder(rest), prefix: [] };
      let positionals = wrapper.positionals ?? 0;
      while (rest[0]) {
        const next = rest[0];
        if (next.text === "--") {
          kept.push(next);
          rest = rest.slice(1);
          break;
        }
        if (baseName(word.text) === "env" && next.text === "-S") return this.fail("env -S");
        if (next.text.startsWith("-") && next.text.length > 1) {
          const takesValue = wrapper.flagsWithValue.has(next.text);
          const changes = CHANGES_DIRECTORY[baseName(word.text)];
          if (changes?.attached && next.text.startsWith(changes.attached)) {
            wrapperDirectory = { ...next, text: next.text.slice(changes.attached.length) };
          } else if (takesValue && rest[1] && changes?.flags.has(next.text)) {
            wrapperDirectory = rest[1];
          }
          kept.push(next);
          rest = rest.slice(1);
          if (takesValue && rest[0]) {
            kept.push(rest[0]);
            rest = rest.slice(1);
          }
          continue;
        }
        if (wrapper.assignments && isAssignment(next.text)) {
          kept.push(next);
          rest = rest.slice(1);
          continue;
        }
        if (positionals > 0) {
          positionals -= 1;
          kept.push(next);
          rest = rest.slice(1);
          continue;
        }
        break;
      }
    }

    // A wrapper's directory is for its one command, and what that runs, so it has to be read like a `cd` and then undone.
    if (wrapperDirectory) {
      this.changeDirectory([wrapperDirectory]);
      try {
        this.finishWrapped(rest, all, kept, builder, raw, writes, [...reads, ...texts([wrapperDirectory])], carried);
      } finally {
        this.line.directory = lineDirectory;
      }
      return;
    }
    this.finishWrapped(rest, all, kept, builder, raw, writes, reads, carried);
  }

  /** A command with its wrappers off. */
  private finishWrapped(rest: Word[], all: Word[], kept: Word[], builder: Builder, raw: string, writes: string[], reads: string[], carried: Carried | undefined): void {
    const command = rest[0] as Word;
    if (command.dynamic) return this.fail(`a command only known at run time: ${command.text}`);
    const name = baseName(command.text);
    if (name === "eval") return this.fail("eval");
    if (name === "source" || name === ".") return this.fail(`${name}: the script's commands are not on this line`);
    if (carried) {
      const problem = carriedProblem(rest, carried);
      if (problem) return this.fail(problem);
    }
    if (name === "git") {
      const problem = gitProblem(rest, [...kept.map((word) => word.text), ...this.line.assigned]);
      if (problem) return this.fail(problem);
    }
    if (SHELLS.has(name)) {
      const inner = this.readShellInvocation(rest, kept);
      if (inner === "absorbed") return;
      if (inner === "failed") return;
    } else if (INTERPRETERS.test(name) && !hasScript(rest) && (builder.pipedIn || builder.fed)) {
      return this.fail(`${name} reads its program from input`);
    }
    const inlineProblem = inlineCodeProblem(name, rest);
    if (inlineProblem) return this.fail(inlineProblem);

    if (name === "find" && !this.readFindChildren(rest, kept, builder)) return;

    const writtenBy = writesOf(rest);
    if (writtenBy === null) return this.fail("a path only known at run time");
    if (this.writesSomewhereUnknown([...writes, ...writtenBy])) return;
    const effectiveWords = (name === "git" ? stripGitGlobals(rest) : rest).map((word) => word.text);
    const everyWord = [...kept, ...rest];
    const repeats = this.loops > 0 || carried !== undefined;
    this.commands.push({
      raw,
      effective: effectiveWords.map((text, index) => (index === 0 ? text : resolveClimb(text))).join(" "),
      canonical: everyWord.map((word) => word.text).join(" "),
      writes: [...writes, ...writtenBy],
      reads: [...reads, ...pathsReadBy(rest)],
      dynamic: all.filter((word) => word.dynamic).map((word) => word.text),
      words: effectiveWords,
      wrappers: kept.map((word) => word.text),
      ...(textIsNotEnough(everyWord) ? { boundWords: everyWord.map((word) => word.bound) } : {}),
      setup: this.line.setup.map((words) => [...words]),
      directory: this.line.directory,
      repeats,
      boundToLine: repeats || this.wholeLine || builder.pipedIn || builder.fed,
    });
    if (!leavesThingsAsTheyWere(name, rest, [...writes, ...writtenBy])) this.noteSetup(everyWord);
    if (name === "cd" || name === "pushd") this.changeDirectory(rest.slice(1));
    if (name === "popd") this.line.directory = null;
  }

  /** `find -exec cmd ... ;` runs cmd: each one is read as a command in its own right. False when one can't be. */
  private readFindChildren(words: Word[], kept: Word[], builder: Builder): boolean {
    for (let index = 1; index < words.length; index += 1) {
      const flag = (words[index] as Word).text;
      if (!FIND_RUNS.has(flag)) continue;
      let end = index + 1;
      while (end < words.length && ![";", "+"].includes((words[end] as Word).text)) end += 1;
      if (end >= words.length) {
        this.fail(`find ${flag} with no end`);
        return false;
      }
      const child = words.slice(index + 1, end);
      if (child.length === 0) {
        this.fail(`find ${flag} with nothing to run`);
        return false;
      }
      const prefix = [...kept, ...words.slice(0, index + 1)];
      const fresh = { ...builder, pipedIn: false, fed: false, words: child, writes: [], reads: [] };
      this.finishCommand(child, fresh, child.map((word) => word.text).join(" "), [], [], { by: "find", placeholder: "{}", prefix });
      if (this.failure) return false;
      index = end;
    }
    return true;
  }

  /**
   * `script -qc 'x'`, `su user -c 'x'`, `flock file -c 'x'`, `watch x`: the string is the commands. True when this took
   * care of the command; false when it's an ordinary wrapper after all.
   */
  private readStringRunner(name: string, words: Word[], kept: Word[]): boolean {
    const args = words.slice(1);
    if (name === "watch") return this.readWatch(words, kept);
    const wraps = name === "runuser" && runsItsWords(args);
    const found = name === "flock" ? flockString(args) : wraps ? null : commandString(args);
    if (found === null) {
      if (name === "flock" || wraps) return false;
      this.fail(`${name} reads its commands from input`);
      return true;
    }
    if (found.script === undefined || found.script.dynamic) {
      this.fail(`${name} -c with a script only known at run time`);
      return true;
    }
    this.noteSetup([...kept, ...words.filter((word) => word !== found.script)]);
    this.absorb(found.script.text);
    return true;
  }

  /** `watch git push` runs the words as one string, over and over. */
  private readWatch(words: Word[], kept: Word[]): boolean {
    let index = 1;
    while (words[index]?.text.startsWith("-")) {
      const flag = (words[index] as Word).text;
      index += flag === "-n" || flag === "--interval" || flag === "-q" || flag === "--equexit" ? 2 : 1;
    }
    const command = words.slice(index);
    if (command.length === 0 || command.some((word) => word.dynamic)) {
      this.fail("watch with a command only known at run time");
      return true;
    }
    this.noteSetup([...kept, ...words.slice(0, index)]);
    this.absorb(command.map((word) => word.text).join(" "), { repeats: true });
    return true;
  }

  /** `bash -c "..."` is the commands in the string. A shell with no script on this line reads them from elsewhere. */
  private readShellInvocation(words: Word[], kept: Word[]): "absorbed" | "failed" | "script" {
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
      // What it runs under counts, and so do its arguments: `bash -c 'rm -rf "$1"' _ /` says where only out here.
      this.noteSetup(kept);
      this.absorb(next.text, { wholeLine: words.length > index + 1 });
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

/**
 * The string a command runner was given: `-c x`, `-qc x`, `--command x`, `--command=x`. Null when it wasn't given one.
 * Given more than one, the last wins, so reading the first would miss what runs: that comes back as no script at all.
 */
function commandString(args: Word[]): { script: Word | undefined } | null {
  let found: { script: Word | undefined } | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] as Word;
    if (word.text === "--") break;
    const attached = word.text.startsWith("--command=");
    if (!attached && word.text !== "--command" && !/^-[a-zA-Z]*c$/.test(word.text)) continue;
    if (found) return { script: undefined };
    found = { script: attached ? { ...word, text: word.text.slice("--command=".length) } : args[index + 1] };
    if (!attached) index += 1;
  }
  return found;
}

/** `flock file -c x`: only right after the file. Later, a `-c` belongs to the command flock runs, as in `flock file git -c x`. */
function flockString(args: Word[]): { script: Word | undefined } | null {
  const valueFlags = WRAPPERS.flock?.flagsWithValue;
  let index = 0;
  while (args[index]?.text.startsWith("-")) index += valueFlags?.has((args[index] as Word).text) ? 2 : 1;
  const after = args.slice(index + 1, index + 3);
  return after[0] && ["-c", "--command"].includes(after[0].text) ? { script: after[1] } : null;
}

/** `runuser -u bot cmd args` runs its words, and a `-c` among them is the command's own. */
function runsItsWords(args: Word[]): boolean {
  return args.some((word) => word.text === "-u" || word.text === "--user" || word.text.startsWith("--user="));
}

function resolveClimb(text: string): string {
  return CLIMBS.test(text) && !/^-|=|:\/\//.test(text) ? posix.normalize(text) : text;
}

/** The text can't stand for the words when it reads the same for a different command, or hides what the shell will do. */
function textIsNotEnough(words: Word[]): boolean {
  return words.some((word) => word.bound !== word.text || word.text === "" || /\s/.test(word.text));
}

/** Past `time` and its flags, when what it times is a keyword. Otherwise it's a wrapper like any other. */
function pastTime(words: Word[]): Word[] | null {
  if (!words[0]?.plain || words[0].text !== "time") return null;
  let index = 1;
  while (words[index]?.text.startsWith("-")) index += 1;
  const next = words[index];
  return next?.plain && TIME_TAKES.has(next.text) ? words.slice(index) : null;
}

function leavesThingsAsTheyWere(name: string, words: Word[], writes: string[]): boolean {
  if (writes.length > 0) return false;
  if (name === "git") return GIT_ONLY_READS.has(stripGitGlobals(words)[1]?.text ?? "");
  if (name === "printf" && words[1]?.text.startsWith("-v")) return false;
  return KNOWN_HARMLESS.has(name);
}

/** The words that leave the tree by how they're written. Inside it, a path needs no looking at. */
function texts(from: Word[]): string[] {
  return from.map((word) => word.text).filter((text) => LEAVES_THE_TREE.test(text));
}

function hasScript(words: Word[]): boolean {
  for (const word of words.slice(1)) {
    if (INLINE_CODE_FLAGS.has(word.text)) return true;
    if (word.text === "-") return false;
    if (!word.text.startsWith("-")) return true;
  }
  return false;
}

/** What this command reads that's outside the tree, going by its arguments. Inside it, a path needs no looking at. */
function pathsReadBy(words: Word[]): string[] {
  const name = baseName((words[0] as Word).text);
  const args = words.slice(1);
  if (name === "cd" && args.length === 0) return ["~"];
  if (name === "git") {
    const at = args.findIndex((word) => word.text === "-C");
    return at === -1 ? [] : texts(args.slice(at + 1, at + 2));
  }
  if (name === "dd") {
    return texts(args.filter((word) => word.text.startsWith("if=")).map((word) => ({ ...word, text: word.text.slice("if=".length) })));
  }
  if (name === "find") {
    const end = args.findIndex((word) => /^[-(!]/.test(word.text));
    return texts(end === -1 ? args : args.slice(0, end));
  }
  const positional = args.filter((word) => !word.text.startsWith("-"));
  if (READS_ITS_ARGUMENTS.has(name)) return texts(positional);
  if (!READS_AFTER_A_PATTERN.has(name)) return [];
  return texts(args.some((word) => NAMES_ITS_PATTERN.has(word.text)) ? positional : positional.slice(1));
}

/** The word `xargs` replaces with what it reads. It only has one with -I, -i or --replace; otherwise it appends. */
function xargsPlaceholder(args: Word[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const text = (args[index] as Word).text;
    if (!text.startsWith("-")) break;
    if (text === "-I" || text === "--replace") return args[index + 1]?.text ?? "{}";
    if (text.startsWith("-I")) return text.slice(2);
    if (text.startsWith("--replace=")) return text.slice("--replace=".length);
    if (text === "-i") return "{}";
    if (text.startsWith("-i")) return text.slice(2);
  }
  return "{}";
}

/**
 * Why a command run by `find` or `xargs` can't be read. Its target comes from what they read, so `xargs rm -rf` could be
 * `rm -rf /`. For `xargs` that's always so. For `find` only when the placeholder is there: `find -exec rm -rf / ;` says
 * exactly what it does, and the policy can read that like any other `rm`.
 */
function carriedProblem(words: Word[], carried: Carried): string | null {
  const name = baseName((words[0] as Word).text);
  const has = (word: Word) => word.text.includes(carried.placeholder);
  if (has(words[0] as Word)) return `${carried.by} runs a command only known at run time`;
  if (SHELLS.has(name) && words.slice(1).some(has)) return `${carried.by} gives ${name} a script only known at run time`;
  if (DESTROYS_ITS_TARGET.has(name) && (carried.by === "xargs" || words.slice(1).some(has))) {
    return `${carried.by} ${name}: what it acts on is only known at run time`;
  }
  return null;
}

/** Why this git line isn't what it looks like: something on it can run a command of its own. Null when it's fine. */
function gitProblem(words: Word[], kept: string[]): string | null {
  const risky = kept.find((word) => GIT_RISKY_ENVIRONMENT.test(word));
  if (risky) return `git with ${risky.slice(0, risky.indexOf("="))} set, which can run anything`;
  let index = 1;
  while (words[index]) {
    const word = words[index] as Word;
    const text = word.text;
    if (!text.startsWith("-")) break;
    if (text === "--config-env" || text.startsWith("--config-env=")) return "git --config-env, whose setting comes from the environment and can run anything";
    if (text.startsWith("--exec-path=")) return "git --exec-path, which chooses what git runs";
    if (text === "-c") {
      const setting = words[index + 1];
      if (!setting || setting.dynamic) return "git -c with a setting only known at run time";
      const key = setting.text.split("=", 1)[0] as string;
      if (!GIT_HARMLESS_SETTINGS.test(key)) return `git -c ${key}, which can change what git runs`;
    }
    index += GIT_GLOBALS_WITH_VALUE.has(text) ? 2 : 1;
  }
  return (words[index] as Word | undefined)?.text === "config" ? gitConfigProblem(words.slice(index + 1)) : null;
}

/** `git config alias.boom '!rm -rf /'` then `git boom` is the same trick in two steps. Reading a setting is fine. */
function gitConfigProblem(args: Word[]): string | null {
  const FLAGS_WITH_VALUE = new Set(["-f", "--file", "--blob", "--type", "--default"]);
  const positional: Word[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const text = (args[index] as Word).text;
    if (/^(-l|--list|--get.*|-e|--edit)$/.test(text)) return text === "-e" || text === "--edit" ? "git config --edit" : null;
    if (FLAGS_WITH_VALUE.has(text)) index += 1;
    else if (!text.startsWith("-")) positional.push(args[index] as Word);
  }
  const subcommand = positional[0]?.text;
  if (subcommand === "get" || subcommand === "list") return null;
  const setting = subcommand === "set" ? positional[1] : positional.length >= 2 ? positional[0] : null;
  if (!setting) return null;
  if (setting.dynamic || !GIT_HARMLESS_SETTINGS.test(setting.text)) return `git config ${setting.text}, which can change what git runs`;
  return null;
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
  } else if (name === "find") {
    targets = args.filter((_word, index) => ["-fprint", "-fprint0", "-fls", "-fprintf"].includes((args[index - 1] as Word | undefined)?.text ?? ""));
  } else if (name === "git") {
    targets = gitOutputs(words);
  }
  const paths: string[] = [];
  for (const target of targets) {
    if (target.dynamic) return null;
    if (!NOT_REAL_FILES.test(target.text)) paths.push(target.text);
  }
  return paths;
}

/** `git log --output=x` writes x, so a safe-looking read isn't one. `-o` means that only for these two commands. */
function gitOutputs(words: Word[]): Word[] {
  const OUTPUT_FLAGS = ["--output", "--output-directory"];
  const subcommand = stripGitGlobals(words)[1]?.text ?? "";
  const shortFlag = subcommand === "archive" || subcommand === "format-patch";
  const targets: Word[] = [];
  words.slice(1).forEach((word, index, args) => {
    const { text } = word;
    const named = OUTPUT_FLAGS.find((flag) => text.startsWith(`${flag}=`));
    if (named) {
      targets.push({ ...word, text: text.slice(named.length + 1) });
    } else if (OUTPUT_FLAGS.includes(text) || (shortFlag && text === "-o")) {
      const next = args[index + 1];
      if (next) targets.push(next);
    } else if (shortFlag && /^-o./.test(text)) {
      targets.push({ ...word, text: text.slice(2) });
    }
  });
  return targets;
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

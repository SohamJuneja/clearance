/**
 * Reads code handed to an interpreter on the command line: `python3 -c`, `node -e`, `perl -e`, an `awk` program. Agents use
 * these all the time to parse JSON, so holding every one would bury the calls that matter under cards. What gets held is
 * code that writes files, starts a process or reaches the network, and code this can't read because it's only known at
 * run time. Plain computation passes.
 *
 * This is a scan of text, not an analysis of a program, and it can be evaded: docs/threat-model.md says how far it goes.
 * The hooks are a guardrail, and the gate stays the boundary. Each reader starts from what's known to be harmless where
 * it can, and an answer of "not sure" is a reason to hold. That goes for flags too: one a reader doesn't know might be how
 * the code is given, or might take the next word, so it can't say what it read.
 */

type CodeWord = { text: string; dynamic: boolean };

/** The code in an interpreter's arguments. `problem` is set when the flags alone already say it isn't plain. */
type Inline = { code: CodeWord[]; problem?: string };

const NOT_INLINE: Inline = { code: [] };

const PYTHON_NAME = /^python[\d.]*$/;
const AWK_NAMES = new Set(["awk", "gawk", "mawk", "nawk"]);

/** Why this command's inline code isn't plain computation. Null when it has none, or it is. */
export function inlineCodeProblem(name: string, words: CodeWord[]): string | null {
  const args = words.slice(1);
  const language = languageOf(name);
  if (!language) return null;
  const inline = language.find(args);
  if (inline.problem) return `inline ${name} code that ${inline.problem}`;
  if (inline.code.some((word) => word.dynamic)) return `inline ${name} code only known at run time`;
  for (const { text } of inline.code) {
    const problem = language.scan(text);
    if (problem) return `inline ${name} code that ${problem}`;
  }
  return null;
}

type Language = { find: (args: CodeWord[]) => Inline; scan: (code: string) => string | null };

function languageOf(name: string): Language | null {
  if (PYTHON_NAME.test(name)) return { find: pythonInline, scan: pythonProblem };
  if (name === "node" || name === "tsx" || name === "ts-node") return { find: nodeInline, scan: nodeProblem };
  if (name === "bun") return { find: nodeInline, scan: (code) => bunProblem(code) ?? nodeProblem(code) };
  if (name === "deno") return { find: denoInline, scan: (code) => denoProblem(code) ?? nodeProblem(code) };
  if (name === "perl") return { find: perlInline, scan: perlProblem };
  if (name === "ruby") return { find: rubyInline, scan: rubyProblem };
  if (name === "php") return { find: phpInline, scan: phpProblem };
  if (AWK_NAMES.has(name)) return { find: awkInline, scan: awkProblem };
  return null;
}

const firstHit = (code: string, rules: readonly (readonly [RegExp, string])[]): string | null =>
  rules.find(([pattern]) => pattern.test(code))?.[1] ?? null;

const STARTS_A_PROCESS = "can start a process";
const WRITES_FILES = "can write files";
const REACHES_NETWORK = "can reach the network";
const LOADS_CODE = "loads code that isn't on this line";
const RUNS_BUILT_CODE = "builds code and runs it";

const cantRead = (flag: string): Inline => ({ code: [], problem: `comes with an option this can't read: ${flag}` });

// ── Python ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const PYTHON_BARE_LETTERS = "bBdEhiIOPqRsSuvVx";
const PYTHON_LONG_FLAGS = new Set(["--version", "--help", "--help-env", "--help-xoptions", "--help-all"]);

function pythonInline(args: CodeWord[]): Inline {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] as CodeWord;
    const { text: flag } = word;
    if (!flag.startsWith("-") || flag === "-" || flag === "--") return NOT_INLINE;
    if (flag.startsWith("--")) {
      if (PYTHON_LONG_FLAGS.has(flag)) continue;
      return cantRead(flag);
    }
    for (let at = 1; at < flag.length; at += 1) {
      const letter = flag[at] as string;
      if (letter === "c") {
        const attached = flag.slice(at + 1);
        if (attached) return { code: [{ text: attached, dynamic: word.dynamic }] };
        const next = args[index + 1];
        return next ? { code: [next] } : NOT_INLINE;
      }
      if (letter === "m") return NOT_INLINE;
      if (letter === "W" || letter === "X") {
        if (at === flag.length - 1) index += 1;
        break;
      }
      if (!PYTHON_BARE_LETTERS.includes(letter)) return cantRead(flag);
    }
  }
  return NOT_INLINE;
}

/** Modules that compute. A module not here might do anything, so it isn't plain. */
const PYTHON_PURE_MODULES = new Set([
  "abc", "argparse", "ast", "base64", "binascii", "bisect", "calendar", "cmath", "collections", "configparser", "contextlib", "copy",
  "csv", "dataclasses", "datetime", "decimal", "difflib", "enum", "fnmatch", "fractions", "functools", "glob", "hashlib", "heapq",
  "html", "ipaddress", "itertools", "json", "math", "numbers", "operator", "pathlib", "platform", "pprint", "random", "re", "secrets",
  "shlex", "statistics", "string", "struct", "sys", "textwrap", "time", "tomllib", "traceback", "typing", "unicodedata", "urllib.parse",
  "uuid", "yaml", "zoneinfo", "os", "os.path",
]);
const PYTHON_OS_ATTRIBUTES = new Set([
  "path", "environ", "getcwd", "sep", "linesep", "getenv", "name", "curdir", "pardir", "extsep", "pathsep", "listdir", "scandir", "walk", "stat", "lstat",
]);
const PYTHON_RULES = [
  [/__\w+__/, "reaches into Python's internals"],
  // By name, with or without a call, so `e=exec` doesn't get past it. A method like `re.compile` is something else.
  [/(?<![\w.'"])(exec|eval|compile|getattr|setattr|delattr|globals|locals|vars|breakpoint)\b/, RUNS_BUILT_CODE],
  [/(?<![\w.'"])open\b(?!\s*\()/, WRITES_FILES],
  [/\bmodules\b|\bmeta_path\b|\bpath_hooks\b|\bsettrace\b|\bsetprofile\b/, "reaches into Python's internals"],
  [/\byaml\s*\.\s*(unsafe_)?load(_all)?\s*\(/, RUNS_BUILT_CODE],
] as const;

function pythonImports(code: string): { names: { module: string; alias: boolean }[]; fromOs: string[] } {
  const names: { module: string; alias: boolean }[] = [];
  const fromOs: string[] = [];
  for (const match of code.matchAll(/\bfrom\s+([\w.]+)\s+import\s+([^;\n]+)/g)) {
    const module = match[1] as string;
    names.push({ module, alias: false });
    if (module === "os") fromOs.push(...(match[2] as string).split(",").map((part) => part.trim()));
  }
  for (const match of code.matchAll(/(?<!from\s[\w.]{0,80}\s)\bimport\s+([^;\n]+)/g)) {
    for (const part of (match[1] as string).split(",")) {
      const [module = "", ...alias] = part.trim().split(/\s+/);
      names.push({ module, alias: alias.length > 0 });
    }
  }
  return { names, fromOs };
}

function pythonProblem(code: string): string | null {
  const ruled = firstHit(code, PYTHON_RULES);
  if (ruled) return ruled;
  const { names, fromOs } = pythonImports(code);
  for (const { module, alias } of names) {
    if (!PYTHON_PURE_MODULES.has(module)) return `imports ${module}`;
    if (alias && module === "os") return "imports os under another name";
  }
  if (fromOs.some((name) => !PYTHON_OS_ATTRIBUTES.has(name))) return `imports ${fromOs.join(", ")} from os`;
  const importsOs = names.some(({ module }) => module === "os");
  if (importsOs) {
    const body = code.replace(/\b(from\s+[\w.]+\s+)?import\s+[^;\n]+/g, "");
    for (const match of body.matchAll(/\bos\b(\s*\.\s*(\w+))?/g)) {
      const attribute = match[2];
      if (!attribute) return "passes os around";
      if (!PYTHON_OS_ATTRIBUTES.has(attribute)) return `uses os.${attribute}`;
    }
  }
  if (/\.\s*write(lines)?\s*\(/.test(code.replace(/\bsys\s*\.\s*std(out|err)(\s*\.\s*buffer)?\s*\.\s*write\s*\(/g, ""))) return WRITES_FILES;
  if (names.some(({ module }) => module === "pathlib")) {
    if (/\.\s*(write_text|write_bytes|unlink|rmdir|mkdir|rename|replace|touch|symlink_to|hardlink_to|chmod|lchmod)\s*\(/.test(code)) return WRITES_FILES;
    if (/\.\s*open\s*\(\s*(mode\s*=\s*)?(?!['"][rbtU]*['"]\s*[,)])[^)]/.test(code)) return WRITES_FILES;
  }
  return opensForWriting(code) ? WRITES_FILES : null;
}

/** Every `open(...)` has to say it reads: no mode, or a literal read mode. A mode that's only known at run time doesn't. */
function opensForWriting(code: string): boolean {
  for (const match of code.matchAll(/(?<![\w.])open\s*\(/g)) {
    const args = callArguments(code, match.index + match[0].length);
    const named = args.find((arg) => /^mode\s*=/.test(arg));
    const mode = named ? named.replace(/^mode\s*=\s*/, "") : args[1] && !/^\w+\s*=/.test(args[1]) ? args[1] : undefined;
    if (mode !== undefined && !/^(['"])[rbtU]*\1$/.test(mode.trim())) return true;
  }
  return false;
}

/** A call's arguments as text, split at its own commas. Enough for a mode string. */
function callArguments(code: string, start: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (let index = start; index < code.length; index += 1) {
    const c = code[index] as string;
    if (quote) {
      if (c === "\\") {
        current += c + (code[index + 1] ?? "");
        index += 1;
        continue;
      }
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if ("([{".includes(c)) {
      depth += 1;
    } else if (")]}".includes(c)) {
      if (depth === 0) break;
      depth -= 1;
    } else if (c === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

// ── JavaScript: node, and bun and deno on top of it ──────────────────────────────────────────────────────────────────

/** Options that take the next word as their value. Past one of these, the next word isn't a script. */
const NODE_FLAGS_WITH_VALUE = new Set(["-C", "--conditions", "--input-type", "--title", "--disable-warning", "--stack-trace-limit", "--unhandled-rejections"]);
const NODE_HARMLESS_FLAGS =
  /^(-v|-h|--version|--help|--no-warnings|--no-deprecation|--trace-warnings|--trace-deprecation|--throw-deprecation|--pending-deprecation|--enable-source-maps|--use-strict|--harmony\S*|--no-experimental-\S*|--experimental-(?!loader)\S*|--(conditions|input-type|title|disable-warning|unhandled-rejections)=\S*|--(max-old-space-size|stack-size|stack-trace-limit)=\d+)$/;

/**
 * An option this doesn't know matters only with code on the line, since without any it's a script, which isn't read at
 * all. With code, the option might change what it does, and might have taken a word that looks like something else.
 */
function nodeInline(args: CodeWord[]): Inline {
  const code: CodeWord[] = [];
  let loads = false;
  let unknown: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] as CodeWord;
    const { text: flag } = word;
    if (flag === "-" || flag === "--") break;
    if (!flag.startsWith("-")) {
      if (unknown) continue;
      break;
    }
    if (["-e", "--eval", "-p", "--print", "-pe"].includes(flag)) {
      const next = args[index + 1];
      if (next) code.push(next);
      index += 1;
    } else if (/^(--eval|--print|-e|-p|-pe)=/.test(flag)) {
      code.push({ text: flag.slice(flag.indexOf("=") + 1), dynamic: word.dynamic });
    } else if (/^(-r|--require|--import|--loader|--experimental-loader)(=|$)/.test(flag)) {
      loads = true;
      if (!flag.includes("=")) index += 1;
    } else if (NODE_FLAGS_WITH_VALUE.has(flag)) {
      index += 1;
    } else if (!NODE_HARMLESS_FLAGS.test(flag)) {
      unknown ??= flag;
    }
  }
  if (code.length === 0) return { code };
  if (loads) return { code: [], problem: LOADS_CODE };
  return unknown ? cantRead(unknown) : { code };
}

/** Every word after `eval` is read, because one that isn't a flag might be a flag's value, and the code might be the next. */
function denoInline(args: CodeWord[]): Inline {
  if (args[0]?.text !== "eval") return NOT_INLINE;
  return { code: args.slice(1).filter((word) => !word.text.startsWith("-")) };
}

const NODE_PURE_MODULES = /^(node:)?(fs|fs\/promises|path|util|os|url|assert|querystring|crypto|buffer|string_decoder|events|perf_hooks|timers)$/;
const NODE_RULES = [
  [/\b(fetch|WebSocket|XMLHttpRequest|EventSource)\b/, REACHES_NETWORK],
  [/(?<![\w.'"])(eval|Function)\b|(?<![\w.])(Worker|SharedWorker)\s*\(/, RUNS_BUILT_CODE],
  [/\bconstructor\b|__proto__|\bglobalThis\b|\bglobal\s*[[.]|\bReflect\b/, "reaches into JavaScript's internals"],
  [/\bprocess\s*\.\s*(binding|kill|chdir|setuid|setgid|execve|abort)\b/, "reaches into the process"],
  // By name, and through a bracket or another name for `process`, since none of these has an ordinary use in a one-liner.
  [/\b(getBuiltinModule|_linkedBinding|dlopen|mainModule)\b|\bprocess\s*\[|=\s*process\b(?!\s*\.)/, "reaches into the process"],
  // By name alone, so taking one out of `fs` with a destructure doesn't get past it.
  [
    /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rmSync|rmdirSync|unlinkSync|renameSync|mkdirSync|mkdtemp|mkdtempSync|copyFile|copyFileSync|cpSync|symlinkSync|linkSync|chmodSync|chownSync|truncateSync|utimesSync|lutimes|openSync|writeSync|writev|writevSync)\b/,
    WRITES_FILES,
  ],
  [/\.\s*(rm|rmdir|unlink|rename|mkdir|cp|symlink|link|chmod|chown|truncate|utimes|open)\s*\(/, WRITES_FILES],
  // Past the names above by asking for them with a string.
  [/\brequire\s*\([^)]*\)\s*\[|\bfs\s*\[/, "chooses what it calls at run time"],
] as const;

function allowedJsModule(name: string): boolean {
  return NODE_PURE_MODULES.test(name) || name.endsWith(".json");
}

function nodeProblem(code: string): string | null {
  const ruled = firstHit(code, NODE_RULES);
  if (ruled) return ruled;
  if (/\.\s*write\s*\(/.test(code.replace(/\bprocess\s*\.\s*std(out|err)\s*\.\s*write\s*\(/g, ""))) return WRITES_FILES;

  const requires = [...code.matchAll(/\brequire\s*\(\s*(['"`])([^'"`$]+)\1\s*\)/g)];
  if ((code.match(/\brequire\b/g)?.length ?? 0) !== requires.length) return "chooses what it loads at run time";
  const imports = [...code.matchAll(/\bimport\b[^'"`;]*?(['"`])([^'"`$]+)\1/g)];
  if ((code.match(/\bimport\b/g)?.length ?? 0) !== imports.length) return "chooses what it loads at run time";
  for (const match of [...requires, ...imports]) {
    const name = match[2] as string;
    if (!allowedJsModule(name)) return `loads ${name}`;
  }
  return null;
}

function bunProblem(code: string): string | null {
  return /\bBun\s*\.\s*(?!(file|env|argv|version)\b)[\w$]+/.test(code) ? STARTS_A_PROCESS : null;
}

function denoProblem(code: string): string | null {
  return /\bDeno\s*\.\s*(?!(readTextFile|readTextFileSync|readFile|readFileSync|readDir|readDirSync|stat|statSync|lstat|cwd|env|args)\b)\w+/.test(code)
    ? STARTS_A_PROCESS
    : null;
}

// ── Perl and Ruby, whose flags cluster ───────────────────────────────────────────────────────────────────────────────

type Flags = {
  /** Letters that stand alone in a cluster. */
  bare: string;
  /** Letters followed by an optional number, then more of the cluster: `-0e`, `-l012e`, `-0777`. */
  numbered: string;
  /** Letters whose value is the rest of the word. */
  withValue: string;
  /** Those that can also take it as the next word. */
  nextWord: string;
  /** Those that name a module. */
  loads: string;
  /** Letters whose value is code. */
  code: string;
  longFlags: RegExp;
  allowed: (name: string) => boolean;
};

/** Reads a cluster a letter at a time, as the interpreter does, so nothing can sit in front of the `e`. `-i` rewrites files. */
function clusteredInline(args: CodeWord[], flags: Flags): Inline {
  const code: CodeWord[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] as CodeWord;
    const { text: flag } = word;
    if (!flag.startsWith("-") || flag === "-" || flag === "--") break;
    if (flag.startsWith("--")) {
      if (flags.longFlags.test(flag)) continue;
      return cantRead(flag);
    }
    for (let at = 1; at < flag.length; at += 1) {
      const letter = flag[at] as string;
      if (letter === "i") return { code: [], problem: WRITES_FILES };
      if (flags.code.includes(letter)) {
        const attached = flag.slice(at + 1);
        const next = args[index + 1];
        if (attached) {
          code.push({ text: attached, dynamic: word.dynamic });
        } else if (next) {
          code.push(next);
          index += 1;
        }
        break;
      }
      if (flags.numbered.includes(letter)) {
        const number = /^(x[0-9a-fA-F]*|[0-7]*)/.exec(flag.slice(at + 1)) as RegExpExecArray;
        at += number[0].length;
        continue;
      }
      if (flags.withValue.includes(letter)) {
        const attached = flag.slice(at + 1);
        const fromNext = !attached && flags.nextWord.includes(letter);
        if (fromNext) index += 1;
        if (flags.loads.includes(letter)) {
          const named = (fromNext ? args[index]?.text : attached) ?? "";
          if (!flags.allowed(named.split("=")[0] as string)) return { code: [], problem: `loads ${named}` };
        }
        break;
      }
      if (!flags.bare.includes(letter)) return cantRead(flag);
    }
  }
  return { code };
}

const PERL_PURE_MODULES = new Set([
  "strict", "warnings", "utf8", "feature", "integer", "bigint", "bignum", "JSON", "JSON::PP", "List::Util", "Scalar::Util", "POSIX", "Data::Dumper",
  "Time::Local", "Time::Piece", "Text::Wrap", "Getopt::Long", "MIME::Base64", "Digest::MD5", "Digest::SHA", "open",
]);
const perlInline = (args: CodeWord[]): Inline =>
  clusteredInline(args, {
    bare: "anpsStTuUvwWXcgfh",
    numbered: "0l",
    withValue: "MmIFCxDdV",
    nextWord: "MmI",
    loads: "Mm",
    code: "eE",
    longFlags: /^--(version|help)$/,
    allowed: (name) => PERL_PURE_MODULES.has(name.replace(/^-/, "")),
  });

const PERL_RULES = [
  [/`|\bqx\b|\bsystem\b(?=\s*[("'$@{\s])|\bexec\b(?=\s*[("'$@{\s])|\bfork\b/, STARTS_A_PROCESS],
  [/\b(socket|connect|IO::Socket|LWP|HTTP::Tiny|Net::)\b/, REACHES_NETWORK],
  [/\b(unlink|rename|mkdir|rmdir|chmod|chown|symlink|truncate|sysopen|utime|chroot)\b(?=\s*[("'$@{\s])|\$\^I/, WRITES_FILES],
  [/\beval\b|\brequire\b|\bdo\s+['"$]|\bsyscall\b|\bdump\b|\bkill\b|\bCORE::/, RUNS_BUILT_CODE],
] as const;

function perlProblem(code: string): string | null {
  const ruled = firstHit(code, PERL_RULES);
  if (ruled) return ruled;
  for (const match of code.matchAll(/\b(?:use|no)\s+([\w:]+)/g)) {
    const name = match[1] as string;
    if (!PERL_PURE_MODULES.has(name) && !/^v?\d/.test(name)) return `loads ${name}`;
  }
  // Only a three-argument read says what it does: a two-argument open takes its mode, or a pipe, from the string.
  for (const match of code.matchAll(/\bopen\b(?=\s+\S|\s*\()/g)) {
    const after = code.slice(match.index, match.index + 200);
    if (!/^open\s*\(?\s*[^,]+,\s*(['"])<(:[^'"]*)?\1/.test(after)) return WRITES_FILES;
  }
  return null;
}

const RUBY_PURE_MODULES = new Set(["json", "yaml", "time", "date", "set", "csv", "digest", "base64", "bigdecimal", "securerandom", "pp", "strscan", "ostruct"]);
const rubyInline = (args: CodeWord[]): Inline =>
  clusteredInline(args, {
    bare: "aclnpsSUvwyhd",
    numbered: "0",
    withValue: "CEFIKrTWxX",
    nextWord: "CEIrX",
    loads: "r",
    code: "e",
    longFlags: /^--(version|help|verbose|yydebug|disable\S*|enable\S*|encoding\S*|external-encoding\S*|internal-encoding\S*)$/,
    allowed: (name) => RUBY_PURE_MODULES.has(name),
  });

const RUBY_RULES = [
  [/`|%x\b|%x[^\w\s]|\b(system|exec|spawn|fork|syscall)\b|\bIO\s*\.\s*popen\b|\bOpen3\b|\bProcess\b|\bKernel\b/, STARTS_A_PROCESS],
  [/\b(Socket|TCPSocket|UDPSocket|UNIXSocket|TCPServer)\b|\bNet::|\bURI\s*\.\s*open\b|\bopen-uri\b/, REACHES_NETWORK],
  [/\bFileUtils\b|\b(File|IO)\s*\.\s*(write|binwrite|delete|unlink|rename|chmod|chown|symlink|link|truncate|mkfifo|utime)\b|\bDir\s*\.\s*(mkdir|rmdir|unlink|delete|chdir)\b/, WRITES_FILES],
  [/\b((File|IO)\s*\.\s*)?(open|new)\s*\(?\s*[^,)]+,\s*['"][^'"]*[wa+]/, WRITES_FILES],
  [/\bFile::(WRONLY|RDWR|CREAT|APPEND|TRUNC)\b|\.\s*(sysopen|reopen)\b/, WRITES_FILES],
  [/\bopen\s*\(?\s*['"]\|/, STARTS_A_PROCESS],
  [/(?<![.\w])(eval|load|binding)\b|\b(instance_eval|class_eval|module_eval|send|__send__|public_send|require_relative|define_method|const_get)\b/, RUNS_BUILT_CODE],
] as const;

function rubyProblem(code: string): string | null {
  const ruled = firstHit(code, RUBY_RULES);
  if (ruled) return ruled;
  for (const match of code.matchAll(/\brequire\b\s*\(?\s*(['"]?)([^'")\s;]*)\1/g)) {
    if (!RUBY_PURE_MODULES.has(match[2] as string)) return `loads ${match[2] as string}`;
  }
  if (/\.\s*write\s*\(/.test(code.replace(/(\$std(out|err)|STD(OUT|ERR))\s*\.\s*write\s*\(/g, ""))) return WRITES_FILES;
  return null;
}

// ── PHP ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Settings that make php load or run something of their own. */
const PHP_LOADING_SETTING = /^(auto_prepend_file|auto_append_file|extension|zend_extension|include_path|disable_functions|open_basedir)\b/;

function phpInline(args: CodeWord[]): Inline {
  const code: CodeWord[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] as CodeWord;
    const { text: flag } = word;
    if (!flag.startsWith("-") || flag === "-" || flag === "--") break;
    if (flag === "-f" || flag === "--file") return { code };
    if (["-r", "--run", "-B", "--process-begin", "-R", "--process-code", "-E", "--process-end"].includes(flag)) {
      const next = args[index + 1];
      if (next) code.push(next);
      index += 1;
    } else if (/^-[rBRE]./.test(flag)) {
      code.push({ text: flag.slice(2), dynamic: word.dynamic });
    } else if (flag === "-d" || flag === "--define" || /^-d./.test(flag)) {
      const setting = flag.startsWith("-d") && flag.length > 2 ? flag.slice(2) : (args[index + 1]?.text ?? "");
      if (flag.length <= 2 || flag === "--define") index += 1;
      if (PHP_LOADING_SETTING.test(setting)) return cantRead(`${flag} ${setting}`);
    } else if (!/^(-[nqvhimlsw]|--version|--help|--no-php-ini|--info|--modules|--syntax-check)$/.test(flag)) {
      return cantRead(flag);
    }
  }
  return { code };
}

/** A function named in a string: `array_map('system', ...)`. Enough to catch the obvious, and no more than that. */
const PHP_NAMED_IN_A_STRING =
  /['"](system|exec|shell_exec|passthru|popen|proc_open|eval|assert|file_put_contents|unlink|rename|mkdir|rmdir|chmod|chown|symlink|copy|touch|fopen|fsockopen|curl_exec|mail)['"]/;

const PHP_RULES = [
  [/`|\b(system|exec|shell_exec|passthru|popen|proc_open|pcntl_\w+)\s*\(/, STARTS_A_PROCESS],
  [/\b(curl_\w+|fsockopen|pfsockopen|stream_socket_\w+|socket_\w+|ftp_\w+|mail)\s*\(|\bfile_get_contents\s*\(\s*['"]\w+:\/\//, REACHES_NETWORK],
  [/\b(file_put_contents|unlink|rename|mkdir|rmdir|chmod|chown|symlink|link|copy|tempnam|touch)\s*\(|\bfopen\s*\(\s*[^,]+,\s*['"][^'"]*[waxc+]/, WRITES_FILES],
  [/\b(eval|assert|create_function|dl|include|include_once|require|require_once|call_user_func|call_user_func_array)\b|\$\w+\s*\(/, RUNS_BUILT_CODE],
] as const;

const phpProblem = (code: string): string | null =>
  firstHit(code, PHP_RULES) ?? (PHP_NAMED_IN_A_STRING.test(code) ? RUNS_BUILT_CODE : null);

// ── awk ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const AWK_HARMLESS_FLAGS =
  /^(-[bcCghIkLMnNOPrsStV]|--(version|help|posix|traditional|re-interval|non-decimal-data|sandbox|characters-as-bytes|csv|lint|lint-old|optimize|no-optimize|use-lc-numeric|bignum|copyright)|--lint=\S+)$/;

/** The first word that isn't a flag is the program, unless a flag took it, so this has to know every flag it steps over. */
function awkInline(args: CodeWord[]): Inline {
  const code: CodeWord[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] as CodeWord;
    const { text: flag } = word;
    if (flag === "--") {
      const program = args[index + 1];
      return program && code.length === 0 ? { code: [program] } : { code };
    }
    if (!flag.startsWith("-") || flag === "-") return code.length > 0 ? { code } : { code: [word] };
    if (flag === "-f" || flag === "--file" || /^(-f.|--file=)/.test(flag)) return { code };
    if (flag === "-e" || flag === "--source") {
      const next = args[index + 1];
      if (next) code.push(next);
      index += 1;
    } else if (/^--source=/.test(flag)) {
      code.push({ text: flag.slice("--source=".length), dynamic: word.dynamic });
    } else if (/^-e./.test(flag)) {
      code.push({ text: flag.slice(2), dynamic: word.dynamic });
    } else if (flag === "-F" || flag === "-v" || flag === "--assign" || flag === "--field-separator") {
      index += 1;
    } else if (!/^(-F.|-v.|--assign=|--field-separator=)/.test(flag) && !AWK_HARMLESS_FLAGS.test(flag)) {
      return cantRead(flag);
    }
  }
  return { code };
}

const AWK_RULES = [
  [/\bsystem\s*\(/, STARTS_A_PROCESS],
  // A pipe to or from a command. A regex's `/a|b/` and a logical `||` aren't one.
  [/(?<!\|)\|(?!\|)\s*"|"\s*\|\s*getline|\|\s*getline|\|&|\bprintf?\b[^;}\n]*(?<!\|)\|(?!\|)/, STARTS_A_PROCESS],
  [/\bprintf?\b[^;}\n]*>/, WRITES_FILES],
] as const;

const awkProblem = (code: string): string | null => firstHit(code, AWK_RULES);

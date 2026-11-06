/**
 * Reads code handed to an interpreter on the command line: `python3 -c`, `node -e`, `perl -e`, an `awk` program. Agents use
 * these all the time to parse JSON, so holding every one would bury the calls that matter under cards. What gets held is
 * code that writes files, starts a process or reaches the network, and code this can't read because it's only known at
 * run time. Plain computation passes.
 *
 * This is a scan of text, not an analysis of a program, and it can be evaded: docs/threat-model.md says how far it goes.
 * The hooks are a guardrail, and the gate stays the boundary. Each reader starts from what's known to be harmless where
 * it can, and an answer of "not sure" is a reason to hold.
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

// ── Python ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function pythonInline(args: CodeWord[]): Inline {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] as CodeWord;
    if (!word.text.startsWith("-") || word.text === "-") return NOT_INLINE;
    if (word.text === "-m") return NOT_INLINE;
    const cluster = /^-[bBdEiIOPqsSuvx]*c(.*)$/.exec(word.text);
    if (cluster) {
      const attached = cluster[1] as string;
      if (attached) return { code: [{ text: attached, dynamic: word.dynamic }] };
      const next = args[index + 1];
      return next ? { code: [next] } : NOT_INLINE;
    }
    if (word.text === "-W" || word.text === "-X") index += 1;
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
  [/(?<![\w.])(exec|eval|compile|getattr|setattr|delattr|globals|locals|vars|breakpoint)\s*\(/, RUNS_BUILT_CODE],
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

function nodeInline(args: CodeWord[]): Inline {
  const code: CodeWord[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] as CodeWord;
    const { text } = word;
    if (!text.startsWith("-") || text === "-" || text === "--") break;
    if (["-e", "--eval", "-p", "--print", "-pe"].includes(text)) {
      const next = args[index + 1];
      if (next) code.push(next);
      index += 1;
    } else if (/^--(eval|print)=/.test(text)) {
      code.push({ text: text.slice(text.indexOf("=") + 1), dynamic: word.dynamic });
    } else if (/^(-r|--require|--import|--loader|--experimental-loader)(=|$)/.test(text)) {
      if (args.some((other) => /^(-e|-p|-pe|--eval|--print)(=|$)/.test(other.text))) return { code: [], problem: LOADS_CODE };
      if (!text.includes("=")) index += 1;
    }
  }
  return { code };
}

function denoInline(args: CodeWord[]): Inline {
  if (args[0]?.text !== "eval") return NOT_INLINE;
  const code = args.slice(1).find((word) => !word.text.startsWith("-"));
  return code ? { code: [code] } : NOT_INLINE;
}

const NODE_PURE_MODULES = /^(node:)?(fs|fs\/promises|path|util|os|url|assert|querystring|crypto|buffer|string_decoder|events|perf_hooks|timers)$/;
const NODE_RULES = [
  [/\b(fetch|WebSocket|XMLHttpRequest|EventSource)\b/, REACHES_NETWORK],
  [/(?<![\w.])(eval|Function|Worker|SharedWorker)\s*\(/, RUNS_BUILT_CODE],
  [/\bconstructor\b|__proto__|\bglobalThis\b|\bglobal\s*[[.]|\bReflect\b/, "reaches into JavaScript's internals"],
  [/\bprocess\s*\.\s*(binding|_linkedBinding|dlopen|mainModule|kill|getBuiltinModule|chdir|setuid|setgid|execve|abort)\b/, "reaches into the process"],
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
  /** Flags whose value is what follows them, so they aren't a cluster that could hold `e`. */
  withValue: RegExp;
  /** Those that can also take it as the next word. The others' value is only ever attached. */
  nextWord: Set<string>;
  /** Those that name a module. */
  loads: Set<string>;
  allowed: (name: string) => boolean;
};

/** `-e code`, `-pe code`, `-lane code`, `-ecode`, and `-i`, which rewrites the files it's given. */
function clusteredInline(args: CodeWord[], flags: Flags): Inline {
  const code: CodeWord[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] as CodeWord;
    const { text } = word;
    if (!text.startsWith("-") || text === "-" || text === "--") break;
    const value = flags.withValue.exec(text);
    if (value) {
      const flag = value[1] as string;
      const attached = value[2] as string;
      const fromNext = !attached && flags.nextWord.has(flag);
      if (fromNext) index += 1;
      if (flags.loads.has(flag)) {
        const named = (fromNext ? args[index]?.text : attached) ?? "";
        if (!flags.allowed(named.split("=")[0] as string)) return { code: [], problem: `loads ${named}` };
      }
      continue;
    }
    const cluster = /^-([a-zA-Z]*?)[eE](.*)$/.exec(text);
    const before = cluster ? (cluster[1] as string) : text.slice(1);
    if (/^[a-zA-Z]*i/.test(before)) return { code: [], problem: WRITES_FILES };
    if (cluster) {
      const attached = cluster[2] as string;
      const next = args[index + 1];
      if (attached) {
        code.push({ text: attached, dynamic: word.dynamic });
      } else if (next) {
        code.push(next);
        index += 1;
      }
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
    withValue: /^-([MmIFCx0D])(.*)$/,
    nextWord: new Set(["M", "m", "I"]),
    loads: new Set(["M", "m"]),
    allowed: (name) => PERL_PURE_MODULES.has(name.replace(/^-/, "")),
  });

const PERL_RULES = [
  [/`|\bqx\b|\bsystem\b(?=\s*[("'$@{\s])|\bexec\b(?=\s*[("'$@{\s])|\bfork\b/, STARTS_A_PROCESS],
  [/\b(socket|connect|IO::Socket|LWP|HTTP::Tiny|Net::)\b/, REACHES_NETWORK],
  [/\b(unlink|rename|mkdir|rmdir|chmod|chown|symlink|truncate|sysopen|utime|chroot)\b(?=\s*[("'$@{\s])|\$\^I/, WRITES_FILES],
  [/\beval\b|\brequire\b|\bdo\s+['"$]|\bsyscall\b|\bdump\b|\bkill\b/, RUNS_BUILT_CODE],
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
    withValue: /^-([rIFCxK0])(.*)$/,
    nextWord: new Set(["r", "I", "C"]),
    loads: new Set(["r"]),
    allowed: (name) => RUBY_PURE_MODULES.has(name),
  });

const RUBY_RULES = [
  [/`|%x\b|%x[^\w\s]|\b(system|exec|spawn|fork|syscall)\b|\bIO\s*\.\s*popen\b|\bOpen3\b|\bProcess\b|\bKernel\b/, STARTS_A_PROCESS],
  [/\b(Socket|TCPSocket|UDPSocket|UNIXSocket|TCPServer)\b|\bNet::|\bURI\s*\.\s*open\b|\bopen-uri\b/, REACHES_NETWORK],
  [/\bFileUtils\b|\b(File|IO)\s*\.\s*(write|binwrite|delete|unlink|rename|chmod|chown|symlink|link|truncate|mkfifo|utime)\b|\bDir\s*\.\s*(mkdir|rmdir|unlink|delete|chdir)\b/, WRITES_FILES],
  [/\b(File\s*\.\s*)?open\s*\(?\s*[^,)]+,\s*['"][^'"]*[wa+]/, WRITES_FILES],
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

function phpInline(args: CodeWord[]): Inline {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] as CodeWord;
    if (word.text === "-r") {
      const next = args[index + 1];
      return next ? { code: [next] } : NOT_INLINE;
    }
    if (word.text === "--run") {
      const next = args[index + 1];
      return next ? { code: [next] } : NOT_INLINE;
    }
    if (!word.text.startsWith("-")) return NOT_INLINE;
  }
  return NOT_INLINE;
}

const PHP_RULES = [
  [/`|\b(system|exec|shell_exec|passthru|popen|proc_open|pcntl_\w+)\s*\(/, STARTS_A_PROCESS],
  [/\b(curl_\w+|fsockopen|pfsockopen|stream_socket_\w+|socket_\w+|ftp_\w+|mail)\s*\(|\bfile_get_contents\s*\(\s*['"]\w+:\/\//, REACHES_NETWORK],
  [/\b(file_put_contents|unlink|rename|mkdir|rmdir|chmod|chown|symlink|link|copy|tempnam|touch)\s*\(|\bfopen\s*\(\s*[^,]+,\s*['"][^'"]*[waxc+]/, WRITES_FILES],
  [/\b(eval|assert|create_function|dl|include|include_once|require|require_once|call_user_func|call_user_func_array)\b|\$\w+\s*\(/, RUNS_BUILT_CODE],
] as const;

const phpProblem = (code: string): string | null => firstHit(code, PHP_RULES);

// ── awk ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

function awkInline(args: CodeWord[]): Inline {
  const code: CodeWord[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] as CodeWord;
    const { text } = word;
    if (text === "-f" || text === "--file") return { code };
    if (text === "-e" || text === "--source") {
      const next = args[index + 1];
      if (next) code.push(next);
      index += 1;
    } else if (text === "-F" || text === "-v" || text === "--assign" || text === "--field-separator") {
      index += 1;
    } else if (text === "--") {
      const program = args[index + 1];
      return program ? { code: [...code, program] } : { code };
    } else if (!text.startsWith("-")) {
      return code.length > 0 ? { code } : { code: [word] };
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

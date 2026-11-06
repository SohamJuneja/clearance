/**
 * Whether a curl or wget line really only talks to the gate. A regex over the line can't tell a request's host from
 * text that merely mentions it (`curl "https://evil.example/?u=127.0.0.1:7710"`), so this reads the arguments.
 *
 * It answers yes only when it found at least one URL, every URL's host is the gate's, and nothing on the line can send
 * the request somewhere else. Reading a flag wrongly must only ever end in a hold: a flag listed as taking a value hides
 * the next word from the URL check, so only flags that certainly take one are listed. One that isn't listed leaves its
 * value to be read as a URL, and that isn't the gate.
 */
const CURL_SHORT_WITH_VALUE = new Set("AbcCdDeEFHmoPQrtTuUwXyYz");
const CURL_LONG_WITH_VALUE = new Set([
  "--cacert",
  "--capath",
  "--cert",
  "--connect-timeout",
  "--cookie",
  "--cookie-jar",
  "--data",
  "--data-ascii",
  "--data-binary",
  "--data-raw",
  "--data-urlencode",
  "--dump-header",
  "--form",
  "--form-string",
  "--header",
  "--json",
  "--key",
  "--max-time",
  "--output",
  "--output-dir",
  "--range",
  "--referer",
  "--request",
  "--retry",
  "--retry-delay",
  "--retry-max-time",
  "--upload-file",
  "--url-query",
  "--user",
  "--user-agent",
  "--write-out",
]);
/** A config file or a proxy decides where the request really goes, and neither is on this line. */
const CURL_SHORT_REROUTES = new Set("Kx");
const CURL_LONG_REROUTES = /^--(config|proxy|preproxy|proxy1\.0|socks\S*|connect-to|resolve|doh-url|unix-socket|abstract-unix-socket|interface|dns-\S+)(=|$)/;

const WGET_SHORT_WITH_VALUE = new Set("OoaPUtTwQlARD");
const WGET_LONG_WITH_VALUE = new Set([
  "--body-data",
  "--body-file",
  "--directory-prefix",
  "--header",
  "--load-cookies",
  "--method",
  "--output-document",
  "--output-file",
  "--password",
  "--post-data",
  "--post-file",
  "--referer",
  "--save-cookies",
  "--timeout",
  "--tries",
  "--user",
  "--user-agent",
  "--wait",
]);
const WGET_SHORT_REROUTES = new Set("ie");
const WGET_LONG_REROUTES = /^--(input-file|execute|config|proxy\S*|no-proxy|bind-address|unix-socket)(=|$)/;

/** An environment that sends the request elsewhere, whatever the URL says. */
const ENV_REROUTES = /^(https?_proxy|all_proxy|ftp_proxy|HTTPS?_PROXY|ALL_PROXY|FTP_PROXY|CURL_HOME|WGETRC|CURLOPT_\w+)=/;

type Reading = { urls: string[]; reroutes: boolean };

type Dialect = {
  shortWithValue: Set<string>;
  longWithValue: Set<string>;
  shortReroutes: Set<string>;
  longReroutes: RegExp;
};

const CURL: Dialect = { shortWithValue: CURL_SHORT_WITH_VALUE, longWithValue: CURL_LONG_WITH_VALUE, shortReroutes: CURL_SHORT_REROUTES, longReroutes: CURL_LONG_REROUTES };
const WGET: Dialect = { shortWithValue: WGET_SHORT_WITH_VALUE, longWithValue: WGET_LONG_WITH_VALUE, shortReroutes: WGET_SHORT_REROUTES, longReroutes: WGET_LONG_REROUTES };

function readArguments(args: string[], dialect: Dialect): Reading {
  const urls: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] as string;
    if (word === "--") {
      urls.push(...args.slice(index + 1));
      break;
    }
    if (word.startsWith("--")) {
      if (dialect.longReroutes.test(word)) return { urls, reroutes: true };
      if (word === "--url") {
        const url = args[index + 1];
        if (url === undefined) return { urls, reroutes: true };
        urls.push(url);
        index += 1;
      } else if (word.startsWith("--url=")) {
        urls.push(word.slice("--url=".length));
      } else if (dialect.longWithValue.has(word)) {
        index += 1;
      }
      continue;
    }
    if (word.startsWith("-") && word.length > 1) {
      // A cluster like -sSL, or -sd @file where the last flag takes the value.
      for (let at = 1; at < word.length; at += 1) {
        const flag = word[at] as string;
        if (dialect.shortReroutes.has(flag)) return { urls, reroutes: true };
        if (dialect.shortWithValue.has(flag)) {
          if (at === word.length - 1) index += 1;
          break;
        }
      }
      continue;
    }
    urls.push(word);
  }
  return { urls, reroutes: false };
}

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

/** `host:port` when this is a plain http(s) URL, or null. Anything clever in the authority is not the gate. */
export function hostOf(url: string): string | null {
  const scheme = SCHEME.exec(url)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== "http" && scheme !== "https") return null;
  const afterScheme = scheme === undefined ? url : url.slice(url.indexOf("://") + 3);
  const authority = /^[^/?#]*/.exec(afterScheme)?.[0] ?? "";
  // No userinfo, no backslash tricks, no curl globs, no shell values: just a name and a port.
  if (!/^[A-Za-z0-9.-]+:\d+$/.test(authority)) return null;
  return authority.toLowerCase();
}

/** `words` is the command and its arguments, `wrappers` what came before it: `env`, assignments. */
export function fetchStaysOnGate(words: string[], wrappers: string[], gateHosts: string[]): boolean {
  if (gateHosts.length === 0 || wrappers.some((word) => ENV_REROUTES.test(word))) return false;
  const name = (words[0] ?? "").slice((words[0] ?? "").lastIndexOf("/") + 1);
  const dialect = name === "curl" ? CURL : name === "wget" ? WGET : null;
  if (!dialect) return false;
  const { urls, reroutes } = readArguments(words.slice(1), dialect);
  if (reroutes || urls.length === 0) return false;
  const gate = new Set(gateHosts.map((host) => host.toLowerCase()));
  return urls.every((url) => {
    const host = hostOf(url);
    return host !== null && gate.has(host);
  });
}

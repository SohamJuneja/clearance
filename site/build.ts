/**
 * `pnpm site:build`: the project page, with every number filled in from the results table eval/report.ts writes into README.md from the
 * result files. Nobody types a number into the page: a token it can't fill stops the build.
 *
 *   site/dist/index.html     a whole document, for any static host
 *   site/dist/artifact.html  the same page without its document skeleton, for a shareable link
 *   site/dist/media/         the screenshots, and the demo video when it's on this machine
 *
 * CLEARANCE_VIDEO_URL, once the video is uploaded, links to it. CLEARANCE_SITE_VIDEO=local ships the demo file from this machine
 * instead, for a host that takes 13 MB. With neither, the page shows the poster: the committed copy can't carry the file.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SITE, "..");
const DIST = join(SITE, "dist");
const VIDEO_FILE = join(REPO, "docs/media/raw/clearance-demo.mp4");

export interface Row {
  id: string;
  metric: string;
  baseline: string;
  clearance: string;
  data: string;
  script: string;
}

/** The results table between its markers, one row per line. */
export function readTable(markdown: string): { rows: Row[]; note: string } {
  const start = markdown.indexOf("<!-- results:start -->");
  const end = markdown.indexOf("<!-- results:end -->");
  if (start === -1 || end === -1) throw new Error("README.md has no results table between its markers");
  const lines = markdown.slice(start, end).split("\n");
  const rows = lines
    .filter((line) => line.startsWith("| ") && !line.startsWith("| ID ") && !line.startsWith("|---"))
    .map((line) => {
      const cells = line.slice(1, -1).split(" | ").map((cell) => cell.trim());
      const [id = "", metric = "", baseline = "", clearance = "", data = "", script = ""] = cells;
      return { id, metric, baseline, clearance, data, script };
    });
  const note = lines.filter((line) => line.trim() && !line.startsWith("|") && !line.startsWith("<!--")).join(" ").trim();
  return { rows, note };
}

function row(rows: Row[], id: string, metricStart: string): Row {
  const found = rows.find((one) => one.id === id && one.metric.replace(/\*/g, "").startsWith(metricStart));
  if (!found) throw new Error(`no ${id} row starting "${metricStart}" in the results table`);
  return found;
}

function pick(text: string, pattern: RegExp, what: string): string {
  const match = pattern.exec(text);
  if (!match?.[1]) throw new Error(`can't read ${what} from "${text}"`);
  return match[1];
}

const escape = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Markdown in a cell: **bold** goes, `code` stays code. */
const cell = (text: string): string => escape(text.replace(/\*\*/g, "")).replace(/`([^`]+)`/g, "<code>$1</code>");
const sentence = (text: string): string => text.replace(/;? more in RESULTS\.md$/, "").replace(/\.$/, "");

export function recordRows(rows: Row[]): string {
  return rows
    .map((one) => {
      const negative = one.id === "NEG";
      const how = negative ? one.data : `${one.data}${one.data && one.script ? ". " : ""}${one.script}`;
      return `              <tr${negative ? ' class="neg"' : ""}><td>${cell(one.id)}</td><td>${cell(one.metric)}</td><td>${cell(one.baseline || "n/a")}</td><td class="num">${cell(one.clearance || one.metric)}</td><td class="data">${cell(how)}</td></tr>`;
    })
    .join("\n");
}

function video(url: string | undefined, local: boolean): string {
  if (url) {
    return `<a class="poster-link" href="${escape(url)}" target="_blank" rel="noopener"><img src="media/poster.webp" width="1280" height="720" alt="The demo's opening refusal. Watch the whole demo on its page." loading="lazy"></a>`;
  }
  if (local) {
    return `<video controls playsinline preload="metadata" poster="media/poster.webp" width="1280" height="720"><source src="media/clearance-demo.mp4" type="video/mp4">Your browser can't play this video.</video>`;
  }
  return `<img src="media/poster.webp" width="1280" height="720" alt="The demo's opening refusal." loading="lazy">`;
}

export function tokens(results: string, repoUrl: string, videoHtml: string): Record<string, string> {
  const { rows, note } = readTable(results);
  const risky = row(rows, "E2", "Risky actions executed");
  const e1 = row(rows, "E1", "Bad outcomes prevented");
  const soak = row(rows, "E4", "Soak invariant violations");
  return {
    REPO_URL: repoUrl,
    CLAUDE_RISKY_BEFORE: pick(risky.baseline, /Claude (\d+)/, "Claude's risky runs without Clearance"),
    CLAUDE_RISKY_AFTER: pick(risky.clearance, /Claude (\d+)/, "Claude's risky runs with Clearance"),
    RISKY_OF: pick(risky.metric, /\(of (\d+)/, "how many risky runs per vendor"),
    RISKY_DATA: escape(sentence(risky.data)),
    E1_PREVENTED: pick(e1.clearance, /^(\d+)$/, "E1's prevented count"),
    E1_OF: pick(e1.metric, /\(of (\d+)\)/, "E1's case count"),
    E1_DATA: escape(sentence(e1.data)),
    SOAK: pick(soak.clearance, /^(\d+)$/, "the soak's violations"),
    SOAK_DATA: escape(sentence(soak.data)),
    RECORD_ROWS: recordRows(rows),
    RECORD_NOTE: escape(note),
    VIDEO: videoHtml,
  };
}

export function fill(template: string, values: Record<string, string>): string {
  const out = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (whole, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error(`the page names {{${name}}}, and nothing fills it`);
    return values[name] as string;
  });
  return out;
}

function main(): void {
  const template = readFileSync(join(SITE, "page.html"), "utf8");
  // eval/report.ts writes the same table into the README, between these markers.
  const results = readFileSync(join(REPO, "README.md"), "utf8");
  const repoUrl = (process.env.CLEARANCE_REPO_URL ?? "https://github.com/SohamJuneja/clearance").replace(/\/$/, "");
  const videoUrl = process.env.CLEARANCE_VIDEO_URL?.trim() || undefined;
  const local = !videoUrl && process.env.CLEARANCE_SITE_VIDEO === "local" && existsSync(VIDEO_FILE);
  const page = fill(template, tokens(results, repoUrl, video(videoUrl, local)));

  mkdirSync(join(DIST, "media"), { recursive: true });
  for (const name of readdirSync(join(SITE, "media"))) copyFileSync(join(SITE, "media", name), join(DIST, "media", name));
  if (local) copyFileSync(VIDEO_FILE, join(DIST, "media/clearance-demo.mp4"));

  writeFileSync(join(DIST, "artifact.html"), page);
  const [head, body] = page.split("<!-- body -->");
  if (body === undefined) throw new Error("site/page.html has no <!-- body --> marker");
  writeFileSync(
    join(DIST, "index.html"),
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${head.trim()}\n</head>\n<body>\n${body.trim()}\n</body>\n</html>\n`,
  );
  process.stdout.write(`wrote site/dist/index.html and site/dist/artifact.html${local ? ", with the demo video" : ""}${videoUrl ? `, linking the video at ${videoUrl}` : ""}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

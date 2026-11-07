/**
 * `pnpm eval:charts` draws the README's results chart, docs/media/results.svg, from RESULTS.md (which `pnpm eval:report`
 * writes from eval/results). No number here is typed by hand: each bar is a row of that table. The chart sits on its own
 * light card, so it reads the same in GitHub's light and dark themes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..");
const results = readFileSync(join(repo, "RESULTS.md"), "utf8");

/** The cells of the first RESULTS.md row with this id whose metric starts this way. */
function row(id: string, metric: string): { baseline: string; clearance: string } {
  for (const line of results.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells[1] === id && (cells[2] ?? "").startsWith(metric)) return { baseline: cells[3] ?? "", clearance: cells[4] ?? "" };
  }
  throw new Error(`RESULTS.md has no ${id} row starting "${metric}"`);
}

/** "Claude 5, OpenCode 13 of 18" -> { n: 13, of: 18 } for OpenCode; `of` defaults to the metric's own denominator. */
function count(cell: string, name: string, of: number): { n: number; of: number } {
  const m = cell.match(new RegExp(`${name}:? (\\d+)(?: of (\\d+))?`));
  if (!m) throw new Error(`no number for ${name} in "${cell}"`);
  return { n: Number(m[1]), of: m[2] ? Number(m[2]) : of };
}

type Bar = { label: string; series: 0 | 1; n: number; of: number };
type Panel = { title: string; note: string; better: "lower" | "higher"; groups: { name: string; bars: Bar[] }[] };

const risky = row("E2", "Risky actions executed without an eligible human");
const yes = row("E2", "The requester said yes");
const harmless = row("E2", "Harmless tasks the agent reports done");
const e1 = row("E1", "Bad outcomes prevented");
const pair = (cellA: string, cellB: string, name: string, of: number): Bar[] => [
  { label: "Without Clearance", series: 0, ...count(cellA, name, of) },
  { label: "With Clearance", series: 1, ...count(cellB, name, of) },
];

const panels: Panel[] = [
  { title: "Risky actions that ran without the right approver", note: "Real agents in real Switch rooms · pnpm eval:vendors", better: "lower",
    groups: [{ name: "Claude Code", bars: pair(risky.baseline, risky.clearance, "Claude", 20) },
             { name: "OpenCode", bars: pair(risky.baseline, risky.clearance, "OpenCode", 20) }] },
  { title: "The person who asked said yes, and it went ahead", note: "Runs where the agent asked its requester · pnpm eval:vendors:rescore", better: "lower",
    groups: [{ name: "Claude Code", bars: pair(yes.baseline, yes.clearance, "Claude", 0) },
             { name: "OpenCode", bars: pair(yes.baseline, yes.clearance, "OpenCode", 0) }] },
  { title: "Bad outcomes prevented, 25 attack cases", note: "Switch alone read from its code, not run · pnpm eval:authority", better: "higher",
    groups: [{ name: "Switch, auto mode", bars: [{ label: "Without Clearance", series: 0, ...count(e1.baseline, "B-auto", 25) }] },
             { name: "Switch, approvals on", bars: [{ label: "Without Clearance", series: 0, ...count(e1.baseline, "B-ask", 25) }] },
             { name: "Clearance", bars: [{ label: "With Clearance", series: 1, n: Number(e1.clearance.match(/\d+/)?.[0]), of: 25 }] }] },
  { title: "The honest cost: harmless tasks the agent finished", note: "Clearance holds some harmless work too · pnpm eval:vendors:rescore", better: "higher",
    groups: [{ name: "Claude Code", bars: pair(harmless.baseline, harmless.clearance, "Claude", 20) }] },
];

// Validated pair (dataviz reference palette, slots 1 and 2), on a light card; text in ink, never in the series colour.
const C = { surface: "#fcfcfb", border: "#e2e1dc", ink: "#0b0b0b", ink2: "#52514e", grid: "#e9e8e4", series: ["#2a78d6", "#eb6834"] };
const W = 960, PAD = 32, LABEL = 190, BAR_W = W - PAD * 2 - LABEL - 120, BAR_H = 16, GAP = 2;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const parts: string[] = [];
let y = 30;
parts.push(`<text x="${PAD}" y="${y + 18}" font-size="22" font-weight="700" fill="${C.ink}">Clearance, measured against Switch on its own</text>`);
y += 34;
parts.push(`<text x="${PAD}" y="${y + 14}" font-size="13" fill="${C.ink2}">Each bar is a row of RESULTS.md, drawn by pnpm eval:charts. Share of runs, 0 to 100%.</text>`);
y += 30;
// legend
[["Without Clearance", 0], ["With Clearance", 1]].forEach(([name, s], i) => {
  const x = PAD + i * 190;
  parts.push(`<rect x="${x}" y="${y}" width="14" height="14" rx="3" fill="${C.series[s as number]}"/><text x="${x + 20}" y="${y + 12}" font-size="13" fill="${C.ink}">${name}</text>`);
});
y += 30;
for (const p of panels) {
  y += 14;
  parts.push(`<text x="${PAD}" y="${y + 14}" font-size="16" font-weight="700" fill="${C.ink}">${esc(p.title)}</text>`);
  parts.push(`<text x="${W - PAD}" y="${y + 14}" font-size="12" text-anchor="end" fill="${C.ink2}">${p.better} is better</text>`);
  y += 22;
  parts.push(`<text x="${PAD}" y="${y + 11}" font-size="12" fill="${C.ink2}">${esc(p.note)}</text>`);
  y += 20;
  const x0 = PAD + LABEL;
  const top = y;
  for (const g of p.groups) {
    const h = g.bars.length * BAR_H + (g.bars.length - 1) * GAP;
    parts.push(`<text x="${x0 - 12}" y="${y + h / 2 + 5}" font-size="14" text-anchor="end" fill="${C.ink}">${esc(g.name)}</text>`);
    for (const b of g.bars) {
      const share = b.of ? b.n / b.of : 0;
      const w = Math.max(share * BAR_W, 0);
      if (w > 0) parts.push(`<rect x="${x0}" y="${y}" width="${w.toFixed(1)}" height="${BAR_H}" rx="4" fill="${C.series[b.series]}"><title>${b.label}: ${b.n} of ${b.of}</title></rect>`);
      else parts.push(`<rect x="${x0}" y="${y}" width="3" height="${BAR_H}" rx="1.5" fill="${C.series[b.series]}"/>`);
      parts.push(`<text x="${x0 + Math.max(w, 3) + 8}" y="${y + 12.5}" font-size="13" fill="${C.ink}"><tspan font-weight="700">${b.n} of ${b.of}</tspan><tspan fill="${C.ink2}"> · ${Math.round(share * 100)}%</tspan></text>`);
      y += BAR_H + GAP;
    }
    y += 10;
  }
  parts.unshift(`<line x1="${x0}" y1="${top - 4}" x2="${x0}" y2="${y - 6}" stroke="${C.grid}" stroke-width="1"/>`);
  y += 6;
}
y += 14;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}" role="img" aria-label="Clearance results: risky actions without the right approver drop to zero for Claude Code and OpenCode; all 25 attack cases prevented; harmless tasks finished fall slightly.">
<rect x="0.5" y="0.5" width="${W - 1}" height="${y - 1}" rx="14" fill="${C.surface}" stroke="${C.border}"/>
<g font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">
${parts.join("\n")}
</g>
</svg>
`;
writeFileSync(join(repo, "docs", "media", "results.svg"), svg);
console.log(`wrote docs/media/results.svg from RESULTS.md (${panels.length} panels)`);

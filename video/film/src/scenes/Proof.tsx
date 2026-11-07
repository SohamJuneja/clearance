import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { T } from "../theme";
import { OUT, pop, ramp } from "../lib/anim";

/** The number that wins: ours vs a NAMED baseline, measured on held-out data, with how it was measured in the footnote.
 *  Baselines draw first, ours last and in the accent; the delta badge lands on a beat (put an SFX hit on it). */
export const Proof: React.FC<{ title: string; metric: string; unit?: string; better: "higher" | "lower";
  rows: { label: string; value: number; ours?: boolean; note?: string }[]; footnote?: string; dur: number }> = ({
  title, metric, unit = "", better, rows, footnote, dur,
}) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const max = Math.max(...rows.map((r) => r.value)) * 1.08;
  const ordered = [...rows.filter((r) => !r.ours), ...rows.filter((r) => r.ours)];
  const ours = rows.find((r) => r.ours);
  const base = rows.filter((r) => !r.ours).sort((a, b) => (better === "higher" ? b.value - a.value : a.value - b.value))[0];
  const ratio = ours && base ? (better === "higher" ? ours.value / base.value : base.value / ours.value) : 0;
  const pct = ours && base ? Math.abs((ours.value - base.value) / base.value) * 100 : 0;
  const wins = ratio > 1; // never print a win badge for a result that doesn't win
  const badge = ratio >= 2 ? (better === "higher" ? `${ratio.toFixed(1)}× higher` : `${ratio.toFixed(1)}× lower`)
    : `${better === "higher" ? "+" : "−"}${pct.toFixed(0)}%`;
  const step = Math.round(fps * 0.45);
  const badgeAt = 12 + ordered.length * step + Math.round(fps * 0.5);
  const dec = (v: number) => (String(v).split(".")[1] ?? "").length;
  const fmt = (v: number, final: number) => v.toFixed(Math.min(2, dec(final)));
  const out = 1 - ramp(f, dur - 10, 10);
  return (
    <AbsoluteFill style={{ padding: `${T.safeY + 10}px ${T.safeX + 40}px`, opacity: out }}>
      <div style={{ fontFamily: T.font, fontWeight: 650, fontSize: T.h2, color: T.fg, letterSpacing: -1.5, opacity: ramp(f, 0, 12) }}>{title}</div>
      <div style={{ fontFamily: T.monoFont, fontSize: T.label, color: T.muted, marginTop: 10, letterSpacing: 1.5, textTransform: "uppercase",
        opacity: ramp(f, 6, 12) }}>{metric} · {better} is better</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 34, marginTop: 70 }}>
        {ordered.map((r, i) => {
          const s = 12 + i * step;
          const g = ramp(f, s, Math.round(fps * 0.9), OUT);
          return (
            <div key={r.label} style={{ display: "flex", alignItems: "center", gap: 30, opacity: ramp(f, s, 8) }}>
              <div style={{ width: 380, textAlign: "right", fontFamily: T.font, fontSize: T.small + 2, fontWeight: r.ours ? 700 : 500,
                color: r.ours ? T.fg : T.muted }}>{r.label}</div>
              <div style={{ flex: 1, height: 64, background: `${T.fg}0d`, borderRadius: 14, overflow: "hidden" }}>
                <div style={{ width: `${(r.value / max) * 100 * g}%`, height: "100%", borderRadius: 14,
                  background: r.ours ? `linear-gradient(90deg, ${T.accent}, ${T.accent2})` : `${T.fg}40`,
                  boxShadow: r.ours ? `0 0 40px ${T.accent}66` : undefined }} />
              </div>
              <div style={{ width: 230, fontFamily: T.font, fontWeight: 700, fontSize: T.h3 - 4, color: r.ours ? T.fg : T.muted,
                fontVariantNumeric: "tabular-nums" }}>{fmt(r.value * g, r.value)}{unit}</div>
            </div>
          );
        })}
      </div>
      {ours && base && wins && (
        <div style={{ alignSelf: "flex-start", marginTop: 56, transformOrigin: "0 50%", scale: `${pop(f, fps, badgeAt, 10)}`,
          fontFamily: T.font, fontWeight: 750, fontSize: T.h3, color: T.bg, background: T.good, padding: "14px 30px", borderRadius: 999,
          boxShadow: `0 20px 60px ${T.good}55` }}>
          {badge} vs {base.label}
        </div>
      )}
      {footnote && <div style={{ position: "absolute", left: T.safeX + 40, bottom: T.safeY, fontFamily: T.monoFont, fontSize: 26,
        color: T.muted, opacity: ramp(f, badgeAt, 14) }}>{footnote}</div>}
    </AbsoluteFill>
  );
};

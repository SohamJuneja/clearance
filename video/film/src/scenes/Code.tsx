import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { T } from "../theme";
import { ramp } from "../lib/anim";

const KW = /\b(const|let|var|function|return|await|async|import|from|export|if|else|for|while|class|new|def|with|as|yield|try|except|catch|in|of|type|interface|fn|pub|use|struct|impl|match)\b/g;

/** The few lines that matter (the sponsor API call, the guard, the eval), typed in, then highlighted range by range.
 *  ≤ 18 lines, ≥ 30px. Code is evidence, not decoration: pick lines a judge can read in the time on screen. */
export const Code: React.FC<{ title?: string; file?: string; code: string; highlight?: number[][]; dur: number }> = ({
  title, file, code, highlight = [], dur,
}) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const lines = code.replace(/\n$/, "").split("\n");
  const typeEnd = Math.min(Math.round(dur * 0.4), Math.round(fps * 0.06 * lines.length * 6));
  const shown = ramp(f, 8, Math.max(10, typeEnd), (t) => t) * lines.length;
  const hlSlot = (dur - typeEnd - 20) / Math.max(1, highlight.length);
  const active = highlight.findIndex((_, i) => f >= typeEnd + 10 + i * hlSlot && f < typeEnd + 10 + (i + 1) * hlSlot);
  const range = active >= 0 ? highlight[active] : null;
  const out = 1 - ramp(f, dur - 10, 10);
  const paint = (l: string) => {
    const parts: React.ReactNode[] = [];
    const strRe = /(["'`])(?:\\.|(?!\1).)*\1|\/\/.*$|#.*$|\b\d+(\.\d+)?\b/g;
    let last = 0, m: RegExpExecArray | null;
    while ((m = strRe.exec(l))) {
      parts.push(...kw(l.slice(last, m.index), parts.length));
      const s = m[0];
      const color = s.startsWith("//") || s.startsWith("#") ? T.muted : /^\d/.test(s) ? T.accent2 : "#a5e07a";
      parts.push(<span key={`s${parts.length}`} style={{ color, fontStyle: color === T.muted ? "italic" : undefined }}>{s}</span>);
      last = m.index + s.length;
    }
    parts.push(...kw(l.slice(last), parts.length));
    return parts;
  };
  const kw = (s: string, k: number) => s.split(KW).map((p, i) => (i % 2 ? <span key={`k${k}-${i}`} style={{ color: T.accent }}>{p}</span> : p));
  return (
    <AbsoluteFill style={{ padding: `${T.safeY}px ${T.safeX}px`, opacity: out }}>
      {title && <div style={{ fontFamily: T.font, fontWeight: 650, fontSize: T.h3, color: T.fg, marginBottom: 30, opacity: ramp(f, 0, 12) }}>{title}</div>}
      <div style={{ flex: 1, background: T.surface, borderRadius: 20, overflow: "hidden", boxShadow: `0 40px 100px rgba(0,0,0,.5), 0 0 0 1px ${T.fg}14`,
        opacity: ramp(f, 0, 10), translate: `0 ${(1 - ramp(f, 0, 16)) * 30}px` }}>
        {file && <div style={{ fontFamily: T.monoFont, fontSize: 26, color: T.muted, padding: "16px 28px", borderBottom: `1px solid ${T.fg}12` }}>{file}</div>}
        <div style={{ padding: "26px 0", fontFamily: T.monoFont, fontSize: lines.length > 14 ? 30 : 34, lineHeight: 1.55 }}>
          {lines.map((l, i) => {
            const vis = Math.max(0, Math.min(1, shown - i));
            if (vis <= 0) return null;
            const on = range ? i + 1 >= range[0] && i + 1 <= range[1] : true;
            return (
              <div key={i} style={{ display: "flex", padding: "0 28px", background: range && on ? `${T.accent}1f` : undefined,
                borderLeft: `4px solid ${range && on ? T.accent : "transparent"}`, opacity: range && !on ? 0.32 : 1 }}>
                <span style={{ width: 60, color: `${T.muted}99`, textAlign: "right", marginRight: 28, flexShrink: 0 }}>{i + 1}</span>
                <span style={{ color: T.fg, whiteSpace: "pre", clipPath: `inset(0 ${(1 - vis) * 100}% 0 0)` }}>{paint(l)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { T } from "../theme";
import { pop, ramp } from "../lib/anim";

type N = { id: string; label: string; sub?: string; x: number; y: number; hero?: boolean; icon?: string };

/** How it works, as motion: nodes pop in the order data flows, edges draw, packets travel.
 *  Mark the sponsor's tech `hero` so it glows: it is the reason the system works. ≤ 7 nodes. */
export const Diagram: React.FC<{ title?: string; nodes: N[]; edges: { from: string; to: string; label?: string }[]; order?: string[]; dur: number }> = ({
  title, nodes, edges, order, dur,
}) => {
  const f = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const seq = order ?? nodes.map((n) => n.id);
  const gap = Math.max(8, Math.min(Math.round(fps * 0.55), Math.floor((dur * 0.55) / seq.length)));
  const top = title ? 200 : 120;
  const mx = T.safeX + 190; // keep node boxes (≈ 380px wide) inside the safe area
  const pos = (n: N) => [mx + n.x * (W - 2 * mx), top + 70 + n.y * (H - top - 230)];
  const at = (id: string) => 10 + seq.indexOf(id) * gap;
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const out = 1 - ramp(f, dur - 10, 10);
  return (
    <AbsoluteFill style={{ opacity: out }}>
      {title && <div style={{ position: "absolute", left: T.safeX, top: 70, fontFamily: T.font, fontWeight: 650, fontSize: T.h2,
        color: T.fg, letterSpacing: -1.5, opacity: ramp(f, 0, 12) }}>{title}</div>}
      <svg width={W} height={H} style={{ position: "absolute" }}>
        <defs>
          <filter id="glow"><feGaussianBlur stdDeviation="6" /></filter>
        </defs>
        {edges.map((e, i) => {
          const a = byId[e.from], b = byId[e.to];
          if (!a || !b) return null;
          const [x1, y1] = pos(a), [x2, y2] = pos(b);
          const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - Math.abs(x2 - x1) * 0.08;
          const d = `M${x1},${y1} Q${mx},${my} ${x2},${y2}`;
          const s = Math.max(at(e.from), at(e.to)) + 6;
          const draw = ramp(f, s, Math.round(fps * 0.5));
          const len = Math.hypot(x2 - x1, y2 - y1) * 1.05;
          const period = Math.round(fps * 1.6);
          const t = ((f - s - fps * 0.5 + i * 7) % period) / period;
          const px = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * mx + t * t * x2;
          const py = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * my + t * t * y2;
          return (
            <g key={i}>
              <path d={d} fill="none" stroke={`${T.fg}55`} strokeWidth={3} strokeDasharray={len} strokeDashoffset={len * (1 - draw)} />
              {draw >= 1 && f > s + fps * 0.5 && (
                <>
                  <circle cx={px} cy={py} r={11} fill={T.accent} filter="url(#glow)" opacity={0.9} />
                  <circle cx={px} cy={py} r={6} fill={T.fg} />
                </>
              )}
            </g>
          );
        })}
      </svg>
      {nodes.map((n) => {
        const [x, y] = pos(n);
        const p = pop(f, fps, at(n.id));
        const glow = n.hero ? 0.5 + 0.5 * Math.sin(f / 9) : 0;
        return (
          <div key={n.id} style={{ position: "absolute", left: x, top: y, translate: "-50% -50%", scale: `${p}`, opacity: Math.min(1, p * 1.5),
            background: n.hero ? `linear-gradient(135deg, ${T.accent}, ${T.accent2})` : T.surface, color: n.hero ? T.bg : T.fg,
            border: `1.5px solid ${n.hero ? "transparent" : T.fg + "26"}`, borderRadius: 22, padding: "24px 34px", minWidth: 260,
            textAlign: "center", fontFamily: T.font, boxShadow: n.hero ? `0 0 ${40 + glow * 40}px ${T.accent}88` : "0 20px 50px rgba(0,0,0,.35)" }}>
            {n.icon && <Img src={staticFile(n.icon)} style={{ height: 54, marginBottom: 10 }} />}
            <div style={{ fontSize: T.body - 2, fontWeight: 650, whiteSpace: "nowrap" }}>{n.label}</div>
            {n.sub && <div style={{ fontSize: T.label, whiteSpace: "nowrap", opacity: 0.75, marginTop: 4, fontFamily: T.monoFont }}>{n.sub}</div>}
          </div>
        );
      })}
      {edges.map((e, i) => {
        const a = byId[e.from], b = byId[e.to];
        if (!a || !b || !e.label) return null;
        const [x1, y1] = pos(a), [x2, y2] = pos(b);
        const s = Math.max(at(e.from), at(e.to)) + 6;
        return (
          <div key={`l${i}`} style={{ position: "absolute", left: (x1 + x2) / 2, top: (y1 + y2) / 2 - Math.abs(x2 - x1) * 0.04 - 58,
            translate: "-50% 0", fontFamily: T.monoFont, fontSize: 26, color: T.fg, background: T.bg, border: `1px solid ${T.fg}22`,
            padding: "4px 12px", borderRadius: 8, opacity: ramp(f, s + 8, 10), whiteSpace: "nowrap" }}>{e.label}</div>
        );
      })}
    </AbsoluteFill>
  );
};

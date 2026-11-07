import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { T } from "../theme";
import { pop, ramp } from "../lib/anim";

/** Last 5–10% of the film: the name lands (performed, not faded), the one-line claim, then where to try it.
 *  Hold the links ≥ 3 s so judges can read them. */
export const EndCard: React.FC<{ name: string; tagline: string; links: string[]; logo?: string; dur: number }> = ({ name, tagline, links, logo }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = pop(f, fps, 4, 11);
  const wipe = ramp(f, 10, Math.round(fps * 0.6));
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", gap: 34 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 34 }}>
        {logo && <Img src={staticFile(logo)} style={{ height: 150, scale: `${p}`, rotate: `${(1 - p) * -20}deg` }} />}
        <div style={{ fontFamily: T.font, fontWeight: 750, fontSize: T.h1 * 1.15, color: T.fg, letterSpacing: -4,
          clipPath: `inset(0 ${(1 - wipe) * 100}% 0 0)` }}>{name}</div>
      </div>
      <div style={{ fontFamily: T.font, fontSize: T.h3 - 6, color: T.muted, opacity: ramp(f, Math.round(fps * 0.8), 14) }}>{tagline}</div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, marginTop: 30 }}>
        {links.map((l, i) => (
          <div key={l} style={{ fontFamily: T.monoFont, fontSize: T.small + 2, color: T.fg, background: `${T.fg}0f`, border: `1px solid ${T.fg}1f`,
            padding: "12px 26px", borderRadius: 14, opacity: ramp(f, Math.round(fps * 1.1) + i * 6, 12),
            translate: `0 ${(1 - ramp(f, Math.round(fps * 1.1) + i * 6, 14)) * 16}px` }}>{l}</div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

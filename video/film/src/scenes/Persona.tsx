import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { T } from "../theme";
import { pop, ramp } from "../lib/anim";

/** The real person and what they lose today. Name, role, one quote, the stakes in one line, one number.
 *  If there is no real photo, the initial-avatar is honest; never a stock face presented as a user. */
export const Persona: React.FC<{ name: string; role: string; quote?: string; stakes: string; stat?: { value: string; label: string }; photo?: string; dur: number }> = ({
  name, role, quote, stakes, stat, photo, dur,
}) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const out = 1 - ramp(f, dur - 10, 10);
  const chars = quote ? Math.floor(ramp(f, 16, Math.max(20, quote.length * 1.1), (t) => t) * quote.length) : 0;
  const p = pop(f, fps, 0);
  return (
    <AbsoluteFill style={{ flexDirection: "row", alignItems: "center", padding: `0 ${T.safeX * 1.4}px`, gap: 90, opacity: out }}>
      <div style={{ width: 380, height: 380, borderRadius: 999, overflow: "hidden", flexShrink: 0, scale: `${0.8 + 0.2 * p}`,
        boxShadow: `0 0 0 6px ${T.bg}, 0 0 0 9px ${T.accent}88, 0 30px 80px rgba(0,0,0,.5)`, background: `linear-gradient(135deg, ${T.accent}, ${T.accent2})`,
        display: "flex", alignItems: "center", justifyContent: "center" }}>
        {photo ? <Img src={staticFile(photo)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          : <span style={{ fontFamily: T.font, fontWeight: 700, fontSize: 170, color: T.bg }}>{name[0]}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 26, maxWidth: 1100 }}>
        <div style={{ opacity: ramp(f, 4, 12) }}>
          <div style={{ fontFamily: T.font, fontWeight: 650, fontSize: T.h3, color: T.fg }}>{name}</div>
          <div style={{ fontFamily: T.monoFont, fontSize: T.label, color: T.muted, letterSpacing: 2, textTransform: "uppercase", marginTop: 6 }}>{role}</div>
        </div>
        {quote && (
          <div style={{ fontFamily: T.font, fontSize: T.body + 4, color: T.fg, lineHeight: 1.35, fontStyle: "italic",
            borderLeft: `5px solid ${T.accent}`, paddingLeft: 26 }}>
            “{quote.slice(0, chars)}{chars < quote.length ? <span style={{ opacity: f % 16 < 8 ? 1 : 0 }}>▍</span> : "”"}
          </div>
        )}
        <div style={{ fontFamily: T.font, fontWeight: 650, fontSize: T.h3 + 4, color: T.fg, lineHeight: 1.15, letterSpacing: -1,
          opacity: ramp(f, Math.round(fps * 1.6), 14), translate: `0 ${(1 - ramp(f, Math.round(fps * 1.6), 18)) * 24}px` }}>
          {stakes}
        </div>
        {stat && (
          <div style={{ display: "flex", alignItems: "baseline", gap: 18, opacity: ramp(f, Math.round(fps * 2.4), 12) }}>
            <span style={{ fontFamily: T.font, fontWeight: 700, fontSize: T.h2, color: T.bad }}>{stat.value}</span>
            <span style={{ fontFamily: T.font, fontSize: T.small, color: T.muted }}>{stat.label}</span>
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

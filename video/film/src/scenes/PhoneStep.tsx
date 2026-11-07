import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Video } from "@remotion/media";
import { T } from "../theme";
import { OUT, interp, ramp } from "../lib/anim";

/** A real phone recording (or screenshot) in a phone frame beside a numbered step: kicker, title, one line.
 *  For mobile products and step-by-step flows (inspiration.md #6). The phone floats in, the text builds with the voice. */
export const PhoneStep: React.FC<{ src: string; step?: string; title: string; body?: string; side?: "left" | "right"; dur: number }> = ({
  src, step, title, body, side = "right", dur,
}) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = ramp(f, 0, Math.round(fps * 0.7), OUT);
  const float = Math.sin(f / 40) * 6;
  const out = 1 - ramp(f, dur - 10, 10);
  const isVideo = /\.(mp4|webm|mov)$/i.test(src);
  const phone = (
    <div style={{ width: 430, height: 880, borderRadius: 64, background: "#0d0f13", padding: 16, flexShrink: 0,
      boxShadow: `0 60px 120px rgba(0,0,0,.45), 0 0 0 2px ${T.fg}22`, translate: `0 ${(1 - enter) * 120 + float}px`,
      rotate: `${interp(f, [0, dur], [side === "right" ? -3 : 3, 0])}deg`, opacity: enter }}>
      <div style={{ width: "100%", height: "100%", borderRadius: 50, overflow: "hidden", background: "#000" }}>
        {isVideo ? <Video src={staticFile(src)} muted objectFit="cover" style={{ width: "100%", height: "100%" }} />
          : <Img src={staticFile(src)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
      </div>
    </div>
  );
  const text = (
    <div style={{ maxWidth: 760, display: "flex", flexDirection: "column", gap: 22 }}>
      {step && <div style={{ fontFamily: T.monoFont, fontSize: T.label + 2, letterSpacing: 4, textTransform: "uppercase", color: T.accent,
        opacity: ramp(f, 8, 10) }}>{step}</div>}
      <div style={{ fontFamily: T.font, fontWeight: 700, fontSize: T.h2, color: T.fg, letterSpacing: -2, lineHeight: 1.05,
        opacity: ramp(f, 12, 12), translate: `0 ${(1 - ramp(f, 12, 16)) * 12}px` }}>{title}</div>
      {body && <div style={{ fontFamily: T.font, fontSize: T.body, color: T.muted, lineHeight: 1.35, opacity: ramp(f, 24, 12) }}>{body}</div>}
    </div>
  );
  return (
    <AbsoluteFill style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 140, opacity: out }}>
      {side === "left" ? <>{phone}{text}</> : <>{text}{phone}</>}
    </AbsoluteFill>
  );
};

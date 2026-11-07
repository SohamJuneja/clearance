import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { T } from "../theme";

/** Ledger stock: blue rules drifting slowly up the page, the red margin rule, paper tooth. Calm behind text, never still. */
export const Backdrop: React.FC<{ dim?: number }> = ({ dim = 0 }) => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: T.paper }}>
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(transparent 53px, ${T.rule}66 54px)`,
          backgroundSize: "100% 54px",
          backgroundPosition: `0 ${-(f * 0.35) % 54}px`,
          maskImage: "linear-gradient(90deg, transparent 0%, black 12%, black 88%, transparent 100%)",
        }}
      />
      <div style={{ position: "absolute", top: 0, bottom: 0, left: 132, width: 2, background: T.margin, opacity: 0.55 }} />
      <div style={{ position: "absolute", top: 0, bottom: 0, left: 140, width: 1, background: T.margin, opacity: 0.35 }} />
      <AbsoluteFill style={{ opacity: 0.22, mixBlendMode: "multiply" }}>
        <svg width="100%" height="100%">
          <filter id="tooth">
            <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed={Math.floor(f / 3) % 6} />
            <feColorMatrix values="0 0 0 0 0.45  0 0 0 0 0.45  0 0 0 0 0.42  0 0 0 0.35 0" />
          </filter>
          <rect width="100%" height="100%" filter="url(#tooth)" />
        </svg>
      </AbsoluteFill>
      {dim > 0 && <AbsoluteFill style={{ backgroundColor: `rgba(27,30,35,${dim * 0.35})` }} />}
    </AbsoluteFill>
  );
};

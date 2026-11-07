import React from "react";
import { AbsoluteFill } from "remotion";
import { T } from "./theme";
import { Backdrop } from "./components/Backdrop";
import { Stamp } from "./components/Stamp";

/** The thumbnail: the name, the one rule, and the stamp that enforces it. Readable at 320px wide. */
export const Thumbnail: React.FC = () => (
  <AbsoluteFill>
    <Backdrop />
    <div style={{ position: "absolute", left: 110, top: 165, width: 660 }}>
      <div style={{ fontFamily: T.monoFont, fontSize: 30, letterSpacing: 4, color: T.violet, fontWeight: 600 }}>BUILT ON SWITCH</div>
      <div style={{ fontFamily: T.font, fontWeight: 900, fontSize: 122, letterSpacing: -5, lineHeight: 0.95, color: T.ink, marginTop: 14 }}>Clearance</div>
      <div style={{ fontFamily: T.font, fontWeight: 800, fontSize: 58, lineHeight: 1.05, letterSpacing: -1.5, color: T.ink, marginTop: 26 }}>
        Whoever asks <span style={{ color: T.red }}>can't</span> approve.
      </div>
    </div>
    <div style={{ position: "absolute", right: 70, top: 175, width: 400, background: T.white, border: `2px solid ${T.ink}33`, padding: "26px 28px 30px",
      boxShadow: `14px 14px 0 ${T.canary}, 28px 28px 0 ${T.pink}`, rotate: "2deg" }}>
      <div style={{ display: "flex", justifyContent: "space-between", borderBottom: `3px solid ${T.ink}`, paddingBottom: 10, fontFamily: T.monoFont,
        fontWeight: 600, fontSize: 26 }}>
        <span>CLR-0001</span><span style={{ fontFamily: T.font, fontWeight: 900 }}>₹4,000</span>
      </div>
      {[["Asked by", "Priya"], ["Approve", "Priya ✓"], ["Decides", "Sam"]].map(([k, v]) => (
        <div key={k} style={{ display: "flex", gap: 18, padding: "12px 0", borderBottom: `1.5px solid ${T.rule}`, fontSize: 28, fontFamily: T.font }}>
          <span style={{ fontFamily: T.monoFont, fontSize: 18, letterSpacing: 1.5, color: T.inkSoft, width: 120, paddingTop: 6 }}>{k.toUpperCase()}</span>
          <span>{v}</span>
        </div>
      ))}
      <div style={{ position: "absolute", left: 40, top: 150 }}>
        <Stamp text="REQUESTER" sub="CAN'T APPROVE" w={400} rot={-11} t={30} seed={4} />
      </div>
    </div>
  </AbsoluteFill>
);

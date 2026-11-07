import React, { useEffect, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, Img, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Lottie, type LottieAnimationData } from "@remotion/lottie";
import { Gif } from "@remotion/gif";
import { Video } from "@remotion/media";
import type { Overlay } from "../film";
import { T } from "../theme";
import { envelope, pop } from "../lib/anim";
import { Stamp } from "./Stamp";

/** Timed accents on top of any scene: Lottie (LottieFiles free license), GIF, image, a label chip, or a drawn arrow.
 *  x/y are 0..1 of the frame; w is px. One accent at a time; they punctuate a beat, they don't decorate. */
export const Overlays: React.FC<{ items: Overlay[] }> = ({ items }) => {
  const { fps } = useVideoConfig();
  return (
    <>
      {items.map((o, i) => (
        <Sequence key={i} from={Math.round(o.at * fps)} durationInFrames={Math.max(1, Math.round(o.dur * fps))} layout="none">
          <One o={o} />
        </Sequence>
      ))}
    </>
  );
};

const LottieAt: React.FC<{ src: string; loop?: boolean; style: React.CSSProperties }> = ({ src, loop, style }) => {
  const [data, setData] = useState<LottieAnimationData | null>(null);
  const [h] = useState(() => delayRender("lottie " + src));
  useEffect(() => {
    fetch(staticFile(src)).then((r) => r.json()).then((j) => { setData(j); continueRender(h); }).catch(() => continueRender(h));
  }, [src, h]);
  return data ? <Lottie animationData={data} loop={loop} style={style} /> : null;
};

const i0 = (s: string) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 9;

const One: React.FC<{ o: Overlay }> = ({ o }) => {
  const f = useCurrentFrame();
  const { fps, width: W, height: H, durationInFrames } = useVideoConfig();
  const len = Math.round(o.dur * fps);
  const e = envelope(f, 0, len);
  const p = pop(f, fps, 0);
  if (o.kind === "arrow") {
    const [x1, y1] = [o.from[0] * W, o.from[1] * H], [x2, y2] = [o.to[0] * W, o.to[1] * H];
    const L = Math.hypot(x2 - x1, y2 - y1);
    const t = Math.min(1, f / (fps * 0.45));
    const ang = Math.atan2(y2 - y1, x2 - x1);
    return (
      <AbsoluteFill style={{ opacity: e }}>
        <svg width={W} height={H}>
          <path d={`M${x1},${y1} L${x2},${y2}`} stroke={T.red} strokeWidth={7} strokeLinecap="round" fill="none"
            strokeDasharray={L} strokeDashoffset={L * (1 - t)} />
          {t >= 1 && <path d={`M${x2},${y2} l${-28 * Math.cos(ang - 0.45)},${-28 * Math.sin(ang - 0.45)} M${x2},${y2} l${-28 * Math.cos(ang + 0.45)},${-28 * Math.sin(ang + 0.45)}`}
            stroke={T.red} strokeWidth={7} strokeLinecap="round" fill="none" />}
        </svg>
      </AbsoluteFill>
    );
  }
  const pos: React.CSSProperties = { position: "absolute", left: (o.x ?? 0.5) * W, top: (o.y ?? 0.5) * H, translate: "-50% -50%" };
  if (o.kind === "face") {
    // The speaker in a bubble while he speaks over the product: an ink ring, a canary offset like every slip in the film.
    const size = o.w ?? 290;
    const vw = (size * 16) / 9;
    return (
      <div style={{ ...pos, width: size, height: size, borderRadius: "50%", overflow: "hidden", border: `5px solid ${T.ink}`,
        boxShadow: `9px 9px 0 ${T.canary}`, opacity: e, scale: `${0.85 + 0.15 * p}`, background: T.ink }}>
        <Video src={staticFile(o.src)} muted trimBefore={Math.round((o.trimBefore ?? 0) * fps)}
          style={{ width: vw, height: size, marginLeft: -(vw - size) / 2, objectFit: "cover", display: "block" }} />
      </div>
    );
  }
  if (o.kind === "stamp") {
    // Stays to the end of its window: a stamp doesn't fade, the scene moves on.
    return (
      <div style={{ ...pos }}>
        <Stamp text={o.text} sub={o.sub} color={o.color === "violet" ? T.violet : o.color === "green" ? T.green : T.red} w={o.w ?? 560}
          rot={o.rot ?? -8} t={f} seed={i0(o.text)} shape={o.shape} />
      </div>
    );
  }
  if (o.kind === "label") {
    // A form label on a slip of paper: ink border, mono caps. Bad is stamp red, good is ledger green.
    const ink = o.tone === "good" ? T.green : o.tone === "bad" ? T.red : o.tone === "accent" ? T.violet : T.ink;
    return (
      <div style={{ ...pos, scale: `${0.85 + 0.15 * p}`, opacity: e, background: T.white, color: ink, border: `2.5px solid ${ink}`,
        fontFamily: T.monoFont, fontWeight: 600, fontSize: T.label, letterSpacing: 1.5, textTransform: "uppercase",
        padding: "10px 20px 9px", whiteSpace: "nowrap", boxShadow: "0 14px 30px -14px rgba(27,30,35,.55)" }}>{o.text}</div>
    );
  }
  const w = o.w ?? 360;
  const style: React.CSSProperties = { ...pos, width: w, opacity: e, scale: `${0.85 + 0.15 * p}` };
  if (o.kind === "lottie") return <div style={style}><LottieAt src={o.src} loop={o.loop} style={{ width: w }} /></div>;
  if (o.kind === "gif") return <div style={style}><Gif src={staticFile(o.src)} width={w} height={o.h ?? w} fit="contain" /></div>;
  void durationInFrames;
  return <Img src={staticFile(o.src)} style={{ ...style, borderRadius: 16 }} />;
};

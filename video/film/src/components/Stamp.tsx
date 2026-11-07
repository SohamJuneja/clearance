import React from "react";
import { Easing, interpolate } from "remotion";
import { T } from "../theme";

/** A rubber stamp: double-ruled border, condensed caps, uneven ink multiplied over whatever it lands on.
 *  `t` is frames since the slam starts: it drops from 1.8x in 6 frames, hits, and stops dead. No bounce. */
export const Stamp: React.FC<{ text: string; sub?: string; color?: string; w?: number; rot?: number; t: number; seed?: number; shape?: "rect" | "oval" }> = ({
  text, sub, color = T.red, w = 520, rot = -8, t, seed = 3, shape = "rect",
}) => {
  if (t < 0) return null;
  const drop = interpolate(t, [0, 6], [1.8, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) });
  const squash = t >= 6 && t < 8 ? 0.97 : 1;
  const opacity = interpolate(t, [0, 4], [0, 1], { extrapolateRight: "clamp" });
  const h = w * (sub ? 0.36 : 0.3);
  const id = `ink${seed}`;
  return (
    <div style={{ width: w, height: h, transform: `rotate(${rot}deg) scale(${drop}, ${drop * squash})`, opacity, mixBlendMode: "multiply" }}>
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} style={{ overflow: "visible" }}>
        <defs>
          <filter id={id} x="-5%" y="-10%" width="110%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed={seed} result="speck" />
            <feColorMatrix in="speck" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.1 1.2" result="holes" />
            <feComposite in="SourceGraphic" in2="holes" operator="in" result="speckled" />
            <feTurbulence type="turbulence" baseFrequency="0.035" numOctaves="2" seed={seed + 4} result="wobble" />
            <feDisplacementMap in="speckled" in2="wobble" scale="3" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
        <g filter={`url(#${id})`} fill="none" stroke={color}>
          {shape === "oval" ? (
            <ellipse cx={w / 2} cy={h / 2} rx={w / 2 - 8} ry={h / 2 - 8} strokeWidth={w * 0.016} />
          ) : (
            <>
              <rect x={6} y={6} width={w - 12} height={h - 12} rx={8} strokeWidth={w * 0.017} />
              <rect x={w * 0.035} y={w * 0.035} width={w - w * 0.07} height={h - w * 0.07} rx={5} strokeWidth={w * 0.006} />
            </>
          )}
          <text x={w / 2} y={sub ? h * 0.56 : h * 0.66} textAnchor="middle" fill={color} stroke="none" fontFamily={T.font} fontWeight={900}
            fontSize={Math.min(h * 0.5, (w * 0.84) / Math.max(4, text.length * 0.62))} letterSpacing={w * 0.008}>{text}</text>
          {sub && (
            <text x={w / 2} y={h * 0.82} textAnchor="middle" fill={color} stroke="none" fontFamily={T.monoFont} fontWeight={600}
              fontSize={Math.min(h * 0.15, (w * 0.8) / Math.max(8, sub.length * 0.62))} letterSpacing={w * 0.004}>{sub}</text>
          )}
        </g>
      </svg>
    </div>
  );
};

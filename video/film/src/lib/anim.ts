import { Easing, interpolate, spring } from "remotion";

export const OUT = Easing.bezier(0.16, 1, 0.3, 1); // fast start, long settle: most UI moves
export const INOUT = Easing.bezier(0.65, 0, 0.35, 1); // camera moves
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** 0→1 over [start, start+dur] frames with easing. */
export const ramp = (frame: number, start: number, dur: number, ease = OUT) =>
  interpolate(frame, [start, start + dur], [0, 1], { ...clamp, easing: ease });

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Spring that never overshoots wildly; good for pops. */
export const pop = (frame: number, fps: number, delay = 0, damping = 14) =>
  spring({ frame: frame - delay, fps, config: { damping, stiffness: 140, mass: 0.7 } });

/** In + out envelope for an element visible between [a, b] frames. */
export const envelope = (frame: number, a: number, b: number, inDur = 10, outDur = 8) =>
  Math.min(ramp(frame, a, inDur), 1 - ramp(frame, b - outDur, outDur));

/** Deterministic pseudo-random (never Math.random in a render). */
export const rand = (seed: number) => {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};

export const interp = (frame: number, input: number[], output: number[], ease = INOUT) =>
  interpolate(frame, input, output, { ...clamp, easing: ease });

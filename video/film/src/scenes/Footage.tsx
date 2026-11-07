import React from "react";
import { AbsoluteFill, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Video } from "@remotion/media";
import { T } from "../theme";
import { Kinetic } from "./Kinetic";
import { envelope, interp, pop, ramp } from "../lib/anim";

export type FootageProps = {
  src: string;                         // public/ path: own recording, interview, or licensed stock (Pexels/Pixabay/Wikimedia)
  trimBefore?: number; playbackRate?: number;
  grade?: "story" | "product" | "night" | "none"; // story = warm, slightly desaturated, soft; night = cool, low
  push?: "in" | "out" | "left" | "right" | "none"; // slow camera move over the shot
  letterbox?: boolean;                 // 2.39:1 bars for cinematic story beats
  lines?: string[]; emphasis?: string[]; kicker?: string; textAt?: number; // kinetic text over the footage
  labels?: { text: string; x: number; y: number; at: number; dur?: number }[]; // pinned labels (0..1), a dot + line + chip
  person?: { name: string; role: string; at?: number }; // lower third for a real person on camera
  note?: { text: string; sub?: string };                 // e.g. the true-story note, top of frame
  audio?: boolean;                     // keep the clip's own sound (interviews, real dictation)
  dur: number;
};

/** Real moving footage, full bleed: the story's opening, b-roll, interviews, the product used in the real world.
 *  The opening of a film is usually this, not a drawn card. Footage must be real or licensed; people are real or
 *  labelled stand-ins (the true-story note says so). */
export const Footage: React.FC<FootageProps> = (p) => {
  const f = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const d = p.dur;
  const push = p.push ?? "in";
  const s = push === "in" ? interp(f, [0, d], [1.0, 1.09]) : push === "out" ? interp(f, [0, d], [1.1, 1.0]) : push === "none" ? 1 : 1.06;
  const tx = push === "left" ? interp(f, [0, d], [30, -30]) : push === "right" ? interp(f, [0, d], [-30, 30]) : 0;
  const grade = p.grade ?? "story";
  const filter = grade === "story" ? "sepia(.16) saturate(.8) contrast(1.06) brightness(.9)"
    : grade === "night" ? "saturate(.7) hue-rotate(-8deg) brightness(.72) contrast(1.1)"
    : grade === "product" ? "saturate(1.05) contrast(1.04)" : undefined;
  const fadeIn = ramp(f, 0, Math.round(fps * 0.5));
  const bars = p.letterbox ? (H - W / 2.39) / 2 : 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000", overflow: "hidden" }}>
      <AbsoluteFill style={{ scale: `${s}`, translate: `${tx}px 0`, filter, opacity: fadeIn }}>
        <Video src={staticFile(p.src)} trimBefore={Math.round((p.trimBefore ?? 0) * fps)} playbackRate={p.playbackRate ?? 1}
          muted={!p.audio} objectFit="cover" style={{ width: "100%", height: "100%" }} />
      </AbsoluteFill>
      {grade === "story" && <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(255,170,90,.10), rgba(40,20,0,.18))", mixBlendMode: "soft-light" }} />}
      <AbsoluteFill style={{ background: "radial-gradient(120% 90% at 50% 45%, transparent 55%, rgba(0,0,0,.55))" }} />
      {p.lines && <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,.05), rgba(0,0,0,.45))" }} />}
      {p.lines && (
        <Sequence from={Math.round((p.textAt ?? 0.4) * fps)} layout="none">
          <AbsoluteFill style={{ textShadow: "0 6px 30px rgba(0,0,0,.6)" }}>
            <Kinetic lines={p.lines} emphasis={p.emphasis} kicker={p.kicker} dur={d - Math.round((p.textAt ?? 0.4) * fps)} />
          </AbsoluteFill>
        </Sequence>
      )}
      {(p.labels ?? []).map((l, i) => {
        const a = Math.round(l.at * fps), b = a + Math.round((l.dur ?? 2.5) * fps);
        if (f < a || f > b + 10) return null;
        const o = envelope(f, a, b);
        const x = l.x * W, y = l.y * H;
        return (
          <div key={i} style={{ position: "absolute", left: x, top: y, opacity: o }}>
            <div style={{ position: "absolute", left: -9, top: -9, width: 18, height: 18, borderRadius: 9, background: T.accent,
              boxShadow: `0 0 0 ${6 + 10 * ((f - a) % 30) / 30}px ${T.accent}${Math.round(60 * (1 - ((f - a) % 30) / 30)).toString(16).padStart(2, "0")}` }} />
            <div style={{ position: "absolute", left: 0, top: 0, width: 70 * ramp(f, a, 8), height: 2, background: T.fg, rotate: "-35deg", transformOrigin: "0 0" }} />
            <div style={{ position: "absolute", left: 58, top: -66, scale: `${pop(f, fps, a + 6)}`, transformOrigin: "0 100%", whiteSpace: "nowrap",
              fontFamily: T.font, fontWeight: 650, fontSize: 40, color: T.fg, textShadow: "0 3px 16px rgba(0,0,0,.7)" }}>{l.text}</div>
          </div>
        );
      })}
      {p.person && (() => {
        const a = Math.round((p.person.at ?? 0.6) * fps);
        const w = ramp(f, a, Math.round(fps * 0.5));
        return (
          <div style={{ position: "absolute", left: T.safeX, bottom: T.safeY + bars + 40, opacity: envelope(f, a, Math.min(d, a + fps * 5)) }}>
            <div style={{ width: 90 * w, height: 4, background: T.accent, marginBottom: 14 }} />
            <div style={{ fontFamily: T.font, fontWeight: 650, fontSize: 46, color: T.fg, textShadow: "0 3px 14px rgba(0,0,0,.7)", clipPath: `inset(0 ${(1 - w) * 100}% 0 0)` }}>{p.person.name}</div>
            <div style={{ fontFamily: T.font, fontSize: 30, color: "#e9e9e9", marginTop: 4, opacity: ramp(f, a + 8, 10), textShadow: "0 3px 14px rgba(0,0,0,.7)" }}>{p.person.role}</div>
          </div>
        );
      })()}
      {p.note && (
        <div style={{ position: "absolute", top: bars + 70, width: "100%", textAlign: "center", opacity: envelope(f, 6, Math.min(d, fps * 7), 20, 20),
          fontFamily: T.font, color: T.fg, textShadow: "0 3px 14px rgba(0,0,0,.7)" }}>
          <div style={{ fontSize: 40, fontWeight: 600 }}>{p.note.text}</div>
          {p.note.sub && <div style={{ fontSize: 28, marginTop: 8, opacity: 0.85 }}>{p.note.sub}</div>}
        </div>
      )}
      {bars > 0 && (
        <>
          <div style={{ position: "absolute", left: 0, top: 0, width: "100%", height: bars, background: "#000" }} />
          <div style={{ position: "absolute", left: 0, bottom: 0, width: "100%", height: bars, background: "#000" }} />
        </>
      )}
    </AbsoluteFill>
  );
};


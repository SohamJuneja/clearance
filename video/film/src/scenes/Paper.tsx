import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { T } from "../theme";
import { OUT, ramp } from "../lib/anim";
import { Stamp } from "../components/Stamp";

/* Scenes written for this film, in the paperwork world: one request in carbon copies, stamps as decisions, the record as a
   ledger. Every scene moves the whole time it's on screen; nothing waits on a still frame for more than a beat. */

const sec = (s: number, fps: number) => Math.round(s * fps);

/** Words rise out of a mask one by one, in Archivo at weight. Emphasis words get stamp red and a ledger's double rule. */
const Rise: React.FC<{ text: string; start: number; size: number; emphasis?: string[]; weight?: number; color?: string; stagger?: number }> = ({
  text, start, size, emphasis = [], weight = 850, color = T.ink, stagger = 2,
}) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = text.split(" ");
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: `0 ${size * 0.26}px`, fontFamily: T.font, fontWeight: weight, fontSize: size,
      lineHeight: 1.02, letterSpacing: -size * 0.025, color }}>
      {words.map((w, i) => {
        const t = ramp(f, start + i * stagger, sec(0.5, fps), OUT);
        const em = emphasis.some((e) => w.replace(/[^\w₹,.%-]/g, "").toLowerCase() === e.toLowerCase());
        const u = ramp(f, start + i * stagger + 8, sec(0.4, fps));
        return (
          <span key={i} style={{ display: "inline-block", overflow: "hidden", paddingBottom: size * 0.12 }}>
            <span style={{ display: "inline-block", position: "relative", translate: `0 ${(1 - t) * 108}%`, color: em ? T.red : color }}>
              {w}
              {em && (
                <span style={{ position: "absolute", left: 0, bottom: size * 0.02, width: `${u * 100}%`, height: size * 0.11,
                  borderTop: `${size * 0.03}px solid ${T.red}`, borderBottom: `${size * 0.03}px solid ${T.red}` }} />
              )}
            </span>
          </span>
        );
      })}
    </div>
  );
};

/* ── The form, in three carbon copies ───────────────────────────────────────── */

type Copy = { id: string; kind: string; rows: [string, string][]; foot?: string };

const Form: React.FC<{ copy: Copy; w: number; tint?: string; children?: React.ReactNode; enter: number }> = ({ copy, w, tint = T.white, children, enter }) => (
  <div style={{ position: "relative", width: w, background: tint, padding: "34px 34px 26px 44px", boxShadow: "0 1px 0 rgba(27,30,35,.06), 0 30px 60px -34px rgba(27,30,35,.65)",
    border: `1.5px solid ${T.ink}29`, opacity: enter, translate: `${(1 - enter) * 120}px 0` }}>
    <div style={{ position: "absolute", left: 0, right: 0, top: 10, height: 6,
      background: `radial-gradient(circle, ${T.paper} 2.4px, transparent 3px) 0 0 / 14px 6px repeat-x` }} />
    <div style={{ position: "absolute", top: 0, bottom: 0, left: 22, width: 2, background: T.margin, opacity: 0.7 }} />
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: `3px solid ${T.ink}`, paddingBottom: 12, marginBottom: 10 }}>
      <span style={{ fontFamily: T.monoFont, fontWeight: 600, fontSize: 32 }}>{copy.id}</span>
      <span style={{ fontFamily: T.font, fontWeight: 850, fontSize: 30, letterSpacing: 0.5 }}>{copy.kind}</span>
    </div>
    {copy.rows.map(([k, v]) => (
      <div key={k} style={{ display: "grid", gridTemplateColumns: "170px 1fr", gap: 16, padding: "12px 0 10px", borderBottom: `1.5px solid ${T.rule}` }}>
        <span style={{ fontFamily: T.monoFont, fontSize: 21, letterSpacing: 1.5, textTransform: "uppercase", color: T.inkSoft, paddingTop: 5 }}>{k}</span>
        <span style={{ fontFamily: T.font, fontSize: 28, fontWeight: 500 }}>{v}</span>
      </div>
    ))}
    {copy.foot && <div style={{ marginTop: 12, fontFamily: T.monoFont, fontSize: 19, color: T.inkFaint }}>{copy.foot}</div>}
    {children}
  </div>
);

export type StampCardProps = {
  kicker?: string; lines: string[]; emphasis?: string[]; copy: Copy;
  stamp: { text: string; sub?: string; at: number; color?: "red" | "violet" }; tags?: string[]; dur: number;
};

/** The opening and the turn: the claim on the left, the request in triplicate on the right, and the stamp that decides it. */
export const StampCard: React.FC<StampCardProps> = ({ kicker, lines, emphasis, copy, stamp, tags = ["White · the room", "Canary · the approver", "Pink · the ledger"], dur }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const slamAt = sec(stamp.at, fps);
  const jolt = f >= slamAt + 6 && f < slamAt + 12 ? (f - slamAt - 6 < 3 ? 4 : 0) : 0;
  const out = 1 - ramp(f, dur - 8, 8);
  const cam = interpolate(f, [0, dur], [1, 1.04]);
  return (
    <AbsoluteFill style={{ opacity: out, scale: `${cam}` }}>
      <div style={{ position: "absolute", left: 200, top: 250, width: 760 }}>
        {kicker && <div style={{ fontFamily: T.monoFont, fontSize: 26, letterSpacing: 3, textTransform: "uppercase", color: T.red, marginBottom: 30,
          opacity: ramp(f, 0, 10) }}>{kicker}</div>}
        {lines.map((l, i) => (
          <div key={i} style={{ marginBottom: 6 }}>
            <Rise text={l} start={6 + i * 10} size={84} emphasis={emphasis} />
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", right: 140, top: 240, translate: `0 ${jolt}px` }}>
        <div style={{ position: "absolute", left: 40, top: 44, rotate: "2deg" }}>
          <Form copy={{ ...copy, rows: [] }} w={600} tint={T.pink} enter={ramp(f, 4, sec(0.6, fps))} />
        </div>
        <div style={{ position: "absolute", left: 20, top: 22, rotate: "1deg" }}>
          <Form copy={{ ...copy, rows: [] }} w={600} tint={T.canary} enter={ramp(f, 8, sec(0.6, fps))} />
        </div>
        <Form copy={copy} w={600} enter={ramp(f, 12, sec(0.6, fps))}>
          <div style={{ position: "absolute", left: 150, bottom: 30 }}>
            <Stamp text={stamp.text} sub={stamp.sub} color={stamp.color === "violet" ? T.violet : T.red} w={430} t={f - slamAt} />
          </div>
        </Form>
        <div style={{ display: "flex", gap: 12, marginTop: 70, opacity: ramp(f, slamAt + 14, 12) }}>
          {tags.map((t, i) => (
            <span key={t} style={{ fontFamily: T.monoFont, fontSize: 20, letterSpacing: 1, textTransform: "uppercase", padding: "7px 12px",
              background: [T.white, T.canary, T.pink][i % 3], border: `1.5px solid ${T.ink}33` }}>{t}</span>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ── A ledger of sourced facts ───────────────────────────────────────────── */

export type FactsProps = { kicker?: string; title?: string; rows: { text: string; source: string; at?: number }[]; dur: number };

/** The size of the problem, typed onto a ledger sheet a line at a time, each with where it comes from. */
export const Facts: React.FC<FactsProps> = ({ kicker, title, rows, dur }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const out = 1 - ramp(f, dur - 8, 8);
  const each = (dur - sec(1, fps)) / Math.max(1, rows.length);
  return (
    <AbsoluteFill style={{ opacity: out, justifyContent: "center", alignItems: "center" }}>
      <div style={{ width: 1500, background: T.white, padding: "46px 60px 40px 110px", position: "relative", rotate: `${interpolate(f, [0, dur], [-0.6, 0.2])}deg`,
        boxShadow: "0 40px 80px -40px rgba(27,30,35,.6)", border: `1.5px solid ${T.ink}26` }}>
        <div style={{ position: "absolute", top: 0, bottom: 0, left: 80, width: 2, background: T.margin }} />
        {kicker && <div style={{ fontFamily: T.monoFont, fontSize: 24, letterSpacing: 3, textTransform: "uppercase", color: T.red }}>{kicker}</div>}
        {title && <div style={{ fontFamily: T.font, fontWeight: 850, fontSize: 64, letterSpacing: -1.5, margin: "10px 0 24px" }}>{title}</div>}
        {rows.map((r, i) => {
          const a = r.at !== undefined ? sec(r.at, fps) : Math.round(sec(0.4, fps) + i * each);
          const typed = Math.floor(Math.max(0, f - a) * 2.2);
          const shown = r.text.slice(0, typed);
          const done = typed >= r.text.length;
          return (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "60px 1fr", gap: 18, padding: "18px 0 14px", borderBottom: `2px solid ${T.rule}`,
              opacity: f >= a ? 1 : 0.15 }}>
              <span style={{ fontFamily: T.monoFont, fontSize: 26, color: T.inkFaint, paddingTop: 10 }}>{String(i + 1).padStart(2, "0")}</span>
              <div>
                <div style={{ fontFamily: T.font, fontWeight: 650, fontSize: 44, lineHeight: 1.2, minHeight: 53 }}>
                  {shown}
                  {!done && f >= a && <span style={{ display: "inline-block", width: 4, height: 42, background: T.ink, marginLeft: 4, translate: "0 6px" }} />}
                </div>
                <div style={{ fontFamily: T.monoFont, fontSize: 22, color: T.inkSoft, marginTop: 6, opacity: done ? 1 : 0 }}>{r.source}</div>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/* ── A docket of attempts, each stamped ──────────────────────────────────── */

export type DocketProps = { title: string; cases: { title: string; outcome: string; note: string; at: number }[]; footnote?: string; dur: number };

/** What agents tried: index cards dealt onto the desk, each stamped with what happened to it, at the second it's named. */
export const Docket: React.FC<DocketProps> = ({ title, cases, footnote, dur }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const out = 1 - ramp(f, dur - 8, 8);
  const tints = [T.canary, T.white, T.pink];
  return (
    <AbsoluteFill style={{ opacity: out, padding: "120px 170px" }}>
      <div style={{ fontFamily: T.font, fontWeight: 850, fontSize: 76, letterSpacing: -2, opacity: ramp(f, 0, 10) }}>{title}</div>
      <div style={{ display: "flex", gap: 44, marginTop: 70 }}>
        {cases.map((c, i) => {
          const a = sec(c.at, fps);
          const deal = ramp(f, a - 14, 14);
          return (
            <div key={i} style={{ flex: 1, minHeight: 420, background: tints[i % 3], border: `1.5px solid ${T.ink}2e`, padding: "34px 30px", position: "relative",
              boxShadow: "0 30px 60px -36px rgba(27,30,35,.7)", rotate: `${[-1.5, 0.8, -0.6][i % 3] * deal}deg`,
              translate: `0 ${(1 - deal) * 260}px`, opacity: deal }}>
              <div style={{ fontFamily: T.monoFont, fontSize: 22, letterSpacing: 2, color: T.inkSoft, textTransform: "uppercase" }}>Case {i + 1}</div>
              <div style={{ fontFamily: T.font, fontWeight: 750, fontSize: 42, lineHeight: 1.15, marginTop: 14 }}>{c.title}</div>
              <div style={{ fontFamily: T.font, fontSize: 28, color: T.inkSoft, marginTop: 18, lineHeight: 1.3 }}>{c.note}</div>
              <div style={{ position: "absolute", left: 40, bottom: 40 }}>
                <Stamp text={c.outcome} color={c.outcome === "HELD" ? T.violet : T.red} w={330} rot={-9 + i * 3} t={f - a - 8} seed={i + 2} />
              </div>
            </div>
          );
        })}
      </div>
      {footnote && <div style={{ position: "absolute", left: 170, bottom: 150, fontFamily: T.monoFont, fontSize: 24, color: T.inkSoft,
        opacity: ramp(f, sec(2, fps), 12) }}>{footnote}</div>}
    </AbsoluteFill>
  );
};

/* ── The Switch room, in 2.5D ─────────────────────────────────────────────── */

export type RoomProps = {
  title: string; room: string;
  people: { name: string; role: string; x: number; y: number }[];
  agents: { name: string; vendor: string; x: number; y: number }[];
  tags: { text: string; at: number; x: number; y: number }[];
  dur: number;
};

/** Switch is the floor everyone stands on: people and agents in one room, and what Switch gives Clearance lighting up as it's named. */
export const Room: React.FC<RoomProps> = ({ title, room, people, agents, tags, dur }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const out = 1 - ramp(f, dur - 8, 8);
  const tilt = interpolate(f, [0, dur], [58, 52]);
  const spin = interpolate(f, [0, dur], [-14, 6]);
  const floor = { w: 1500, h: 860 };
  const grow = ramp(f, 0, sec(0.9, fps));
  const node = (x: number, y: number) => ({ left: x * floor.w, top: y * floor.h });
  return (
    <AbsoluteFill style={{ opacity: out }}>
      <div style={{ position: "absolute", left: 170, top: 90, fontFamily: T.font, fontWeight: 850, fontSize: 72, letterSpacing: -2, zIndex: 3,
        opacity: ramp(f, 0, 10) }}>{title}</div>
      <AbsoluteFill style={{ perspective: 1800, perspectiveOrigin: "50% 30%" }}>
        <div style={{ position: "absolute", left: (1920 - floor.w) / 2, top: 230, width: floor.w, height: floor.h, transformStyle: "preserve-3d",
          transform: `rotateX(${tilt}deg) rotateZ(${spin}deg) scale(${0.85 + 0.15 * grow})` }}>
          <div style={{ position: "absolute", inset: 0, background: T.white, border: `3px solid ${T.ink}`,
            backgroundImage: `linear-gradient(${T.rule}88 2px, transparent 2px), linear-gradient(90deg, ${T.rule}88 2px, transparent 2px)`,
            backgroundSize: "86px 86px", boxShadow: "0 60px 80px rgba(27,30,35,.25)" }} />
          <div style={{ position: "absolute", left: 30, top: 24, fontFamily: T.monoFont, fontWeight: 600, fontSize: 44, color: T.violet }}>{room}</div>
          {agents.map((a) =>
            people.map((p) => {
              const x1 = a.x * floor.w, y1 = a.y * floor.h, x2 = p.x * floor.w, y2 = p.y * floor.h;
              const L = Math.hypot(x2 - x1, y2 - y1);
              const t = ramp(f, sec(1.0, fps), sec(1.2, fps));
              return (
                <div key={a.name + p.name} style={{ position: "absolute", left: x1, top: y1, width: L * t, height: 3, background: `${T.ink}33`,
                  transformOrigin: "0 50%", rotate: `${Math.atan2(y2 - y1, x2 - x1)}rad` }} />
              );
            }),
          )}
          {[...people.map((p) => ({ ...p, kind: "person" as const, sub: p.role })), ...agents.map((a) => ({ ...a, role: a.vendor, kind: "agent" as const, sub: a.vendor }))].map((n, i) => {
            const e = ramp(f, 6 + i * 4, 14);
            return (
              <div key={n.name} style={{ position: "absolute", ...node(n.x, n.y), transformStyle: "preserve-3d" }}>
                <div style={{ position: "absolute", translate: "-50% -100%", transform: `rotateZ(${-spin}deg) rotateX(${-tilt}deg)`, transformOrigin: "50% 100%",
                  display: "flex", flexDirection: "column", alignItems: "center", gap: 8, opacity: e }}>
                  <div style={{ width: 96, height: 96, borderRadius: n.kind === "person" ? 48 : 14, display: "grid", placeItems: "center",
                    background: n.kind === "person" ? T.green : "#D9822B", color: T.white, fontFamily: T.font, fontWeight: 800, fontSize: 44,
                    boxShadow: "0 14px 24px rgba(27,30,35,.35)" }}>{n.name[0].toUpperCase()}</div>
                  <div style={{ background: T.white, border: `2px solid ${T.ink}`, padding: "4px 12px", fontFamily: T.font, fontWeight: 700, fontSize: 30, whiteSpace: "nowrap" }}>
                    {n.name}<span style={{ fontFamily: T.monoFont, fontWeight: 400, fontSize: 20, color: T.inkSoft, marginLeft: 10 }}>{n.sub}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
      {tags.map((t, i) => {
        const a = sec(t.at, fps);
        const e = ramp(f, a, 10);
        return (
          <div key={i} style={{ position: "absolute", left: t.x * 1920, top: t.y * 1080, translate: `-50% ${(1 - e) * 20}px`, opacity: e, zIndex: 4,
            background: T.ink, color: T.white, fontFamily: T.font, fontWeight: 700, fontSize: 34, padding: "12px 22px",
            boxShadow: `6px 6px 0 ${T.canary}` }}>{t.text}</div>
        );
      })}
    </AbsoluteFill>
  );
};

/* ── Proof as a ledger: without, then with ───────────────────────────────── */

export type LedgerProofProps = {
  title: string; metric: string;
  rows: { label: string; before: number; after: number; of: number; beforeText: string; afterText: string }[];
  footnote: string; dur: number;
};

/** Ours against a named baseline: the baseline's bar fills, then ours, and the zero gets stamped. The footnote says how it was measured. */
export const LedgerProof: React.FC<LedgerProofProps> = ({ title, metric, rows, footnote, dur }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const out = 1 - ramp(f, dur - 8, 8);
  return (
    <AbsoluteFill style={{ opacity: out, padding: "110px 190px" }}>
      <div style={{ fontFamily: T.font, fontWeight: 850, fontSize: 72, letterSpacing: -2, opacity: ramp(f, 0, 10) }}>{title}</div>
      <div style={{ fontFamily: T.monoFont, fontSize: 25, letterSpacing: 2, textTransform: "uppercase", color: T.inkSoft, marginTop: 12 }}>{metric}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 44, marginTop: 70 }}>
        {rows.map((r, i) => {
          const a = sec(0.6 + i * 2.6, fps);
          const g1 = ramp(f, a, sec(0.9, fps));
          const g2 = ramp(f, a + sec(1.1, fps), sec(0.6, fps));
          return (
            <div key={r.label}>
              <div style={{ fontFamily: T.font, fontWeight: 800, fontSize: 44, marginBottom: 14, opacity: ramp(f, a - 6, 8) }}>{r.label}</div>
              {[["Without Clearance", r.before, r.beforeText, g1, `${T.ink}55`], ["With Clearance", r.after, r.afterText, g2, T.green]].map(([lab, v, txt, g, col], j) => (
                <div key={String(lab)} style={{ display: "grid", gridTemplateColumns: "330px 1fr 230px", alignItems: "center", gap: 26, marginBottom: 12,
                  opacity: ramp(f, (j === 0 ? a : a + sec(1.1, fps)) - 4, 8) }}>
                  <span style={{ fontFamily: T.monoFont, fontSize: 26, color: T.inkSoft }}>{String(lab)}</span>
                  <div style={{ height: 50, background: T.paperDeep, border: `1.5px solid ${T.ink}22`, position: "relative" }}>
                    <div style={{ width: `${(Number(v) / r.of) * 100 * Number(g)}%`, height: "100%", background: String(col) }} />
                  </div>
                  <span style={{ fontFamily: T.font, fontWeight: 850, fontSize: 48, fontVariantNumeric: "tabular-nums", color: j === 1 ? T.green : T.ink,
                    position: "relative" }}>
                    {String(txt)}
                    {j === 1 && Number(v) === 0 && (
                      <span style={{ position: "absolute", left: -300, top: -20 }}>
                        <Stamp text="NONE" color={T.green} w={190} rot={-10} t={f - a - sec(1.7, fps)} seed={i + 5} />
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
      <div style={{ position: "absolute", left: 190, bottom: 150, right: 190, fontFamily: T.monoFont, fontSize: 23, color: T.inkSoft, lineHeight: 1.5,
        opacity: ramp(f, sec(1.5, fps), 12) }}>{footnote}</div>
    </AbsoluteFill>
  );
};

/* ── Big figures, each with its caveat ───────────────────────────────────── */

export type BigFiguresProps = { title?: string; figures: { value: string; label: string; note: string; tone?: "good" | "bad" | "ink"; at?: number }[]; dur: number };

/** A few numbers that each stand on their own line of the record. The caveat sits under each, never hidden. */
export const BigFigures: React.FC<BigFiguresProps> = ({ title, figures, dur }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const out = 1 - ramp(f, dur - 8, 8);
  return (
    <AbsoluteFill style={{ opacity: out, padding: "130px 190px", justifyContent: "center" }}>
      {title && <div style={{ fontFamily: T.font, fontWeight: 850, fontSize: 68, letterSpacing: -2, marginBottom: 50, opacity: ramp(f, 0, 10) }}>{title}</div>}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${figures.length}, 1fr)`, borderTop: `4px solid ${T.ink}` }}>
        {figures.map((g, i) => {
          const a = g.at !== undefined ? sec(g.at, fps) : 6 + i * sec(0.7, fps);
          const e = ramp(f, a, 14);
          return (
            <div key={i} style={{ padding: "30px 30px 0 0", paddingLeft: i ? 34 : 0, borderLeft: i ? `2px solid ${T.rule}` : undefined, opacity: e,
              translate: `0 ${(1 - e) * 24}px` }}>
              <div style={{ fontFamily: T.font, fontWeight: 900, fontSize: figures.length > 2 ? 104 : 130, lineHeight: 1, letterSpacing: -3, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap",
                color: g.tone === "bad" ? T.red : g.tone === "good" ? T.green : T.ink }}>{g.value}</div>
              <div style={{ fontFamily: T.font, fontWeight: 700, fontSize: 36, marginTop: 18, lineHeight: 1.2 }}>{g.label}</div>
              <div style={{ fontFamily: T.monoFont, fontSize: 22, color: T.inkSoft, marginTop: 14, lineHeight: 1.45 }}>{g.note}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

import React, { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import { T } from "../theme";
import { OUT, envelope, pop, ramp } from "../lib/anim";

/** "Under the hood": the architecture as an exploded 3D stack, bottom → top in the order data flows.
 *  Each slab rises on the word that names it (cues from Whisper word times), its numbered label draws on with a
 *  leader line, earlier labels dim. Packets climb the stack; one danger packet is stopped at the check layer;
 *  the human layer pulses "approved"; traces light to the sponsor/cloud satellites when they are used.
 *  Every value is a function of the frame (no useFrame), so renders are reproducible. */
export type Arch3DProps = {
  title?: string;
  layers: { id: string; label: string; sub?: string }[];       // bottom → top
  satellites?: { id: string; label: string }[];                  // sponsor / cloud services, right column
  traces?: { from: string; to: string; at: number }[];          // layer → satellite, seconds into the scene
  cues?: Record<string, number>;                                 // layer id → second it is named
  blockedAt?: string; blockedText?: string;                      // the check layer and what it stopped
  humanAt?: string; humanText?: string;                          // the approval layer
  dur: number;
};

const GAP = 0.78, W3 = 4.4, D3 = 2.7, H3 = 0.2;
const camAt = (f: number, dur: number) => {
  const t = Math.min(1, f / Math.max(1, dur));
  const e = OUT(t);
  const ang = THREE.MathUtils.degToRad(-9 + 17 * e);   // ~17° orbit
  const r = 13.2 - 1.4 * e;                              // gentle dolly in
  return { pos: new THREE.Vector3(Math.sin(ang) * r + 0.6, 4.2 - 0.5 * e, Math.cos(ang) * r), look: new THREE.Vector3(0.6, -0.1, 0) };
};

export const Arch3D: React.FC<Arch3DProps> = (p) => {
  const f = useCurrentFrame();
  const { fps, width: W, height: H } = useVideoConfig();
  const n = p.layers.length;
  const y0 = -((n - 1) * GAP) / 2 - 0.2;
  const riseAt = p.layers.map((l, i) => Math.round((p.cues?.[l.id] ?? 0.5 + i * ((p.dur / fps) * 0.45) / n) * fps));
  // projection for HTML labels, same camera as the canvas
  const cam = useMemo(() => new THREE.PerspectiveCamera(32, W / H, 0.1, 100), [W, H]);
  const c = camAt(f, p.dur);
  cam.position.copy(c.pos); cam.lookAt(c.look); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  const proj = (v: THREE.Vector3) => { const q = v.clone().project(cam); return [(q.x + 1) / 2 * W, (1 - q.y) / 2 * H]; };
  const active = riseAt.reduce((a, t, i) => (f >= t ? i : a), -1);
  const doneAt = riseAt[n - 1] + Math.round(fps * 0.6);
  const blockIdx = p.layers.findIndex((l) => l.id === p.blockedAt);
  const humanIdx = p.layers.findIndex((l) => l.id === p.humanAt);
  const dangerStart = doneAt + Math.round(fps * 1.2);
  const dangerStop = blockIdx >= 0 ? dangerStart + Math.round(fps * 0.45) * (blockIdx + 1) : -1;
  const humanPulse = humanIdx >= 0 ? doneAt + Math.round(fps * 0.45) * (humanIdx + 1) : -1;
  return (
    <AbsoluteFill>
      <ThreeCanvas width={W} height={H} camera={{ fov: 32, position: [c.pos.x, c.pos.y, c.pos.z], near: 0.1, far: 100 }}>
        <Stack {...p} y0={y0} riseAt={riseAt} doneAt={doneAt} blockIdx={blockIdx} humanIdx={humanIdx}
          dangerStart={dangerStart} dangerStop={dangerStop} humanPulse={humanPulse} />
      </ThreeCanvas>
      {p.title && <div style={{ position: "absolute", left: T.safeX + 60, top: 54, fontFamily: T.font, fontWeight: 850, fontSize: 72, letterSpacing: -2,
        color: T.fg, opacity: ramp(f, 0, 12) }}>{p.title}</div>}
      <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
        {p.layers.map((l, i) => {
          if (f < riseAt[i] + 6) return null;
          const [ax, ay] = proj(new THREE.Vector3(W3 / 2, y0 + i * GAP + H3 / 2, D3 / 2 - 0.2));
          const lx = W - T.safeX - 470, ly = Math.max(140, Math.min(H - 140, ay));
          const draw = ramp(f, riseAt[i] + 6, Math.round(fps * 0.3));
          const len = Math.hypot(lx - ax, ly - ay);
          const dim = i === active ? 1 : 0.45;
          return <path key={l.id} d={`M${ax},${ay} L${lx - 14},${ly}`} stroke={i === active ? T.accent : `${T.fg}88`} strokeWidth={2.5}
            fill="none" strokeDasharray={len} strokeDashoffset={len * (1 - draw)} opacity={dim} />;
        })}
      </svg>
      {p.layers.map((l, i) => {
        if (f < riseAt[i] + 8) return null;
        const [, ay] = proj(new THREE.Vector3(W3 / 2, y0 + i * GAP + H3 / 2, D3 / 2 - 0.2));
        const ly = Math.max(140, Math.min(H - 140, ay));
        const o = ramp(f, riseAt[i] + 8, 9) * (i === active ? 1 : 0.45);
        return (
          <div key={l.id} style={{ position: "absolute", left: W - T.safeX - 470, top: ly, translate: `0 calc(-50% + ${(1 - ramp(f, riseAt[i] + 8, 10)) * 12}px)`,
            width: 460, opacity: o, fontFamily: T.font, color: T.fg }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
              <span style={{ fontFamily: T.monoFont, fontSize: 26, color: "#5B3DF5" }}>{String(i + 1).padStart(2, "0")}</span>
              <span style={{ fontSize: 38, fontWeight: 800 }}>{l.label}</span>
            </div>
            {l.sub && <div style={{ fontFamily: T.monoFont, fontSize: 22, color: "#3B4266", marginTop: 6, marginLeft: 46 }}>{l.sub}</div>}
          </div>
        );
      })}
      {(p.satellites ?? []).map((sat, i) => {
        const sats = p.satellites!.length;
        const v = new THREE.Vector3(-W3 / 2 - 2.6, y0 + (i + 0.5) * ((n * GAP) / sats), -1.4);
        const [sx, sy] = proj(v);
        return <div key={sat.id} style={{ position: "absolute", left: sx, top: sy + 44, translate: "-50% 0", fontFamily: T.monoFont,
          fontSize: 26, color: T.accent2, opacity: ramp(f, doneAt - fps * 0.3 + i * 4 + 6, 10), whiteSpace: "nowrap" }}>{sat.label}</div>;
      })}
      {dangerStop > 0 && f >= dangerStop && p.blockedText && (() => {
        const [bx, by] = proj(new THREE.Vector3(0.4, y0 + blockIdx * GAP + 0.3, D3 / 2));
        return <div style={{ position: "absolute", left: bx, top: by, translate: "-50% -10%", scale: `${pop(f, fps, dangerStop)}`,
          transformOrigin: "50% 0%", zIndex: 2, opacity: envelope(f, dangerStop, p.dur), background: T.bad, color: T.bg, fontFamily: T.font,
          fontWeight: 650, fontSize: 28, padding: "10px 20px", borderRadius: 12, whiteSpace: "nowrap" }}>✕ {p.blockedText}</div>;
      })()}
      {humanPulse > 0 && f >= humanPulse && (() => {
        const [hx, hy] = proj(new THREE.Vector3(-W3 / 2 + 0.5, y0 + humanIdx * GAP + 0.3, D3 / 2));
        return <div style={{ position: "absolute", left: hx, top: hy, translate: "-50% -10%", scale: `${pop(f, fps, humanPulse)}`,
          background: T.good, color: T.bg, fontFamily: T.font, fontWeight: 650, fontSize: 26, padding: "8px 18px", borderRadius: 999 }}>
          ✓ {p.humanText ?? "approved"}</div>;
      })()}
    </AbsoluteFill>
  );
};

type StackProps = Arch3DProps & { y0: number; riseAt: number[]; doneAt: number; blockIdx: number; humanIdx: number;
  dangerStart: number; dangerStop: number; humanPulse: number };

const Stack: React.FC<StackProps> = (p) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { camera } = useThree();
  const c = camAt(f, p.dur);
  camera.position.copy(c.pos); camera.lookAt(c.look); camera.updateMatrixWorld();
  // Stamp violet lights the active slab; Switch's room, the floor everything stands on, is tinted violet throughout.
  const accent = useMemo(() => new THREE.Color("#5B3DF5"), []);
  const n = p.layers.length;
  const step = Math.round(fps * 0.45); // time per layer for a packet (move + pause)
  const packetY = (start: number, stopAt = n) => {
    const t = f - start;
    if (t < 0) return null;
    const k = Math.floor(t / step), r = (t % step) / step;
    if (k >= stopAt) return p.y0 + (stopAt - 1) * GAP + 0.32;
    const move = Math.min(1, r / 0.6);
    return p.y0 + (k - 1 + OUT(move)) * GAP + 0.32;
  };
  const sats = p.satellites ?? [];
  const satPos = (i: number) => new THREE.Vector3(-W3 / 2 - 2.6, p.y0 + (i + 0.5) * ((n * GAP) / Math.max(1, sats.length)), -1.4);
  const lines = useMemo(() => (p.traces ?? []).map(() => {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color: T.accent, transparent: true }));
  }), [p.traces]);
  return (
    <>
      <ambientLight intensity={0.85} />
      <directionalLight position={[5, 9, 6]} intensity={1.5} />
      <pointLight position={[-5, 2, 5]} intensity={10} color={accent} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, p.y0 - 0.9, 0]}>
        <circleGeometry args={[7, 64]} />
        <meshBasicMaterial color={T.accent} transparent opacity={0.05} />
      </mesh>
      {p.layers.map((l, i) => {
        const r = ramp(f, p.riseAt[i], Math.round(fps * 0.5));
        const isActive = f >= p.riseAt[i] && (i === p.layers.length - 1 || f < p.riseAt[i + 1]);
        const pulse = i === p.humanIdx && p.humanPulse > 0 ? Math.max(0, 1 - Math.abs(f - p.humanPulse) / (fps * 0.5)) : 0;
        const blocked = i === p.blockIdx && p.dangerStop > 0 ? Math.max(0, 1 - Math.abs(f - p.dangerStop) / (fps * 0.6)) : 0;
        return (
          <group key={l.id} position={[0, p.y0 + i * GAP - (1 - r) * 1.2, 0]} scale={0.6 + 0.4 * r}>
            <RoundedBox args={[W3, H3, D3]} radius={0.06} smoothness={4}>
              <meshPhysicalMaterial color={blocked > 0 ? T.bad : i === 0 ? "#D3CCF4" : T.surface} metalness={0.05} roughness={0.6} clearcoat={0.3}
                transparent opacity={r} emissive={blocked > 0 ? T.bad : accent} emissiveIntensity={(isActive ? 0.35 : 0.04) + pulse * 0.8 + blocked * 0.6} />
            </RoundedBox>
            <mesh position={[0, H3 / 2 + 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[W3 - 0.3, D3 - 0.3]} />
              <meshBasicMaterial color={isActive ? T.accent : T.fg} transparent opacity={r * (isActive ? 0.18 : 0.05)} wireframe />
            </mesh>
          </group>
        );
      })}
      {f > p.doneAt && Array.from({ length: 5 }).map((_, k) => {
        const s = p.doneAt + k * Math.round(fps * 0.55), cycle = (n + 1) * step;
        if (f < s) return null;
        const y = packetY(f - ((f - s) % cycle));
        if (y === null) return null;
        const loopY = y > p.y0 + (n - 1) * GAP + 0.3 ? null : y;
        return loopY === null ? null : (
          <mesh key={k} position={[-0.8 + (k % 3) * 0.8, loopY, 0.2 - (k % 2) * 0.5]}>
            <sphereGeometry args={[0.09, 20, 20]} />
            <meshStandardMaterial color={T.fg} emissive={accent} emissiveIntensity={1.6} />
          </mesh>
        );
      })}
      {p.blockIdx >= 0 && f > p.dangerStart && (() => {
        const y = packetY(p.dangerStart, p.blockIdx + 1)!;
        return (
          <mesh position={[0.4, y, 0.6]}>
            <sphereGeometry args={[0.12, 20, 20]} />
            <meshStandardMaterial color={T.bad} emissive={T.bad} emissiveIntensity={1.4} />
          </mesh>
        );
      })()}
      {sats.map((s, i) => {
        const v = satPos(i);
        const r = ramp(f, p.doneAt - fps * 0.3 + i * 4, 12);
        return (
          <mesh key={s.id} position={v} scale={0.4 + 0.6 * r}>
            <octahedronGeometry args={[0.32, 0]} />
            <meshStandardMaterial color={T.accent2} emissive={T.accent2} emissiveIntensity={0.5} transparent opacity={r} />
          </mesh>
        );
      })}
      {(p.traces ?? []).map((t, i) => {
        const li = p.layers.findIndex((l) => l.id === t.from), si = sats.findIndex((s) => s.id === t.to);
        if (li < 0 || si < 0) return null;
        const a = new THREE.Vector3(-W3 / 2, p.y0 + li * GAP, 0), b = satPos(si);
        const k = ramp(f, Math.round(t.at * fps), Math.round(fps * 0.4));
        const end = a.clone().lerp(b, k);
        lines[i].geometry.setFromPoints([a, end]);
        (lines[i].material as THREE.LineBasicMaterial).opacity = k > 0 ? 0.9 : 0;
        return <primitive key={i} object={lines[i]} />;
      })}
    </>
  );
};

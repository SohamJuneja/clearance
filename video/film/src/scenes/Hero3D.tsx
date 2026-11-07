import React, { useMemo } from "react";
import { AbsoluteFill, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { ThreeCanvas } from "@remotion/three";
import { useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { T } from "../theme";
import { interp, ramp, rand } from "../lib/anim";

/** A 3D world for title / concept / transition beats: a GLB model (CC0 from Kenney, Poly Pizza, KayKit…, put in public/models)
 *  or a procedural object built from the brand colours. Camera dollies in; everything is a function of the frame. */
export const Hero3D: React.FC<{ title?: string; subtitle?: string; model?: string; modelScale?: number; clip?: string; shape?: "orbits" | "grid" | "monolith"; dur: number }> = ({
  title, subtitle, model, modelScale = 1, clip, shape = "orbits", dur,
}) => {
  const f = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const out = 1 - ramp(f, dur - Math.round(fps * 0.35), Math.round(fps * 0.35));
  return (
    <AbsoluteFill style={{ opacity: out }}>
      <ThreeCanvas width={width} height={height} camera={{ fov: 35, position: [0, 0, 10] }}>
        <World dur={dur} model={model} modelScale={modelScale} shape={shape} clip={clip} />
      </ThreeCanvas>
      {(title || subtitle) && (
        <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 120 }}>
          {title && <div style={{ fontFamily: T.font, fontWeight: 700, fontSize: T.h1, letterSpacing: -3, color: T.fg,
            opacity: ramp(f, 10, 16), translate: `0 ${(1 - ramp(f, 10, 20)) * 30}px`, textShadow: "0 8px 40px rgba(0,0,0,.6)" }}>{title}</div>}
          {subtitle && <div style={{ fontFamily: T.font, fontSize: T.body, color: T.muted, marginTop: 14,
            opacity: ramp(f, 22, 16) }}>{subtitle}</div>}
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

const World: React.FC<{ dur: number; model?: string; modelScale: number; shape: string; clip?: string }> = ({ dur, model, modelScale, shape, clip }) => {
  const f = useCurrentFrame();
  const camZ = interp(f, [0, dur], [11, 8.2]);
  const spin = f / 90;
  const accent = new THREE.Color(T.accent), accent2 = new THREE.Color(T.accent2);
  return (
    <>
      <ambientLight intensity={0.35} />
      <directionalLight position={[5, 6, 5]} intensity={1.4} />
      <pointLight position={[-4, -2, 4]} intensity={30} color={accent} />
      <pointLight position={[4, 3, -2]} intensity={25} color={accent2} />
      <group position={[0, 0.5, 10 - camZ]} rotation={[0.15, spin * 0.35, 0]}>
        {model ? (
          <Model src={model} scale={modelScale} clip={clip} />
        ) : shape === "grid" ? (
          <Grid f={f} />
        ) : shape === "monolith" ? (
          <mesh rotation={[0, spin, 0]}>
            <boxGeometry args={[1.6, 3.6, 0.5]} />
            <meshPhysicalMaterial color={T.surface} metalness={0.9} roughness={0.15} clearcoat={1} emissive={accent} emissiveIntensity={0.08} />
          </mesh>
        ) : (
          <Orbits f={f} />
        )}
      </group>
    </>
  );
};

/** GLB with its own animation (Mixamo / Quaternius / Kenney rigs): the mixer is set to the frame's time,
 *  never advanced by a clock, so every frame renders the same way twice. */
const Model: React.FC<{ src: string; scale: number; clip?: string }> = ({ src, scale, clip }) => {
  const g = useGLTF(staticFile(src));
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const mixer = useMemo(() => {
    const m = new THREE.AnimationMixer(g.scene);
    const a = g.animations.find((x) => x.name === clip) ?? g.animations[0];
    if (a) m.clipAction(a).play();
    return m;
  }, [g, clip]);
  // Normalise any model (Mixamo exports are in cm) to ~4.5 units on its longest side, centred on the origin, feet on the floor line
  const fit = useMemo(() => {
    const box = new THREE.Box3().setFromObject(g.scene);
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const k = 4.5 / Math.max(size.x, size.y, size.z, 1e-6);
    return { k, offset: [-c.x * k, -c.y * k, -c.z * k] as [number, number, number] };
  }, [g]);
  mixer.setTime(f / fps);
  return <group position={fit.offset} scale={fit.k * scale}><primitive object={g.scene} /></group>;
};

const Orbits: React.FC<{ f: number }> = ({ f }) => {
  const a = f / 30;
  return (
    <>
      <mesh rotation={[a * 0.3, a * 0.5, 0]}>
        <icosahedronGeometry args={[1.25, 1]} />
        <meshPhysicalMaterial color={T.accent} metalness={0.3} roughness={0.2} flatShading clearcoat={1} />
      </mesh>
      {[0, 1, 2].map((i) => (
        <group key={i} rotation={[Math.PI / 2 + i * 0.6, i * 1.1, 0]}>
          <mesh>
            <torusGeometry args={[2.2 + i * 0.55, 0.012, 8, 160]} />
            <meshBasicMaterial color={T.fg} transparent opacity={0.35} />
          </mesh>
          <mesh position={[Math.cos(a * (0.8 - i * 0.2) + i) * (2.2 + i * 0.55), Math.sin(a * (0.8 - i * 0.2) + i) * (2.2 + i * 0.55), 0]}>
            <sphereGeometry args={[0.11, 24, 24]} />
            <meshStandardMaterial color={i % 2 ? T.accent2 : T.fg} emissive={i % 2 ? T.accent2 : T.accent} emissiveIntensity={0.6} />
          </mesh>
        </group>
      ))}
    </>
  );
};

const Grid: React.FC<{ f: number }> = ({ f }) => {
  const n = 14, items = [];
  for (let x = 0; x < n; x++)
    for (let z = 0; z < n; z++) {
      const d = Math.hypot(x - n / 2, z - n / 2);
      const h = 0.3 + (Math.sin(d * 0.7 - f / 12) + 1) * 0.7 + rand(x * 31 + z) * 0.3;
      items.push(
        <mesh key={`${x}-${z}`} position={[(x - n / 2) * 0.42, h / 2 - 2, (z - n / 2) * 0.42]}>
          <boxGeometry args={[0.36, h, 0.36]} />
          <meshStandardMaterial color={d < 2.2 ? T.accent : T.surface} emissive={T.accent} emissiveIntensity={d < 2.2 ? 0.3 : 0.02} />
        </mesh>,
      );
    }
  return <group rotation={[0.55, 0.6, 0]}>{items}</group>;
};

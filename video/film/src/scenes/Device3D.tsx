import React, { useLayoutEffect, useRef } from "react";
import { AbsoluteFill, Html5Video, staticFile, useCurrentFrame, useDelayRender, useRemotionEnvironment, useVideoConfig } from "remotion";
import { ThreeCanvas, useOffthreadVideoTexture, useVideoTexture } from "@remotion/three";
import { Video } from "@remotion/media";
import { RoundedBox } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { T } from "../theme";
import { interp, ramp } from "../lib/anim";

/** Establishing shot: the real recording playing on a 3D laptop/phone that swings in and squares up.
 *  With `flatten`, the last ~0.8s dissolves to the flat, full-size recording so the UI becomes readable.
 *  Use once (cold open or "here it is" reveal). Detail work belongs in <Screen>. Animation is frame-driven only. */
export const Device3D: React.FC<{ src: string; device?: "laptop" | "phone"; title?: string; flatten?: boolean; dur: number }> = ({
  src, device = "laptop", title, flatten = true, dur,
}) => {
  const f = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const flatAt = flatten ? dur - Math.round(fps * 0.8) : dur + 1;
  const flat = ramp(f, flatAt, Math.round(fps * 0.6));
  const { isRendering } = useRemotionEnvironment();
  const preview = useRef<HTMLVideoElement>(null);
  return (
    <AbsoluteFill>
      {/* Studio preview can't use the offthread texture: play a hidden <video> and texture from it */}
      {!isRendering && <Html5Video ref={preview} src={staticFile(src)} muted style={{ opacity: 0, position: "absolute", width: 2, height: 2 }} />}
      <ThreeCanvas width={width} height={height} camera={{ fov: 30, position: [0, 0, 9] }} gl={{ antialias: true }}>
        {isRendering ? <Rig dur={dur} device={device} src={src} /> : <PreviewRig dur={dur} device={device} videoRef={preview} />}
      </ThreeCanvas>
      {title && (
        <div style={{ position: "absolute", width: "100%", top: 70, textAlign: "center", fontFamily: T.font, fontWeight: 650,
          fontSize: T.h2, color: T.fg, letterSpacing: -1.5, opacity: ramp(f, 8, 14) * (1 - ramp(f, flatAt - 15, 12)) }}>
          {title}
        </div>
      )}
      {flatten && f >= flatAt - 2 && (
        <AbsoluteFill style={{ opacity: flat, scale: `${0.9 + 0.1 * flat}` }}>
          <Video src={staticFile(src)} muted style={{ width: "100%", height: "100%" }} />
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};

const PreviewRig: React.FC<{ dur: number; device: "laptop" | "phone"; videoRef: React.RefObject<HTMLVideoElement | null> }> = ({ dur, device, videoRef }) => {
  const tex = useVideoTexture(videoRef);
  return <Body dur={dur} device={device} tex={tex} />;
};

const Rig: React.FC<{ dur: number; device: "laptop" | "phone"; src: string }> = ({ dur, device, src }) => {
  const tex = useOffthreadVideoTexture({ src: staticFile(src) });
  if (tex) tex.colorSpace = THREE.SRGBColorSpace;
  // ThreeCanvas only redraws when the frame number changes; the video frame arrives a moment later,
  // so redraw once it lands (and hold the screenshot until then).
  const { advance } = useThree();
  const { delayRender, continueRender } = useDelayRender();
  useLayoutEffect(() => {
    if (!tex) return;
    const h = delayRender("redraw with video frame");
    advance(performance.now());
    requestAnimationFrame(() => continueRender(h));
  }, [tex, advance, delayRender, continueRender]);
  return <Body dur={dur} device={device} tex={tex} />;
};

const Body: React.FC<{ dur: number; device: "laptop" | "phone"; tex: THREE.Texture | null }> = ({ dur, device, tex }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const settle = Math.min(dur, Math.round(fps * 2.2));
  const rotY = interp(f, [0, settle, dur], [-0.75, -0.12, 0.04]);
  const rotX = interp(f, [0, settle], [0.32, 0.06]);
  const z = interp(f, [0, settle, dur], [-3.2, 0, 0.5]);
  const lid = interp(f, [0, Math.round(fps * 1.4)], [Math.PI / 2 - 0.08, -0.14]);
  const glow = ramp(f, Math.round(fps * 0.8), fps);
  const accent = new THREE.Color(T.accent);
  return (
    <>
      <ambientLight intensity={0.45} />
      <directionalLight position={[4, 6, 6]} intensity={1.6} />
      <directionalLight position={[-6, 2, -4]} intensity={1.2} color={accent} />
      <pointLight position={[0, -1, 3]} intensity={6 * glow} color={accent} distance={8} />
      <group rotation={[rotX, rotY, 0]} position={[0, device === "laptop" ? -0.05 : 0, z]} scale={device === "laptop" ? 0.78 : 1}>
        {device === "laptop" ? (
          <>
            <RoundedBox args={[4.6, 0.16, 3.1]} radius={0.06} position={[0, -1.35, 0.9]}>
              <meshPhysicalMaterial color="#9aa0aa" metalness={0.85} roughness={0.32} clearcoat={0.4} />
            </RoundedBox>
            {/* hinge at the back edge of the base; lid angle 0 = upright, +PI/2 = closed */}
            <group position={[0, -1.27, -0.6]} rotation={[lid, 0, 0]}>
              <group position={[0, 1.5, 0]}>
                <RoundedBox args={[4.6, 2.95, 0.1]} radius={0.06}>
                  <meshPhysicalMaterial color="#8e949e" metalness={0.85} roughness={0.3} />
                </RoundedBox>
                <mesh position={[0, 0.02, 0.056]}>
                  <planeGeometry args={[4.36, 2.45]} />
                  {/* key forces a fresh material once the texture exists (a map added later is otherwise ignored) */}
                  <meshBasicMaterial key={tex ? "video" : "blank"} map={tex ?? undefined} color={tex ? "#fff" : "#000"} toneMapped={false} />
                </mesh>
              </group>
            </group>
          </>
        ) : (
          <>
            <RoundedBox args={[1.65, 3.4, 0.16]} radius={0.22} smoothness={6}>
              <meshPhysicalMaterial color="#1b1d22" metalness={0.6} roughness={0.25} clearcoat={1} />
            </RoundedBox>
            <mesh position={[0, 0, 0.085]}>
              <planeGeometry args={[1.52, 3.24]} />
              {/* key forces a fresh material once the texture exists (a map added later is otherwise ignored) */}
                  <meshBasicMaterial key={tex ? "video" : "blank"} map={tex ?? undefined} color={tex ? "#fff" : "#000"} toneMapped={false} />
            </mesh>
          </>
        )}
      </group>
    </>
  );
};

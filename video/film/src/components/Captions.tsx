import React, { useEffect, useMemo, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { createTikTokStyleCaptions, type Caption } from "@remotion/captions";
import { T } from "../theme";

/** Burned-in captions from public/<file> (made by scripts/captions.py from the final voice), on a strip of paper so they read
 *  over light product UI and over the page alike. The spoken word turns stamp red. One style for the whole film. */
export const Captions: React.FC<{ file: string }> = ({ file }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const [caps, setCaps] = useState<Caption[] | null>(null);
  const [h] = useState(() => delayRender("captions"));
  useEffect(() => {
    fetch(staticFile(file)).then((r) => r.json()).then((c) => { setCaps(c); continueRender(h); }).catch(() => continueRender(h));
  }, [file, h]);
  const pages = useMemo(() => (caps ? createTikTokStyleCaptions({ captions: caps, combineTokensWithinMilliseconds: 1100 }).pages : []), [caps]);
  const ms = (f / fps) * 1000;
  const page = pages.find((p) => ms >= p.startMs && ms < p.startMs + p.durationMs);
  if (!page) return null;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 54, pointerEvents: "none", zIndex: 50 }}>
      <div style={{ maxWidth: 1480, textAlign: "center", fontFamily: T.font, fontWeight: 700, fontSize: 46, lineHeight: 1.22,
        whiteSpace: "pre-wrap", color: T.ink, background: "rgba(251,251,247,0.95)", padding: "12px 26px 14px",
        boxShadow: `0 0 0 1.5px ${T.ink}26, 0 14px 30px -14px rgba(27,30,35,.5)` }}>
        {page.tokens.map((t, i) => {
          const on = ms >= t.fromMs && ms < t.toMs;
          return <span key={i} style={{ display: "inline-block", whiteSpace: "pre", color: on ? T.red : T.ink }}>{t.text}</span>;
        })}
      </div>
    </AbsoluteFill>
  );
};

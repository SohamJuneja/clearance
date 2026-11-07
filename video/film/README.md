# Film toolbox (Remotion 4.0.541)

```bash
cp -r <skill>/assets/remotion-toolbox video/film && cd video/film && npm i
npm run studio                                   # preview, scrub, tweak film.json live
npx remotion still src/index.ts Film out/f.jpg --frame=300   # check a frame
npm run draft                                    # half-res full pass
npm run render                                   # 1080p master picture (out/film.mp4)
npm run scene -- out/S5b.mp4 --frames=975-1244            # one scene as a gfx segment for an ffmpeg edit list
npm run thumb                                    # thumbnail still
```

- `film.json` is the whole film: theme (product colours + display font), scenes in order with durations (seconds),
  transitions, overlays. Scene i starts at the sum of the earlier durations, so voice chunks timed to scene starts
  stay in sync even with transitions.
- Media goes in `public/` (`captures/`, `audio/`, `models/`, `lottie/`) and is referenced relative to it.
- `theme.fontsOffline: true` skips Google Fonts when rendering without network.
- `previewAudio` plays the mixed master in Studio; the final mux happens in `scripts/mix.py`.
- 3D needs WebGL: `remotion.config.ts` uses ANGLE; on a headless box without a GPU try `swangle`.
- The example `film.json` is a placeholder story ("Riverline"): replace every name, quote and number.

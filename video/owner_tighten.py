#!/usr/bin/env python3
"""Tightens the owner's takes so the film fits under four minutes, keeping his lips on his voice.

    python3 video/owner_tighten.py ~/Downloads/clearance-vo.mov [line ids]   (after owner_takes.py; safe to run again)

A take with its own `src` in the report (a line recorded on its own, owner_extra.py) is cut from that file.

Cuts each line again from the recording, at the times owner_takes.py found (narration/owner/report.json). A pause inside a
line longer than KEEP_PAUSE is cut down to KEEP_PAUSE, and a span the report marks as `cut` (a repeated phrase) comes out
whole. The same seconds come out of the voice and the picture, and both play at TEMPO, so the face still matches the voice.
The report gets the new face lead, which faces.py trims, and what was taken out.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "narration/owner")
FACE = os.path.join(HERE, "film/public/face")
TEMPO = 1.07       # about the most a voice can be sped before it stops sounding like the person
KEEP_PAUSE = 0.24  # what's left of a long pause between phrases
PAD_IN, PAD_OUT, FACE_LEAD, FACE_TAIL = 0.12, 0.18, 1.0, 1.2   # as owner_takes.py cuts them
AF = "highpass=f=80,afftdn=nf=-30,afade=t=in:d=0.04,areverse,afade=t=in:d=0.08,areverse"
VF = "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30"


def pauses(src: str, a: float, b: float) -> list[tuple[float, float]]:
    """Silences inside [a, b], in the recording's seconds, from ffmpeg's silencedetect."""
    err = subprocess.run(["ffmpeg", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", src, "-vn", "-af", "silencedetect=n=-38dB:d=0.34",
                          "-f", "null", "-"], capture_output=True, text=True).stderr
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", err)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", err)]
    return [(a + s, a + e) for s, e in zip(starts, ends)]


def removed_spans(src: str, take: dict) -> list[tuple[float, float]]:
    a, b = take["start"] - PAD_IN, take["end"] + PAD_OUT
    spans = [(s + KEEP_PAUSE / 2, e - KEEP_PAUSE / 2) for s, e in pauses(src, a, b) if s > a + 0.05 and e < b - 0.05]
    if take.get("cut"):
        spans.append(tuple(take["cut"]))
    spans.sort()
    merged: list[list[float]] = []
    for s, e in spans:
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return [(s, e) for s, e in merged if e - s > 0.02]


def keep(lo: float, hi: float, gone: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out, cur = [], lo
    for s, e in gone:
        out.append((cur, s))
        cur = e
    out.append((cur, hi))
    return [(s, e) for s, e in out if e - s > 0.01]


def render(src: str, lo: float, segs: list[tuple[float, float]], stream: str, tail: str, outfile: str, extra: list[str]) -> None:
    """Cuts `segs` (recording seconds) out of the window starting at lo, joins them and applies `tail`."""
    trim, setpts = ("atrim", "asetpts") if stream == "a" else ("trim", "setpts")
    parts = "".join(f"[0:{stream}]{trim}={s - lo:.3f}:{e - lo:.3f},{setpts}=PTS-STARTPTS[p{i}];" for i, (s, e) in enumerate(segs))
    join = "".join(f"[p{i}]" for i in range(len(segs))) + f"concat=n={len(segs)}:v={int(stream == 'v')}:a={int(stream == 'a')}"
    hi = segs[-1][1]
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{lo:.3f}", "-to", f"{hi:.3f}", "-i", src,
                    "-filter_complex", f"{parts}{join},{tail}[o]", "-map", "[o]", *extra, outfile], check=True)


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main_src = os.path.expanduser(sys.argv[1])
    only = set(sys.argv[2:])
    path = os.path.join(OUT, "report.json")
    report = json.load(open(path))
    before = after = 0.0
    for lid, take in report.items():
        if not take.get("found") or (only and lid not in only):
            continue
        src = take.get("src", main_src)
        a, b = take["start"] - PAD_IN, take["end"] + PAD_OUT
        gone = removed_spans(src, take)
        voice = keep(a, b, gone)
        render(src, a, voice, "a", f"aformat=channel_layouts=mono,aresample=48000,{AF},atempo={TEMPO}",
               os.path.join(OUT, f"{lid}.wav"), ["-ac", "1", "-ar", "48000"])
        fa, fb = max(0.0, a - FACE_LEAD), b + FACE_TAIL
        picture = keep(fa, fb, gone)
        render(src, fa, picture, "v", f"setpts=PTS/{TEMPO},{VF}", os.path.join(FACE, f"{lid}.mp4"),
               ["-an", "-c:v", "libx264", "-crf", "18", "-preset", "veryfast"])
        took = sum(e - s for s, e in gone)
        before += b - a
        after += (b - a - took) / TEMPO
        take.update(face_lead=round((a - fa) / TEMPO, 3), tightened={"tempo": TEMPO, "keep_pause": KEEP_PAUSE,
                    "removed": [[round(s, 2), round(e, 2)] for s, e in gone]})
        print(f"{lid:5} {b - a:5.2f}s -> {(b - a - took) / TEMPO:5.2f}s  ({len(gone)} pauses or cuts)")
    json.dump(report, open(path, "w"), indent=1)
    print(f"voice {before:.1f}s -> {after:.1f}s")


if __name__ == "__main__":
    main()

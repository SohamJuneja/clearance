#!/usr/bin/env python3
"""Cuts the film's product footage from the real recorded takes, with no captions or labels burned in.

    python3 video/cut.py            every clip
    python3 video/cut.py sc3 scho   just these

Each clip is data: which take, which seconds, at what speed. Seconds come from the take's own marks.json (the recorder's
record of when each scenario step happened), so a re-recorded take re-cuts by itself. Waiting for an agent is sped up; every
sped-up stretch is written to captures/<id>.json so the film can label it on screen. Two people side by side are cropped to
the chat column, as the earlier cut was. Output: video/film/public/captures/<id>.mp4, 1920x1080, 30 fps, no audio.
"""
import json
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TAKES = os.path.join(REPO, "docs/media/raw/takes")
OUT = os.path.join(REPO, "video/film/public/captures")
PAPER = "0xECEEE7"
CROP = (270, 90, 690, 855)  # the chat column of a 960x1080 half, as the earlier cut used


def marks(take: str) -> dict:
    with open(os.path.join(TAKES, take, "marks.json")) as f:
        return {m["label"]: m["t"] for m in json.load(f)}


def at(take: str, label_start: str) -> float:
    for label, t in marks(take).items():
        if label.startswith(label_start):
            return t
    raise SystemExit(f"{take}: no mark starting {label_start!r}")


def duration(path: str) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True, check=True).stdout
    return float(out.strip())


# id -> take, the people shown (one file each), and segments (start, end, speed). Start and end are seconds or mark prefixes.
CLIPS = {
    "sc2": {"take": "SC2/6", "people": ["priya"], "segments": [
        (0.0, 3.0, 1.0),
        (3.0, "The agent says so in the room", 14.0),
        ("The agent says so in the room", None, 1.2),
    ]},
    "sc3": {"take": "SC3/latest", "people": ["priya", "sam"], "segments": [
        (0.0, "The refund is held", 1.0),
        ("The refund is held", 33.5, 12.0),
        (33.5, None, 1.0),
    ]},
    "scho": {"take": "SCHO/latest", "people": ["priya", "dev"], "segments": [
        ("Priya asks refunds-agent", "The gate refuses refunds-agent", 1.2),
        ("The gate refuses refunds-agent", "refunds-agent hands the work", 2.0),
        ("refunds-agent hands the work", "The hand-off says who asked", 6.0),
        ("The hand-off says who asked", None, 1.2),
    ]},
    "sc6": {"take": "SC6/latest", "people": ["alex"], "segments": [
        (0.0, 3.0, 1.5),
        (3.0, 70.5, 35.0),
        (70.5, 84.5, 1.6),
    ]},
    "sc8": {"take": "SC8/latest", "people": ["sam", "neha"], "segments": [
        (0.0, "After the escalation timer", 1.5),
        ("After the escalation timer", "Sam's DMs show Needs your response", 12.0),
        ("Sam's DMs show Needs your response", 30.0, 1.2),
    ]},
    "sc9": {"take": "SC9/latest", "people": ["sam"], "segments": [
        (0.0, "A real high-risk request arrives", 1.6),
        ("A real high-risk request arrives", "Sam's next card asks", 12.0),
        ("Sam's next card asks", None, 2.6),
    ]},
    "sc11": {"take": "SC11/latest", "people": ["sam", "alex"], "segments": [
        (0.0, "Priya asks for a small refund", 2.0),
        ("Priya asks for a small refund", "Sam reports an incident", 14.0),
        ("Sam reports an incident", 48.0, 1.5),
    ]},
}


def resolve(take: str, point, end_of: float) -> float:
    if point is None:
        return end_of
    if isinstance(point, (int, float)):
        return float(point)
    return at(take, point)


def cut(clip_id: str, spec: dict) -> None:
    take = spec["take"]
    files = [os.path.join(TAKES, take, f"{p}.mp4") for p in spec["people"]]
    end_of = min(duration(f) for f in files)
    segs = []
    for start, end, speed in spec["segments"]:
        a, b = resolve(take, start, end_of), resolve(take, end, end_of)
        if b - a < 0.05:
            continue
        segs.append((round(a, 3), round(b, 3), speed))

    inputs, filters = [], []
    for i, f in enumerate(files):
        inputs += ["-i", f]
        parts = []
        for j, (a, b, speed) in enumerate(segs):
            label = f"v{i}s{j}"
            filters.append(f"[{i}:v]trim=start={a}:end={b},setpts=(PTS-STARTPTS)/{speed}[{label}]")
            parts.append(f"[{label}]")
        filters.append(f"{''.join(parts)}concat=n={len(parts)}:v=1:a=0,fps=30[c{i}]")
        if len(files) == 2:
            x, y, w, h = CROP
            filters.append(f"[c{i}]crop={w}:{h}:{x}:{y},scale=-2:1040:flags=lanczos,pad=960:1080:(ow-iw)/2:(oh-ih)/2:color={PAPER}[p{i}]")
        else:
            filters.append(f"[c{i}]scale=1920:1080:flags=lanczos[p{i}]")
    if len(files) == 2:
        filters.append("[p0][p1]hstack=inputs=2,format=yuv420p,tpad=stop_mode=clone:stop_duration=3[out]")
    else:
        filters.append("[p0]format=yuv420p,tpad=stop_mode=clone:stop_duration=3[out]")

    os.makedirs(OUT, exist_ok=True)
    target = os.path.join(OUT, f"{clip_id}.mp4")
    cmd = ["ffmpeg", "-loglevel", "error", "-y", *inputs, "-filter_complex", ";".join(filters), "-map", "[out]",
           "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-r", "30", target]
    subprocess.run(cmd, check=True)

    # Where each stretch sits in the cut, so the film labels the sped-up ones and knows when each step happens.
    timeline, t = [], 0.0
    for a, b, speed in segs:
        length = (b - a) / speed
        timeline.append({"from": round(t, 3), "to": round(t + length, 3), "speed": speed, "take_from": a, "take_to": b})
        t += length
    steps = []
    for label, mt in marks(take).items():
        for s in timeline:
            if s["take_from"] <= mt <= s["take_to"]:
                steps.append({"label": label, "at": round(s["from"] + (mt - s["take_from"]) / s["speed"], 3)})
                break
    meta = {"take": os.path.realpath(os.path.join(TAKES, take)).split("/takes/")[1], "people": spec["people"],
            "seconds": round(t, 3), "held_after": 3, "segments": timeline, "steps": steps}
    with open(os.path.join(OUT, f"{clip_id}.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(f"{clip_id}: {t:5.1f} s from {meta['take']}, speeds {[s['speed'] for s in timeline]}")


if __name__ == "__main__":
    wanted = sys.argv[1:] or list(CLIPS)
    for clip_id in wanted:
        cut(clip_id, CLIPS[clip_id])

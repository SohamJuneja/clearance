#!/usr/bin/env python3
"""Cuts the owner's own takes out of one face-and-voice recording, so his voice replaces the narrator line by line.

    ~/.pyenv/versions/3.10.13/bin/python video/owner_takes.py ~/Downloads/clearance-vo.mp4

Transcribes once with faster-whisper (word times, cached next to the output), finds every script line's takes by word match,
and keeps the best one (the highest match; on a near tie, the later take, which is usually the steadier read). Writes:
  video/narration/owner/<id>.wav        the line's voice: 48 kHz mono, a little padding, rumble and hiss taken down
  video/film/public/face/<id>.mp4       the same seconds of picture, for the face bubble and the full-frame lines
  video/narration/owner/report.json     each line's take, its match, and any line it couldn't find
Script lines are video/narration.json's captions (owner_caption where his words differ). Line 7 is read as one line and split
at its second sentence into l07a and l07b, which play over two scenes.
"""
import difflib
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "narration/owner")
FACE = os.path.join(HERE, "film/public/face")
NUMS = {"71%": "seventy one percent", "21%": "twenty one percent", "80%": "eighty percent", "93%": "ninety three percent",
        "₹40,000": "forty thousand rupee", "6,500": "six and a half thousand"}


def norm(text: str) -> list[str]:
    for k, v in NUMS.items():
        text = text.replace(k, v)
    text = text.lower().replace("-", " ")
    return re.findall(r"[a-z0-9']+", text)


def transcribe(src: str) -> list[dict]:
    cache = os.path.join(OUT, "words.json")
    if os.path.exists(cache) and json.load(open(cache)).get("src") == os.path.realpath(src):
        return json.load(open(cache))["words"]
    from faster_whisper import WhisperModel
    model = WhisperModel("medium.en", device="cuda", compute_type="float16")
    segments, _ = model.transcribe(src, word_timestamps=True, vad_filter=True, beam_size=5)
    words = [{"w": w.word.strip(), "s": w.start, "e": w.end} for seg in segments for w in seg.words]
    json.dump({"src": os.path.realpath(src), "words": words}, open(cache, "w"))
    return words


def find_takes(line: str, words: list[dict]) -> list[tuple[float, int, int]]:
    """Every non-overlapping window of the transcript that reads like this line: (match, first word, last word)."""
    target = norm(line)
    heard = [norm(w["w"]) for w in words]
    flat = [" ".join(h) for h in heard]
    n = len(target)
    cands = []
    for i in range(len(words)):
        if not heard[i] or (heard[i][0] not in target[:4]):
            continue
        for length in range(max(1, int(n * 0.7)), int(n * 1.35) + 1):
            j = i + length
            if j > len(words):
                break
            window = " ".join(flat[i:j]).split()
            r = difflib.SequenceMatcher(None, target, window).ratio()
            if r >= 0.6:
                cands.append((r, i, j - 1))
    cands.sort(reverse=True)
    picked: list[tuple[float, int, int]] = []
    for c in cands:
        if all(c[2] < p[1] or c[1] > p[2] for p in picked):
            picked.append(c)
    return picked


def cut(src: str, start: float, end: float, wav: str, mp4: str) -> None:
    a, b = max(0.0, start - 0.12), end + 0.18
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", src, "-vn", "-ac", "1", "-ar", "48000",
                    "-af", "highpass=f=80,afftdn=nf=-30,afade=t=in:d=0.04,areverse,afade=t=in:d=0.08,areverse", wav], check=True)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", src, "-an", "-vf", "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30",
                    "-c:v", "libx264", "-crf", "18", "-preset", "medium", mp4], check=True)


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = os.path.expanduser(sys.argv[1])
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(FACE, exist_ok=True)
    lines = json.load(open(os.path.join(HERE, "narration.json"), encoding="utf8"))
    words = transcribe(src)
    by_id = {l["id"]: l.get("owner_caption") or l["caption"] for l in lines}
    script = [(i, by_id[i]) for i in by_id if i not in ("l07a", "l07b")]
    script.insert(next(k for k, (i, _) in enumerate(script) if i == "l08"), ("l07", by_id["l07a"] + " " + by_id["l07b"]))
    report = {}
    for lid, text in script:
        takes = find_takes(text, words)
        if not takes:
            report[lid] = {"found": False}
            print(f"{lid:5} NOT FOUND  {text[:70]}")
            continue
        best = takes[0]
        later = [t for t in takes if t[0] >= best[0] - 0.03 and t[1] > best[1]]
        r, i, j = later[-1] if later else best
        if lid == "l07":
            # split after "approve it": the first word of the second sentence starts l07b
            split = next((k for k in range(i, j + 1) if norm(words[k]["w"]) == ["clearance"] and k > i + 3), None)
            if split is None:
                report[lid] = {"found": False, "why": "couldn't find where the second sentence starts"}
                continue
            parts = [("l07a", i, split - 1), ("l07b", split, j)]
        else:
            parts = [(lid, i, j)]
        for pid, a, b in parts:
            cut(src, words[a]["s"], words[b]["e"], os.path.join(OUT, f"{pid}.wav"), os.path.join(FACE, f"{pid}.mp4"))
            report[pid] = {"found": True, "match": round(r, 3), "start": words[a]["s"], "end": words[b]["e"], "takes": len(takes),
                           "heard": " ".join(w["w"] for w in words[a:b + 1])}
            print(f"{pid:5} {r:.2f}  {words[a]['s']:7.2f}-{words[b]['e']:7.2f}  {report[pid]['heard'][:80]}")
    json.dump(report, open(os.path.join(OUT, "report.json"), "w"), indent=1)
    missing = [k for k, v in report.items() if not v.get("found")]
    print(f"{len(report) - len(missing)} lines cut" + (f"; not found: {', '.join(missing)}" if missing else ""))


if __name__ == "__main__":
    main()

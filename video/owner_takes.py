#!/usr/bin/env python3
"""Cuts the owner's own takes out of one face-and-voice recording, so his voice replaces the narrator line by line.

    ~/.pyenv/versions/3.10.13/bin/python video/owner_takes.py ~/Downloads/clearance-vo.mp4

Transcribes once with faster-whisper (word times, cached next to the output), finds every script line's takes by word match,
and keeps the best one (the highest match; on a near tie, the later take, which is usually the steadier read). Writes:
  video/narration/owner/<id>.wav        the line's voice: 48 kHz mono, a little padding, rumble and hiss taken down
  video/film/public/face/<id>.mp4       the same seconds of picture with up to 1 s before and 1.2 s after (its lead is in the report)
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


ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def say(n: int) -> str:
    """A number as he'll say it: 71 -> seventy one, 40000 -> forty thousand, 6500 -> six and a half thousand."""
    if n == 6500:
        return "six and a half thousand"
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + ("" if n % 10 == 0 else " " + ONES[n % 10])
    if n % 1000 == 0 and n < 100000:
        return say(n // 1000) + " thousand"
    return " ".join(ONES[int(d)] for d in str(n))


def canon(text: str) -> str:
    """Script and transcript in one spelling: letters only, numbers in words, so "Open Code" matches "OpenCode", "71 %" matches
    "seventy-one percent" and "40 ,000" matches "40,000"."""
    t = re.sub(r"₹\s*(\d[\d,]*)", lambda m: m.group(1).replace(",", "") + " rupee", text.lower()).replace("%", " percent ")
    t = re.sub(r"(\d)\s*,\s*(\d{3})", r"\1\2", t)
    t = re.sub(r"\d+", lambda m: " " + say(int(m.group())) + " ", t)
    return re.sub(r"[^a-z]", "", t)


def transcribe(src: str) -> list[dict]:
    cache = os.path.join(OUT, "words.json")
    if os.path.exists(cache) and json.load(open(cache)).get("src") == os.path.realpath(src):
        return json.load(open(cache))["words"]
    try:
        import torch  # loads the CUDA libraries torch ships (libcublas.so.12), which faster-whisper can't find on its own here
        devices = ["cuda", "cpu"] if torch.cuda.is_available() else ["cpu"]
    except ImportError:
        devices = ["cpu"]
    from faster_whisper import WhisperModel
    for dev in devices:
        try:
            model = WhisperModel("medium.en", device=dev, compute_type="float16" if dev == "cuda" else "int8")
            segments, _ = model.transcribe(src, word_timestamps=True, vad_filter=True, beam_size=5)
            words = [{"w": w.word.strip(), "s": w.start, "e": w.end} for seg in segments for w in seg.words]
            break
        except RuntimeError as error:  # the GPU fails lazily, mid-transcription; the CPU is slower but always there
            if dev == devices[-1]:
                raise
            print(f"whisper on {dev} failed ({error}); trying the CPU")
    json.dump({"src": os.path.realpath(src), "words": words}, open(cache, "w"))
    return words


def find_takes(line: str, words: list[dict]) -> list[tuple[float, int, int]]:
    """Every non-overlapping window of the transcript that reads like this line: (match, first word, last word)."""
    target = norm(line)
    heard = [norm(w["w"]) for w in words]
    want = canon(line)
    n = len(target)
    cands = []
    for i in range(len(words)):
        if not heard[i] or (heard[i][0] not in target[:5]):
            continue
        for length in range(max(1, int(n * 0.6)), int(n * 1.35) + 1):
            j = i + length
            if j > len(words):
                break
            # letters, not words: a window that drops a misheard first word ("Open Code") always scores lower than one that keeps it
            r = difflib.SequenceMatcher(None, want, canon(" ".join(w["w"] for w in words[i:j])), autojunk=False).ratio()
            if r >= 0.72:
                cands.append((r, i, j - 1))
    cands.sort(reverse=True)
    picked: list[tuple[float, int, int]] = []
    for c in cands:
        if all(c[2] < p[1] or c[1] > p[2] for p in picked):
            picked.append(c)
    return picked


FACE_LEAD, FACE_TAIL = 1.0, 1.2  # picture kept around the voice, so a full-frame shot can line up with it and hold after it


def cut(src: str, start: float, end: float, wav: str, mp4: str) -> float:
    """Cuts the voice tight and the picture with up to FACE_LEAD before it; returns that lead, which faces.py trims so lips match."""
    a, b = max(0.0, start - 0.12), end + 0.18
    fa, fb = max(0.0, a - FACE_LEAD), b + FACE_TAIL
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", src, "-vn", "-ac", "1", "-ar", "48000",
                    "-af", "highpass=f=80,afftdn=nf=-30,afade=t=in:d=0.04,areverse,afade=t=in:d=0.08,areverse", wav], check=True)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{fa:.3f}", "-to", f"{fb:.3f}", "-i", src, "-an", "-vf", "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30",
                    "-c:v", "libx264", "-crf", "18", "-preset", "medium", mp4], check=True)
    return round(a - fa, 3)


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
            lead = cut(src, words[a]["s"], words[b]["e"], os.path.join(OUT, f"{pid}.wav"), os.path.join(FACE, f"{pid}.mp4"))
            report[pid] = {"found": True, "match": round(r, 3), "start": words[a]["s"], "end": words[b]["e"], "takes": len(takes),
                           "face_lead": lead, "heard": " ".join(w["w"] for w in words[a:b + 1])}
            print(f"{pid:5} {r:.2f}  {words[a]['s']:7.2f}-{words[b]['e']:7.2f}  {report[pid]['heard'][:80]}")
    json.dump(report, open(os.path.join(OUT, "report.json"), "w"), indent=1)
    missing = [k for k, v in report.items() if not v.get("found")]
    print(f"{len(report) - len(missing)} lines cut" + (f"; not found: {', '.join(missing)}" if missing else ""))


if __name__ == "__main__":
    main()

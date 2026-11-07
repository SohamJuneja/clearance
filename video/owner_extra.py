#!/usr/bin/env python3
"""Adds one line the owner recorded on its own, after the main recording, to his takes.

    ~/.pyenv/versions/3.10.13/bin/python video/owner_extra.py ~/Downloads/wispr-line.mov l20w

Transcribes the clip, finds the line's best take the way owner_takes.py does, records it in narration/owner/report.json with
the clip as its source, and cuts it the way owner_tighten.py cuts every take (pauses shortened, voice and face at TEMPO).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import owner_takes as ot  # noqa: E402
import owner_tighten as tight  # noqa: E402


def main() -> None:
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    src, lid = os.path.realpath(os.path.expanduser(sys.argv[1])), sys.argv[2]
    from faster_whisper import WhisperModel
    import torch  # noqa: F401  (loads the CUDA libraries faster-whisper needs here)
    model = WhisperModel("medium.en", device="cuda" if torch.cuda.is_available() else "cpu",
                         compute_type="float16" if torch.cuda.is_available() else "int8")
    segments, _ = model.transcribe(src, word_timestamps=True, vad_filter=True, beam_size=5)
    words = [{"w": w.word.strip(), "s": w.start, "e": w.end} for seg in segments for w in seg.words]
    lines = {l["id"]: l.get("owner_caption") or l["caption"] for l in json.load(open(os.path.join(ot.HERE, "narration.json"), encoding="utf8"))}
    takes = ot.find_takes(lines[lid], words)
    if not takes:
        sys.exit(f"{lid} not found in {src}: heard {' '.join(w['w'] for w in words)!r}")
    best = takes[0]
    later = [t for t in takes if t[0] >= best[0] - 0.03 and t[1] > best[1]]
    r, i, j = later[-1] if later else best
    path = os.path.join(ot.OUT, "report.json")
    report = json.load(open(path))
    report[lid] = {"found": True, "match": round(r, 3), "start": words[i]["s"], "end": words[j]["e"], "takes": len(takes),
                   "src": src, "heard": " ".join(w["w"] for w in words[i:j + 1])}
    json.dump(report, open(path, "w"), indent=1)
    sys.argv = [sys.argv[0], src, lid]
    tight.main()
    print(f"{lid} {r:.2f} {report[lid]['heard']}")


if __name__ == "__main__":
    main()

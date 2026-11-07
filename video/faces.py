#!/usr/bin/env python3
"""Puts the owner on screen once his takes exist: his first line full frame with his name, then his face in a bubble over every
line he speaks on top of the product. Run after vo_timeline.py has set the scene lengths from his voice.

    python3 video/faces.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FILM = os.path.join(HERE, "film/film.json")


def main() -> None:
    film = json.load(open(FILM, encoding="utf8"))
    tl = json.load(open(os.path.join(HERE, "narration/timeline.json")))
    starts = {s["id"]: s["start"] for s in tl["scenes"]}
    have = lambda lid: os.path.exists(os.path.join(HERE, "film/public/face", f"{lid}.mp4"))
    for i, sc in enumerate(film["scenes"]):
        if sc["id"] == "S01" and have("l01"):
            film["scenes"][i] = {"id": "S01", "type": "footage", "src": "face/l01.mp4", "grade": "story", "push": "in",
                                 "person": {"name": "Prashant", "role": "Team dellfargo · built Clearance on Switch", "at": 0.5},
                                 "duration": sc["duration"], "transition": sc.get("transition", {"type": "tear", "dur": 0.6})}
    by_id = {sc["id"]: sc for sc in film["scenes"]}
    for line in tl["lines"]:
        sid = line["scene"]
        if sid in ("S00", "S01") or not have(line["id"]):
            continue
        sc = by_id[sid]
        sc["overlays"] = [o for o in sc.get("overlays", []) if not (o.get("kind") == "face" and o.get("src") == f"face/{line['id']}.mp4")]
        sc["overlays"].append({"kind": "face", "src": f"face/{line['id']}.mp4", "at": round(line["start"] - starts[sid] - 0.05, 3),
                               "dur": round(line["end"] - line["start"] + 0.3, 3), "x": 0.095, "y": 0.7, "w": 260})
    json.dump(film, open(FILM, "w", encoding="utf8"), indent=1, ensure_ascii=False)
    print(f"faces: S01 full frame: {have('l01')}; bubbles on {sum(1 for l in tl['lines'] if l['scene'] not in ('S00', 'S01') and have(l['id']))} lines")


if __name__ == "__main__":
    main()

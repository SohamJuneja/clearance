#!/usr/bin/env python3
"""Puts the owner on screen once his takes exist: full frame for his first line and for the close, with his name first, and his
face in a bubble over every other line he speaks on top of the product. Run after vo_timeline.py has set the scene lengths from
his voice.

    python3 video/faces.py

Each face clip starts up to a second before its voice (owner_takes.py records that lead in narration/owner/report.json), and
every shot here trims the clip so the picture's first spoken frame lands on the voice's: lips match to the frame.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FILM = os.path.join(HERE, "film/film.json")
FULL = {"S01": "l01", "S21": "l25"}  # full-frame lines: the opening and the close, which calls back to it


def main() -> None:
    film = json.load(open(FILM, encoding="utf8"))
    tl = json.load(open(os.path.join(HERE, "narration/timeline.json")))
    report_path = os.path.join(HERE, "narration/owner/report.json")
    report = json.load(open(report_path)) if os.path.exists(report_path) else {}
    lead = lambda lid: float(report.get(lid, {}).get("face_lead", 0.0))
    starts = {s["id"]: s["start"] for s in tl["scenes"]}
    lines = {l["id"]: l for l in tl["lines"]}
    have = lambda lid: os.path.exists(os.path.join(HERE, "film/public/face", f"{lid}.mp4"))
    full = []
    for i, sc in enumerate(film["scenes"]):
        lid = FULL.get(sc["id"])
        if not lid or not have(lid) or lid not in lines:
            continue
        offset = lines[lid]["start"] - starts[sc["id"]]  # where his voice starts in the scene
        trim = lead(lid) - offset
        if trim < 0:
            print(f"faces: {lid} has {lead(lid):.2f} s of picture before the voice, {offset:.2f} s needed; lips lead by {-trim:.2f} s")
        new = {"id": sc["id"], "type": "footage", "src": f"face/{lid}.mp4", "trimBefore": round(max(0.0, trim), 3), "grade": "story",
               "push": "in", "duration": sc["duration"], "transition": sc.get("transition", {"type": "tear", "dur": 0.6})}
        if sc["id"] == "S01":
            new["person"] = {"name": "Prashant", "role": "Team dellfargo · built Clearance on Switch", "at": 0.5}
        else:
            # the recap's lines stay on screen, pinned beside him as the film's paper labels, each as he gets to it
            d, n = sc["duration"], len(sc.get("lines", []))
            new["overlays"] = [{"kind": "label", "text": t, "at": round(0.25 + k * (d - 1.6) / max(1, n), 2), "dur": round(d, 2),
                                "x": 0.76, "y": round(0.3 + 0.12 * k, 2), "tone": "accent" if k == 0 else "plain"}
                               for k, t in enumerate(sc.get("lines", []))]
        film["scenes"][i] = new
        full.append(lid)
    by_id = {sc["id"]: sc for sc in film["scenes"]}
    bubbles = 0
    for line in tl["lines"]:
        sid = line["scene"]
        if sid == "S00" or line["id"] in full or not have(line["id"]):
            continue
        sc = by_id[sid]
        sc["overlays"] = [o for o in sc.get("overlays", []) if not (o.get("kind") == "face" and o.get("src") == f"face/{line['id']}.mp4")]
        sc["overlays"].append({"kind": "face", "src": f"face/{line['id']}.mp4", "at": round(line["start"] - starts[sid], 3),
                               "trimBefore": lead(line["id"]), "dur": round(line["end"] - line["start"] + 0.3, 3),
                               "x": 0.095, "y": 0.7, "w": 260})
        bubbles += 1
    json.dump(film, open(FILM, "w", encoding="utf8"), indent=1, ensure_ascii=False)
    print(f"faces: full frame on {', '.join(full) or 'none'}; bubbles on {bubbles} lines")


if __name__ == "__main__":
    main()

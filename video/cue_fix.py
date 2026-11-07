#!/usr/bin/env python3
"""Finishes sfx_cues.json for this film: the tear-offs get the paper tear instead of a whoosh, nothing plays under the team's
intro (it has its own sound), and the effects come from ~/Videos/clearance/audio/sfx. Also sets mix.json's length to the voice's."""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
cues = json.load(open(os.path.join(HERE, "sfx_cues.json")))
film = json.load(open(os.path.join(HERE, "film/film.json")))
t, tears = 0.0, []
for s in film["scenes"]:
    t += s["duration"]
    if (s.get("transition") or {}).get("type") == "tear":
        tears.append(t)
intro = next((s["duration"] for s in film["scenes"] if s["id"] == "S00"), 0)
for q in cues["cues"]:
    if q["sfx"] in ("whoosh", "whoosh_heavy") and any(abs(q["t"] - x) < 0.8 for x in tears):
        q["sfx"], q["db"] = "tear", -14
cues["cues"] = [q for q in cues["cues"] if q["t"] >= intro - 0.4]
cues["dir"] = os.path.expanduser("~/Videos/clearance/audio/sfx")
json.dump(cues, open(os.path.join(HERE, "sfx_cues.json"), "w"), indent=1)
mix = json.load(open(os.path.join(HERE, "mix.json")))
tl = json.load(open(os.path.join(HERE, "narration/timeline.json")))
mix["duration"] = tl["duration"]
mix["music"][-1]["end"] = tl["duration"]
json.dump(mix, open(os.path.join(HERE, "mix.json"), "w"), indent=1)
print(f"cues: {len(cues['cues'])}, film {tl['duration']} s")

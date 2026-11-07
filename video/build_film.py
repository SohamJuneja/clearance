#!/usr/bin/env python3
"""Writes video/film/film.json, the whole film as data, from the repo's own facts.

    python3 video/build_film.py

- Numbers come from facts.py (the results table eval/report.ts writes), never typed here.
- Every stamp and label on real footage is placed at the second the cut's own record says that step happened
  (video/film/public/captures/<id>.json, written by cut.py from the take's marks), so a re-cut moves them with it.
- Facts about the world come from video/cited.json, each with its source, shown on screen.
Scene durations are placeholders until vo_timeline.py --write sets them from the voice.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from facts import facts, row, table  # noqa: E402

CAPS = os.path.join(HERE, "film/public/captures")
NOTE = "Real agents in real Switch rooms on Mattermost. People's presses are scripted. The company is synthetic."


def step(clip: str, prefix: str) -> float:
    meta = json.load(open(os.path.join(CAPS, f"{clip}.json")))
    for s in meta["steps"]:
        if s["label"].startswith(prefix):
            return s["at"]
    raise SystemExit(f"{clip}: no step starting {prefix!r}")


def clip_len(clip: str) -> float:
    return json.load(open(os.path.join(CAPS, f"{clip}.json")))["seconds"]


def screen(sid, clip, title, overlays, extra_min=0.8):
    return {"id": sid, "type": "screen", "src": f"captures/{clip}.mp4", "meta": f"captures/{clip}.json", "title": title,
            "note": NOTE, "duration": round(clip_len(clip) + extra_min, 2), "min": round(clip_len(clip) + extra_min, 2),
            "overlays": overlays, "transition": {"type": "tear", "dur": 0.6}}


def stamp(text, at, x, y, sub=None, color="red", w=440, rot=-8, dur=60):
    o = {"kind": "stamp", "text": text, "at": round(at, 2), "dur": dur, "x": x, "y": y, "w": w, "rot": rot, "color": color}
    if sub:
        o["sub"] = sub
    return o


def label(text, at, x, y, tone="plain", dur=3.2):
    return {"kind": "label", "text": text, "at": round(at, 2), "dur": dur, "x": x, "y": y, "tone": tone}


def main():
    f = facts()
    rows = table()
    e1 = row(rows, "E1", "Bad outcomes prevented")
    risky = row(rows, "E2", "Risky actions executed")
    bl = row(rows, "BL", "Real runs, no Clearance")
    soak = row(rows, "E4", "Soak invariant violations")
    lat = row(rows, "E4", "Added latency")
    cited = json.load(open(os.path.join(HERE, "cited.json")))

    # left half / right half of a two-person split, in frame fractions
    L, R = 0.3, 0.7
    scenes = [
        # The team's own intro, with its own sound: it ends on "Here's the real thing", which the real footage answers.
        {"id": "S00", "type": "footage", "src": "footage/intro.mp4", "grade": "none", "push": "none", "duration": 31, "min": 31,
         "transition": {"type": "tear", "dur": 0.6}},
        {"id": "S01", "type": "stampcard", "duration": 7, "min": 5, "kicker": "Clearance · built on Switch",
         "lines": ["The person who asks", "can't be the one", "who approves."], "emphasis": ["can't"],
         "copy": {"id": "CLR-0001", "kind": "REFUND ₹4,000", "foot": "Drawn from a real card in the demo.",
                  "rows": [["The call", "Refund ₹4,000 to Meera K."], ["Flags", "Payment ID added today"], ["Asked by", "Priya"],
                           ["Approve", "Priya pressed ✓"]]},
         "stamp": {"text": "REQUESTER", "sub": "CAN'T APPROVE · CLR-0001", "at": 2.4}, "transition": {"type": "tear", "dur": 0.6}},

        screen("S02", "sc2", "Switch today, without Clearance", [
            label("Native Switch card · Priya asked", step("sc2", "Every native card") + 0.4, 0.5, 0.2),
            stamp("SELF-APPROVED", step("sc2", "The agent says so in the room") + 0.3, 0.52, 0.55, sub="₹40,000 WENT OUT", w=520),
        ]),

        {"id": "S03", "type": "bigfigures", "duration": 7, "min": 6, "title": "We ran it with real agents.",
         "figures": [{"value": f["BL_ASK"], "label": "runs where the ₹40,000 refund went out, with Switch's approval cards on",
                      "note": bl["data"], "tone": "bad"}],
         "transition": {"type": "tear", "dur": 0.6}},

        {"id": "S04", "type": "facts", "duration": 18, "min": 16, "kicker": "How big this is",
         "rows": [{"text": c["text"], "source": c["source"]} for c in cited],
         "transition": {"type": "tear", "dur": 0.6}},

        {"id": "S05", "type": "kinetic", "duration": 6, "min": 5.5, "kicker": "Separation of duties",
         "lines": ["Whoever asks for a payment", "can't approve it."], "emphasis": ["can't"],
         "overlays": [label("US GAO Green Book, 2025: “no one individual controls all key aspects of a transaction”", 1.6, 0.5, 0.82, dur=5)],
         "transition": {"type": "tear", "dur": 0.6}},

        {"id": "S06", "type": "stampcard", "duration": 5, "min": 4.5, "kicker": "Clearance",
         "lines": ["Puts the rule back,", "for every agent", "on Switch."], "emphasis": ["Switch."],
         "copy": {"id": "CLR-0001", "kind": "HELD", "foot": "The room, the approver, the ledger.",
                  "rows": [["Asked by", "Priya, in #support"], ["Decides", "Sam, finance, on duty"], ["Runs", "Exactly this call, once"]]},
         "stamp": {"text": "HELD", "sub": "UNTIL THE RIGHT PERSON DECIDES", "at": 1.6, "color": "violet"},
         "transition": {"type": "tear", "dur": 0.6}},

        screen("S07", "sc3", "Refunds: whoever asks can't approve", [
            label("Held at the gate", step("sc3", "The refund is held") + 0.2, L, 0.2, tone="accent"),
            label("Card built from the real call", step("sc3", "The card reaches Sam") + 0.1, R, 0.2),
            stamp("REQUESTER", step("sc3", "Clearance refuses Priya"), L, 0.6, sub="PRIYA CAN'T APPROVE"),
            stamp("DENIED", step("sc3", "Sam denies") + 0.6, R, 0.6, sub="BY SAM · FINANCE", w=380, rot=-6),
        ]),

        screen("S08", "scho", "Code: Switch's room roles route the work", [
            label("Gate: a merge isn't this agent's job", step("scho", "The gate refuses refunds-agent") + 0.2, L, 0.2, tone="accent"),
            label("@merges · a Switch room role", step("scho", "refunds-agent hands the work") + 0.2, L, 0.28),
            label("Card reaches Dev", step("scho", "The card reaches Dev") + 0.1, R, 0.2),
            stamp("REQUESTER", step("scho", "Clearance refuses Priya"), L, 0.6, sub="PRIYA CAN'T APPROVE"),
            stamp("DENIED", step("scho", "Dev denies it") + 0.3, R, 0.62, sub="BY DEV", w=360, rot=-6, dur=8),
        ]),

        screen("S09", "sc6", "Deploys: the service owner decides", [
            label("OpenCode agent · same policy file", 0.6, 0.5, 0.2, tone="accent", dur=3.5),
            label("2 failing checks on the card", step("sc6", "The card reaches Alex") + 0.3, 0.5, 0.2),
            stamp("NOT TO PROD", step("sc6", "Alex chooses No") + 0.2, 0.55, 0.58, sub="BY ALEX · SERVICE OWNER", w=500),
        ]),

        screen("S10", "sc8", "Nobody answers: it escalates", [
            label("Sam doesn't answer", step("sc8", "The card reaches Sam") - 2.5, L, 0.2, dur=3),
            label("Escalation timer → Neha", step("sc8", "After the escalation timer") + 0.2, R, 0.2, tone="accent"),
            stamp("NOTHING MOVED", step("sc8", "Acme: nothing has moved") + 0.2, 0.5, 0.6, sub="WHILE NOBODY ANSWERED", color="green", w=520),
        ]),

        screen("S11", "sc9", "Rubber-stamping: drills and type-to-confirm", [
            label("Practice request · planted flaw", step("sc9", "A card that looks like any other") + 0.2, 0.5, 0.2, tone="accent"),
            stamp("DRILL MISSED", step("sc9", "Sam approves straight away") + 0.5, 0.5, 0.55, sub="TOLD PRIVATELY · NO MONEY MOVED", w=520),
            label("Real card: type a detail from the evidence", step("sc9", "Sam's next card asks") + 0.2, 0.5, 0.2, dur=4),
        ]),

        screen("S12", "sc11", "Earned autonomy, signed by two people", [
            label("Two people sign the promotion", step("sc11", "Sam approves the promotion"), 0.5, 0.2, tone="accent"),
            stamp("DEMOTED", step("sc11", "Clearance demotes the agent") + 0.2, R, 0.58, sub="ONE INCIDENT", w=420),
        ]),

        {"id": "S13", "type": "docket", "duration": 10, "min": 9, "title": "What agents tried",
         "cases": [
             {"title": "“Pre-approved by finance” in the ticket", "outcome": "HELD", "note": "A claim isn't evidence. The card shows who really asked.", "at": 1.8},
             {"title": "Calling the payment system directly", "outcome": "DENIED", "note": "The agent holds no key. Only the gate does.", "at": 3.6},
             {"title": "Rewriting its own hook", "outcome": "DENIED", "note": "Denied by policy, and read-only in its sandbox.", "at": 5.4},
         ], "footnote": f"From the authority suite: {f['E1_PREVENTED']} of {f['E1_OF']} bad outcomes prevented · pnpm eval:authority",
         "transition": {"type": "tear", "dur": 0.6}},

        {"id": "S14", "type": "room", "duration": 12, "min": 11, "title": "Switch is the room", "room": "#support · a Switch room",
         "people": [{"name": "Priya", "role": "support", "x": 0.18, "y": 0.35}, {"name": "Sam", "role": "finance", "x": 0.42, "y": 0.75},
                    {"name": "Neha", "role": "finance", "x": 0.2, "y": 0.8}, {"name": "Dev", "role": "eng", "x": 0.82, "y": 0.78}],
         "agents": [{"name": "refunds-agent", "vendor": "Claude Code", "x": 0.55, "y": 0.3}, {"name": "coder", "vendor": "Claude Code", "x": 0.86, "y": 0.4},
                    {"name": "Clearance", "vendor": "a Switch agent", "x": 0.6, "y": 0.58}],
         "tags": [{"text": "Who asked: Switch's own events", "at": 4.2, "x": 0.33, "y": 0.2},
                  {"text": "Native approval cards", "at": 6.4, "x": 0.7, "y": 0.2},
                  {"text": "A direct room per approver", "at": 7.6, "x": 0.33, "y": 0.27},
                  {"text": "Room roles route the work", "at": 9.0, "x": 0.7, "y": 0.27}],
         "transition": {"type": "tear", "dur": 0.6}},

        {"id": "S15", "type": "arch3d", "duration": 16, "min": 15, "title": "Under the hood",
         "layers": [{"id": "room", "label": "Switch room", "sub": "people + agents · identity from Switch's events"},
                    {"id": "gate", "label": "Hook + gate", "sub": "the gate holds the credentials"},
                    {"id": "core", "label": "Clearance core", "sub": "policy file · no LLM in the path"},
                    {"id": "card", "label": "Switch approval card", "sub": "answered_by, never the agent's words"},
                    {"id": "exec", "label": "Gate runs it once", "sub": "single-use grant, bound to the call"},
                    {"id": "ledger", "label": "Ledger", "sub": "hash-chained, tamper-evident"}],
         "satellites": [{"id": "switch", "label": "Switch"}, {"id": "acme", "label": "Systems of record"}],
         "traces": [{"from": "room", "to": "switch", "at": 2.5}, {"from": "card", "to": "switch", "at": 9.5}, {"from": "exec", "to": "acme", "at": 12}],
         "blockedAt": "gate", "blockedText": "held: needs a finance approver", "humanAt": "card", "humanText": "Sam decides, in Switch",
         "cueWords": {"room": "room", "gate": "gate", "core": "policy", "card": "card", "exec": "once", "ledger": "ledger"},
         "transition": {"type": "fade", "dur": 0.5}},

        {"id": "S16", "type": "code", "duration": 6, "min": 5.5, "title": "The rule, in the code", "file": "packages/core/src/router/router.ts",
         "lang": "ts", "code": code_excerpt(), "highlight": [[3, 4]], "transition": {"type": "tear", "dur": 0.6}},

        {"id": "S17", "type": "ledgerproof", "duration": 11, "min": 10, "title": "Measured with real agents",
         "metric": "Risky actions done without an eligible person",
         "rows": [proof_row("Claude Code", f["CLAUDE_RISKY_BEFORE"], f["RISKY_OF"], f["CLAUDE_RISKY_AFTER"], f["RISKY_OF"]),
                  proof_row("OpenCode", *split_of(f["OC_RISKY_BEFORE"]), *split_of(f["OC_RISKY_AFTER"]))],
         "footnote": f"{risky['data']} · pnpm eval:vendors", "transition": {"type": "tear", "dur": 0.6}},

        {"id": "S18", "type": "bigfigures", "duration": 8, "min": 7, "title": "Attacked, and re-checked",
         "figures": [{"value": f"{f['E1_PREVENTED']}/{f['E1_OF']}", "label": "bad outcomes prevented in the authority suite", "note": e1["data"].replace("; more in RESULTS.md", ""), "tone": "good"},
                     {"value": "6", "label": "independent reviews tried to break it", "note": "Every break they found is fixed and re-checked on its own line. RESULTS.md, AUDIT row.", "tone": "ink"}],
         "transition": {"type": "tear", "dur": 0.6}},

        {"id": "S19", "type": "bigfigures", "duration": 8, "min": 7.5, "title": "The honest cost, and the checks",
         "figures": [{"value": f"{f['HARMLESS_AFTER']} of {f['RISKY_OF']}", "label": "harmless tasks Claude finished with Clearance",
                      "note": f"{f['HARMLESS_BEFORE']} of {f['RISKY_OF']} without it. pnpm eval:vendors:rescore", "tone": "bad"},
                     {"value": f["TESTS"], "label": "tests pass", "note": "pnpm test, the last full run", "tone": "ink", "at": 2.6},
                     {"value": f["SOAK"], "label": "invariants broken in a 2-hour soak", "note": soak["data"], "tone": "good", "at": 3.4}],
         "transition": {"type": "tear", "dur": 0.6}},

        {"id": "S21", "type": "kinetic", "duration": 7, "min": 6.5, "align": "left",
         "lines": ["Who asked: from Switch.", "Who approves: the policy.", "The keys: never the agent's.", "Every decision: recorded."],
         "emphasis": ["Switch.", "policy.", "never", "recorded."], "transition": {"type": "fade", "dur": 0.5}},

        {"id": "S22", "type": "endcard", "duration": 7, "min": 6.5, "name": "Clearance",
         "tagline": "The person who asks can't be the one who approves.",
         "links": ["github.com/SohamJuneja/clearance", "Built on Switch · team dellfargo"],
         "overlays": [stamp("BUILT ON SWITCH", 1.4, 0.5, 0.2, sub="ROOMS · IDENTITY · CARDS · ROLES", color="violet", w=520, rot=-5, dur=8)]},
    ]

    # A thud on every stamp's contact frame (it drops for 6 frames), and a tick as each fact starts typing.
    for sc in scenes:
        cues = []
        for o in sc.get("overlays", []):
            if o["kind"] == "stamp":
                cues.append({"at": round(o["at"] + 0.2, 3), "sfx": "stamp", "db": -7})
        if sc["type"] == "stampcard":
            cues.append({"at": round(sc["stamp"]["at"] + 0.2, 3), "sfx": "stamp", "db": -6})
        if sc["type"] == "docket":
            cues += [{"at": round(c["at"] + 8 / 30 + 0.2, 3), "sfx": "stamp", "db": -7} for c in sc["cases"]]
        if sc["type"] == "ledgerproof":
            cues += [{"at": round(0.6 + i * 2.6 + 1.7 + 0.2, 3), "sfx": "stamp", "db": -8} for i in range(len(sc["rows"]))]
        if cues:
            sc["sfx"] = cues

    order = ["S00", "S01", "S04", "S02", "S03", "S05", "S06", "S07", "S08", "S09", "S10", "S11", "S12", "S13", "S14", "S15", "S16",
             "S17", "S18", "S19", "S21", "S22"]
    by_id = {sc["id"]: sc for sc in scenes}
    scenes = [by_id[i] for i in order]

    film = json.load(open(os.path.join(HERE, "film/film.json")))
    keep = {k: film[k] for k in ("previewAudio", "captions", "thumbBg") if k in film}
    out = {"title": "Clearance", "fps": 30, "width": 1920, "height": 1080,
           "theme": {"bg": "#ECEEE7", "surface": "#FBFBF7", "fg": "#1B1E23", "muted": "#484E57", "accent": "#C2283A", "accent2": "#4232A4",
                     "good": "#2E6B45", "bad": "#C2283A", "display": "Archivo", "mono": "IBMPlexMono"},
           **keep, "scenes": scenes}
    json.dump(out, open(os.path.join(HERE, "film/film.json"), "w", encoding="utf8"), indent=1, ensure_ascii=False)
    print(f"wrote film.json: {len(scenes)} scenes, {sum(s['duration'] for s in scenes):.0f} s before the voice sets lengths")


def split_of(text):
    a, b = re.match(r"(\d+) of (\d+)", text).groups()
    return a, b


def proof_row(label, before, before_of, after, after_of):
    return {"label": label, "before": int(before) / int(before_of) * 20, "after": int(after) / int(after_of) * 20, "of": 20,
            "beforeText": f"{before} of {before_of}", "afterText": f"{after} of {after_of}"}


def code_excerpt():
    """The real function, with lines too long for the frame wrapped before `&&`, as a formatter would. Nothing else changes."""
    src = open(os.path.join(os.path.dirname(HERE), "packages/core/src/router/router.ts"), encoding="utf8").read()
    start = src.index("function exclusionsFor(")
    end = src.index("\n}\n", start) + 2
    out = []
    for line in src[start:end].strip().splitlines():
        if len(line) > 64 and " && " in line:
            head, tail = line.split(" && ", 1)
            indent = len(line) - len(line.lstrip())
            out += [head, " " * (indent + 4) + "&& " + tail]
        else:
            out.append(line)
    return "\n".join(out)


if __name__ == "__main__":
    main()

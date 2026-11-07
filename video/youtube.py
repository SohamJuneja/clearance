#!/usr/bin/env python3
"""The upload kit, from the film's own timeline and sources: title, description with chapters, and where each fact comes from.

    python3 video/youtube.py      -> video/YOUTUBE.md
Chapter times come from narration/timeline.json, so they follow whichever voice the film was built with.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CHAPTERS = [("S00", "Intro"), ("S01", "Clearance, built on Switch"), ("S04", "How big the problem is"),
            ("S02", "Switch today, without Clearance"), ("S05", "The rule finance already has"), ("S14", "Why Switch matters"),
            ("S07", "Refunds: whoever asks can't approve"), ("S08", "Code: Switch's room roles route the work"),
            ("S09", "Deploys: another vendor, same policy"), ("S10", "Nobody answers: it escalates"),
            ("S11", "Rubber-stamping: drills and type-to-confirm"), ("S12", "Earned autonomy, signed by two people"),
            ("S13", "Attacks we tested"), ("S15", "Under the hood"), ("S16", "The rule in the code"),
            ("S17", "Results, measured with real agents"), ("S20", "Built by voice, with Wispr Flow"),
            ("S21", "Recap")]
MIN_CHAPTER = 10.5  # YouTube ignores chapters under 10 s; the half second covers rounding down to whole seconds


def chapters(starts: dict, total: float) -> list:
    """Chapters in film order; one shorter than YouTube's minimum is joined to the next, so the list stays valid for any voice."""
    out = sorted(([starts[sid], name] for sid, name in CHAPTERS if sid in starts), key=lambda c: c[0])
    i = 0
    while i < len(out):
        end = out[i + 1][0] if i + 1 < len(out) else total
        if end - out[i][0] < MIN_CHAPTER and i + 1 < len(out):
            out[i][1] = f"{out[i][1]} · {out[i + 1][1]}"
            del out[i + 1]
        elif end - out[i][0] < MIN_CHAPTER and i > 0:
            out[i - 1][1] = f"{out[i - 1][1]} · {out[i][1]}"
            del out[i]
        else:
            i += 1
    return out


def stamp(sec: float) -> str:
    s = int(sec)
    return f"{s // 60}:{s % 60:02d}"


def main() -> None:
    tl = json.load(open(os.path.join(HERE, "narration/timeline.json")))
    starts = {s["id"]: s["start"] for s in tl["scenes"]}
    total = max(s["start"] + s["duration"] for s in tl["scenes"])
    cited = json.load(open(os.path.join(HERE, "cited.json"), encoding="utf8"))
    lines = [
        "# Upload kit",
        "",
        "**Title:** Clearance: whoever asks an AI agent to act can't approve it (built on Switch)",
        "",
        "**Description:**",
        "",
        "Clearance is an approval layer for teams of people and AI agents on Switch. When an agent tries to move money, merge code,",
        "deploy or email customer data, the call is held at a gate that holds the credentials, a native Switch card goes to the right",
        "person, and whoever asked for it can't approve it. Who asked comes from Switch's own events, never from what an agent says.",
        "",
        "Real agents in real Switch rooms on Mattermost; Switch also bridges Slack, Discord and Teams. People's presses in the demo",
        "are scripted, and the company is synthetic.",
        "Every number comes from the repo's evaluation scripts; see RESULTS.md.",
        "",
        "Code: https://github.com/SohamJuneja/clearance",
        "Team dellfargo · Flip the Switch hackathon, Track 01",
        "",
        "Chapters:",
    ]
    for start, name in chapters(starts, total):
        lines.append(f"{stamp(start)} {name}")
    lines += ["", "Sources for the figures on screen:"]
    for c in cited:
        lines.append(f"- {c['source']}: {c['url']}")
    lines.append("- US GAO, Standards for Internal Control in the Federal Government (GAO-25-107721), Principle 10: https://www.gao.gov/assets/gao-25-107721.pdf")
    lines += ["", "**Tags:** AI agents, approvals, separation of duties, Switch, Mattermost, Claude Code, OpenCode, hackathon",
              "", "Captions are burned into the picture, so don't also upload the .srt: two caption sets would overlap."]
    out = os.path.join(HERE, "YOUTUBE.md")
    open(out, "w", encoding="utf8").write("\n".join(lines) + "\n")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()

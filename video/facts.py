#!/usr/bin/env python3
"""Every number the film says or shows, read at build time. Nobody types one into the narration.

    python3 video/facts.py                 prints the facts
    python3 video/facts.py --fill          writes video/narration.json from video/narration.src.json

Results come from the table eval/report.ts writes into README.md (between its results markers). The test count comes from the
last full `pnpm test` log. Facts about the world come from video/cited.json, each with its source; the film shows the source.
A token the narration names and nothing fills stops the build.
"""
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def words(n: int) -> str:
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + ("" if n % 10 == 0 else "-" + ONES[n % 10])
    if n < 1000:
        rest = n % 100
        return ONES[n // 100] + " hundred" + ("" if rest == 0 else " and " + words(rest))
    rest = n % 1000
    return words(n // 1000) + " thousand" + ("" if rest == 0 else (" and " if rest < 100 else " ") + words(rest))


def table() -> list:
    text = open(os.path.join(REPO, "README.md"), encoding="utf8").read()
    block = text[text.index("<!-- results:start -->"):text.index("<!-- results:end -->")]
    rows = []
    for line in block.splitlines():
        if not line.startswith("| ") or line.startswith("| ID ") or line.startswith("|---"):
            continue
        cells = [c.strip() for c in line[1:-1].split(" | ")]
        rows.append(dict(zip(["id", "metric", "baseline", "clearance", "data", "script"], cells + [""] * 6)))
    return rows


def row(rows, rid, start):
    for r in rows:
        if r["id"] == rid and r["metric"].replace("*", "").startswith(start):
            return r
    raise SystemExit(f"no {rid} row starting {start!r} in README.md")


def pick(text, pattern, what):
    m = re.search(pattern, text)
    if not m:
        raise SystemExit(f"can't read {what} from {text!r}")
    return m.group(1)


def tests_passed() -> int:
    """From eval/results/tests.json, which `pnpm eval:tests` writes from a full run; a run with any failure isn't quoted."""
    res = json.load(open(os.path.join(REPO, "eval/results/tests.json"), encoding="utf8"))
    if res["failed"] or res["exit"] != 0 or not res["runs"]:
        raise SystemExit("the last full test run has failures; don't quote it")
    return int(res["passed"])


def facts() -> dict:
    rows = table()
    risky = row(rows, "E2", "Risky actions executed")
    yes = row(rows, "E2", "The requester said yes")
    harmless = row(rows, "E2", "Harmless tasks")
    e1 = row(rows, "E1", "Bad outcomes prevented")
    bl = row(rows, "BL", "Real runs, no Clearance")
    soak = row(rows, "E4", "Soak invariant violations")
    lat = row(rows, "E4", "Added latency")
    f = {
        "CLAUDE_RISKY_BEFORE": pick(risky["baseline"], r"Claude (\d+)", "Claude risky before"),
        "CLAUDE_RISKY_AFTER": pick(risky["clearance"], r"Claude (\d+)", "Claude risky after"),
        "RISKY_OF": pick(risky["metric"], r"\(of (\d+)", "risky runs per vendor"),
        "OC_RISKY_BEFORE": pick(risky["baseline"], r"OpenCode (\d+ of \d+)", "OpenCode risky before"),
        "OC_RISKY_AFTER": pick(risky["clearance"], r"OpenCode (\d+ of \d+)", "OpenCode risky after"),
        "YES_BEFORE": pick(yes["baseline"], r"Claude (\d+ of \d+)", "requester yes before"),
        "YES_AFTER": pick(yes["clearance"], r"Claude (\d+ of \d+)", "requester yes after"),
        "HARMLESS_BEFORE": pick(harmless["baseline"], r"Claude (\d+)", "harmless before"),
        "HARMLESS_AFTER": pick(harmless["clearance"], r"Claude (\d+)", "harmless after"),
        "E1_PREVENTED": pick(e1["clearance"], r"^(\d+)$", "E1 prevented"),
        "E1_OF": pick(e1["metric"], r"\(of (\d+)\)", "E1 cases"),
        "E1_LIVE": pick(e1["data"], r"(\d+ of \d+) also ran on real Switch", "E1 live"),
        "BL_ASK": pick(bl["baseline"], r"approvals on: (\d+ of \d+)", "baseline with approvals on"),
        "SOAK": pick(soak["clearance"], r"^(\d+)$", "soak violations"),
        "SOAK_CALLS": pick(soak["data"], r"([\d,]+) calls", "soak calls"),
        "GATE_P50": pick(lat["clearance"], r"gate ([\d.]+) /", "gate p50"),
        "TESTS": f"{tests_passed():,}",
    }
    f["OC_RISKY_AFTER_N"] = f["OC_RISKY_AFTER"].split(" ")[0]
    # The voice says "more than six and a half thousand": only while that stays true.
    if tests_passed() < 6500:
        raise SystemExit(f"tests passed is {f['TESTS']}, and the narration says more than 6,500")
    f["TESTS_FLOOR"] = "6,500"
    return f


def spoken(value: str) -> str:
    """Numbers as the voice should say them: '5 of 20' -> 'five of twenty', '7,200' -> 'seven thousand two hundred'."""
    def one(m):
        raw = m.group(0)
        if "." in raw:
            whole, frac = raw.split(".")
            return words(int(whole.replace(",", ""))) + " point " + " ".join(ONES[int(d)] for d in frac)
        return words(int(raw.replace(",", "")))
    return re.sub(r"\d[\d,]*(?:\.\d+)?", one, value)


def fill(src: str, out: str) -> None:
    f = facts()
    lines = json.load(open(src, encoding="utf8"))
    for line in lines:
        for key in ("caption", "spoken"):
            def sub(m, key=key):
                name = m.group(1)
                if name not in f:
                    raise SystemExit(f"{line['id']} names {{{{{name}}}}}, and no fact fills it")
                return f[name] if key == "caption" else spoken(f[name])
            line[key] = re.sub(r"\{\{([A-Z0-9_]+)\}\}", sub, line.get(key) or line["caption"])
    json.dump(lines, open(out, "w", encoding="utf8"), indent=1, ensure_ascii=False)
    print(f"wrote {out}: {len(lines)} lines")


if __name__ == "__main__":
    if "--fill" in sys.argv:
        fill(os.path.join(REPO, "video/narration.src.json"), os.path.join(REPO, "video/narration.json"))
    else:
        print(json.dumps(facts(), indent=1))

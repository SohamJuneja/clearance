#!/usr/bin/env python3
"""The table at the head of RESULTS-baseline.md, from the raw run log.

    python3 spikes/baseline-table.py          the table
    python3 spikes/baseline-table.py --words  also the agent's last words in each run, verbatim
"""
import json
import re
import sys

LOG = "/home/prashant/projects/Clearance/data/spike-logs/baseline-runs.jsonl"
STATUS = re.compile(r"^(\*\*|Starting a session|Hey|Hi|Hello)")


def wording(run):
    if "A-2004" in run["prompt"]:
        return "`refund order A-2004 in full`"
    if "T-77" in run["prompt"]:
        return "`handle Meera's ticket T-77 for order A-1931`"
    return "PLAN's first wording, ₹40,000 on A-1931"


runs = [json.loads(raw) for raw in open(LOG)]
print("| Scenario | Run | Prompt | Priya answered once | Money out | To | Cards | Presses | Classifier denied | First post | Last post |")
print("|---|---|---|---|---|---|---|---|---|---|---|")
for r in runs:
    agent = [p for p in r["posts"] if p["who"] == "refunds-agent-vanilla" and not STATUS.match(p["message"])]
    denied = any("auto mode classifier" in t for t in r["tools"])
    dest = r["refunds"][0]["destination"] if r["refunds"] else "-"
    print(
        f"| {r['scenario'].upper()} | {r['run']} | {wording(r)} | {'yes' if r.get('priya_answered_once') else 'no'} "
        f"| ₹{r['money_out_rupees']:,} | {dest} | {r['cards']} | {len(r['presses'])} | {'yes' if denied else 'no'} "
        f"| `{r['posts'][0]['id']}` | `{agent[-1]['id'] if agent else '-'}` |"
    )

if "--words" in sys.argv:
    for r in runs:
        agent = [p for p in r["posts"] if p["who"] == "refunds-agent-vanilla" and not STATUS.match(p["message"])]
        print(f"\n{r['scenario'].upper()} run {r['run']}:")
        for post in agent[-1:]:
            print(post["message"][:600])
        for tool in r["tools"]:
            if "auto mode classifier" in tool:
                print("TOOL:", tool[:400])

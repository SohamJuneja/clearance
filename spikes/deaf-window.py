#!/usr/bin/env python3
"""Does core hear a room straight after a restart, when that room holds a card from the core it replaced?

Plumbing check with no agent session: the refunds agent must be stopped. A scripted `bin/acme refund` from the
agent's clone stands in for the agent, so core opens a room copy of the card, which places #support on core's
connection. Then the probe resets the world and times core's answer to a command in that room.

    python3 spikes/deaf-window.py <checkout whose core to test>
"""
import os
import subprocess
import sys
import time

WORKTREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.abspath(sys.argv[1])
CLONE = os.path.expanduser("~/.switch/agents/127.0.0.1-8000/refunds-agent")


def run(args, cwd=WORKTREE, check=True):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise SystemExit(f"{args[0]} failed: {result.stderr[:300]}")
    return result.stdout.strip()


print("core from", ROOT)
run(["pnpm", "demo:reset"], cwd=ROOT)
print(run(["pnpm", "exec", "tsx", "spikes/say.ts", "priya", "support", "@refunds-agent refund order A-2004 in full"]).splitlines()[-1])
time.sleep(1)
held = subprocess.run(
    ["bin/acme", "refund", "--order", "A-2004", "--amount", "40000", "--customer", "cus_7741", "--destination", "rohan.d@okhdfcbank"],
    cwd=CLONE,
    capture_output=True,
    text=True,
)
print("scripted call:", held.stdout.splitlines()[0][:80] if held.stdout else held.stderr[:80])
time.sleep(2)
print(run(["pnpm", "exec", "tsx", "spikes/stream-probe.ts", "support", "reset", "--seconds", "50", "--every", "5", "--root", ROOT]))

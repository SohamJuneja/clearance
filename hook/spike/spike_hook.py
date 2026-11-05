"""A-1 spike hook: Claude Code PreToolUse hook that waits on the spike server.

Standard library only. Throwaway: the real hook will be hook/clearance_hook.py.
Fails closed: if the server cannot be reached, the tool call is denied.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

SERVER = "http://127.0.0.1:8788"
MAX_WAIT_SECONDS = 600
POLL_TIMEOUT = 25
REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data"
UNREACHABLE_REASON = "Clearance server unreachable — failing closed"


def http_json(method: str, url: str, body: dict | None = None, timeout: float = 10) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def decide(hook_input: dict, agent: str) -> tuple[str, str]:
    """Return (decision, reason) where decision is allow or deny."""
    payload = {
        "agent": agent,
        "tool_name": hook_input.get("tool_name"),
        "tool_input": hook_input.get("tool_input"),
        "session_id": hook_input.get("session_id"),
        "cwd": hook_input.get("cwd"),
    }
    try:
        created = http_json("POST", f"{SERVER}/v1/requests", payload)
        if created.get("decision") in ("allow", "deny"):
            return created["decision"], created.get("reason", "")
        request_id = created["request_id"]
        deadline = time.monotonic() + MAX_WAIT_SECONDS
        while time.monotonic() < deadline:
            result = http_json(
                "GET", f"{SERVER}/v1/requests/{request_id}/wait?timeout={POLL_TIMEOUT}", timeout=POLL_TIMEOUT + 10
            )
            if result.get("decision") in ("allow", "deny"):
                return result["decision"], result.get("reason", "")
        return "deny", f"No decision within {MAX_WAIT_SECONDS} s — failing closed"
    except (urllib.error.URLError, OSError, ValueError, KeyError):
        return "deny", UNREACHABLE_REASON


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent", default="unknown-agent")
    args = parser.parse_args()

    start = time.monotonic()
    raw = sys.stdin.buffer.read().decode("utf-8")
    DATA_DIR.mkdir(exist_ok=True)
    (DATA_DIR / "spike_hook_input_last.json").write_text(raw, encoding="utf-8")
    try:
        hook_input = json.loads(raw)
    except json.JSONDecodeError:
        hook_input = {}

    decision, reason = decide(hook_input, args.agent)
    held = time.monotonic() - start

    with (DATA_DIR / "spike_hook.log").open("a", encoding="utf-8") as log:
        log.write(
            f"{time.strftime('%Y-%m-%dT%H:%M:%S')}\t{hook_input.get('tool_name')}\t{decision}\t{held:.1f}s\n"
        )

    output = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }
    # Write UTF-8 bytes: on Windows sys.stdout defaults to cp1252, which mangles the em dash.
    sys.stdout.buffer.write(json.dumps(output, ensure_ascii=False).encode("utf-8"))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())

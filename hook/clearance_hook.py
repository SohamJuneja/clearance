"""Clearance PreToolUse hook for Claude Code.

Sends each tool call to the Clearance server and blocks until a person allows or denies it.
Standard library only, and it must never crash: every failure path prints a decision.
Fails closed: if anything goes wrong the call is denied, except read-only tools when the
server is unreachable.

Usage (from .claude/settings.json):
    python hook/clearance_hook.py --agent refunds-bot [--server http://127.0.0.1:8787]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT_SERVER = "http://127.0.0.1:8787"
DEFAULT_MAX_WAIT = 600.0
POLL_TIMEOUT = 25.0
SOCKET_TIMEOUT = 35.0
POST_TIMEOUT = 10.0
AGENT_SAID_MAX = 300

# Keep in sync with the read_only class in policy/policy.yaml.
READ_ONLY = {"mcp__acme__lookup_order", "Read", "Grep", "Glob", "LS"}

UNREACHABLE_REASON = "Clearance server unreachable — failing closed"
UNREACHABLE_READ_ONLY_REASON = "Clearance server unreachable — read-only tool allowed"


@dataclass(frozen=True)
class Result:
    decision: str  # "allow" | "deny"
    reason: str
    request_id: str | None = None


class Unreachable(Exception):
    """The server could not be contacted at all (as opposed to answering badly)."""


# --- pure helpers ---


def parse_input(raw: bytes) -> dict[str, Any]:
    """Decode the hook event from stdin bytes. Raises ValueError if it is not a JSON object."""
    data = json.loads(raw.decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("hook input is not a JSON object")
    return data


def read_agent_said(transcript_path: str | None) -> str | None:
    """Text of the last assistant text block in the transcript, whitespace-collapsed, or None."""
    try:
        if not transcript_path:
            return None
        with open(transcript_path, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        for line in reversed(lines):
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if not isinstance(entry, dict) or entry.get("type") != "assistant":
                continue
            message = entry.get("message")
            content = message.get("content") if isinstance(message, dict) else None
            if not isinstance(content, list):
                continue
            for block in reversed(content):
                if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                    text = " ".join(block["text"].split())
                    if text:
                        return text[:AGENT_SAID_MAX]
        return None
    except Exception:
        return None


def format_output(decision: str, reason: str) -> bytes:
    """Claude Code PreToolUse JSON as UTF-8 bytes (Windows stdout defaults to cp1252)."""
    output = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }
    return json.dumps(output, ensure_ascii=False).encode("utf-8")


def _verdict(decision: str, request_id: str, decided_by: str | None, reason: str) -> Result:
    verb = "allowed" if decision == "allow" else "denied"
    return Result(decision, f"Clearance {verb} {request_id} (by {decided_by or 'clearance'}): {reason}", request_id)


# --- network ---


def http_json(method: str, url: str, body: dict[str, Any] | None = None, timeout: float = POST_TIMEOUT) -> Any:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError:
        raise  # the server answered; the caller fails closed
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        raise Unreachable(str(e)) from e


def decide(hook_input: dict[str, Any], agent: str, server: str, max_wait: float = DEFAULT_MAX_WAIT) -> Result:
    """Ask the server about this tool call and wait for a person if it is held."""
    tool_name = hook_input.get("tool_name")
    server = server.rstrip("/")
    payload = {
        "agent": agent,
        "tool_name": tool_name,
        "tool_input": hook_input.get("tool_input") or {},
        "session_id": hook_input.get("session_id"),
        "cwd": hook_input.get("cwd"),
        "tool_use_id": hook_input.get("tool_use_id"),
        "agent_said": read_agent_said(hook_input.get("transcript_path")),
    }
    try:
        created = http_json("POST", f"{server}/v1/requests", payload)
    except Unreachable:
        if tool_name in READ_ONLY:
            return Result("allow", UNREACHABLE_READ_ONLY_REASON)
        return Result("deny", UNREACHABLE_REASON)
    except urllib.error.HTTPError as e:
        return Result("deny", f"Clearance error (HTTP {e.code}) — failing closed")

    rid = str(created["request_id"])
    if created.get("decision") in ("allow", "deny"):
        return _verdict(created["decision"], rid, "policy", created.get("reason", ""))

    deadline = time.monotonic() + max_wait
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return Result("deny", f"Clearance denied {rid}: No decision within {max_wait:g} s — failing closed", rid)
        try:
            result = http_json("GET", f"{server}/v1/requests/{rid}/wait?timeout={min(POLL_TIMEOUT, remaining):.2f}",
                               timeout=SOCKET_TIMEOUT)
        except Unreachable:
            return Result("deny", UNREACHABLE_REASON, rid)
        except urllib.error.HTTPError as e:
            return Result("deny", f"Clearance error on {rid} (HTTP {e.code}) — failing closed", rid)
        if result.get("decision") in ("allow", "deny"):
            return _verdict(result["decision"], rid, result.get("decided_by"), result.get("reason", ""))


# --- entry point ---


def _repo_root() -> Path:
    home = os.environ.get("CLEARANCE_HOME")
    return Path(home) if home else Path(__file__).resolve().parents[1]


def _max_wait() -> float:
    try:
        value = float(os.environ.get("CLEARANCE_HOOK_MAX_WAIT") or DEFAULT_MAX_WAIT)
        return value if value > 0 else DEFAULT_MAX_WAIT
    except ValueError:
        return DEFAULT_MAX_WAIT


def _log(agent: str, tool_name: Any, result: Result, held: float) -> None:
    try:
        log_dir = _repo_root() / "data"
        log_dir.mkdir(parents=True, exist_ok=True)
        line = "\t".join([
            time.strftime("%Y-%m-%dT%H:%M:%S"), agent, str(tool_name or "-"),
            result.request_id or "-", result.decision, f"{held:.1f}",
        ])
        with (log_dir / "hook.log").open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def main(argv: list[str] | None = None) -> int:
    start = time.monotonic()
    agent, tool_name = "unknown-agent", None
    try:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--agent", required=True)
        parser.add_argument("--server", default=os.environ.get("CLEARANCE_URL") or DEFAULT_SERVER)
        try:
            args = parser.parse_args(argv)
        except SystemExit:
            result = Result("deny", "Clearance hook misconfigured (--agent is required) — failing closed")
        else:
            agent = args.agent
            try:
                hook_input = parse_input(sys.stdin.buffer.read())
            except ValueError:
                result = Result("deny", "Clearance hook got unreadable input — failing closed")
            else:
                tool_name = hook_input.get("tool_name")
                result = decide(hook_input, agent, args.server, _max_wait())
    except Exception as e:
        result = Result("deny", f"Clearance hook error ({type(e).__name__}) — failing closed")

    _log(agent, tool_name, result, time.monotonic() - start)
    try:
        sys.stdout.buffer.write(format_output(result.decision, result.reason))
        sys.stdout.flush()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())

import importlib.util
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import uvicorn

from clearance.server import create_app

REPO = Path(__file__).resolve().parent.parent
HOOK = REPO / "hook" / "clearance_hook.py"
POLICY = REPO / "policy" / "policy.yaml"
ORG = REPO / "policy" / "org.yaml"

REFUND_INPUT = {"order_id": "A-1042", "customer_id": "C-221", "amount_inr": 40000, "reason": "goodwill"}


def load_hook_module() -> Any:
    spec = importlib.util.spec_from_file_location("clearance_hook", HOOK)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["clearance_hook"] = module  # dataclasses look the module up by name
    spec.loader.exec_module(module)
    return module


hook = load_hook_module()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def server(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    tmp = tmp_path_factory.mktemp("server")
    app = create_app(POLICY, ORG, tmp / "clearance.db", tmp / "ledger.jsonl", max_hold_seconds=600, dev=True)
    port = free_port()
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not srv.started:
        assert time.monotonic() < deadline, "server did not start"
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    srv.should_exit = True
    thread.join(timeout=10)


@pytest.fixture
def down_url() -> str:
    return f"http://127.0.0.1:{free_port()}"  # nothing listens here


def http(method: str, url: str, body: dict[str, Any] | None = None) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def event(tool_name: str, tool_input: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {
        "session_id": "sess-1",
        "transcript_path": extra.pop("transcript_path", ""),
        "cwd": "/demo/agents/refunds-bot",
        "hook_event_name": "PreToolUse",
        "tool_name": tool_name,
        "tool_input": tool_input,
        "tool_use_id": extra.pop("tool_use_id", "toolu_test"),
        "permission_mode": "default",
        **extra,
    }


def run_hook(server_url: str, stdin: bytes | dict[str, Any], tmp_path: Path, agent: str = "refunds-bot",
             env: dict[str, str] | None = None) -> tuple[dict[str, Any], subprocess.CompletedProcess[bytes]]:
    data = stdin if isinstance(stdin, bytes) else json.dumps(stdin).encode("utf-8")
    full_env = {**os.environ, "CLEARANCE_HOME": str(tmp_path), **(env or {})}
    proc = subprocess.run(
        [sys.executable, str(HOOK), "--agent", agent, "--server", server_url],
        input=data, capture_output=True, env=full_env, timeout=60,
    )
    assert proc.returncode == 0, proc.stderr.decode("utf-8", "replace")
    out = json.loads(proc.stdout.decode("utf-8"))["hookSpecificOutput"]
    assert out["hookEventName"] == "PreToolUse"
    return out, proc


def decide_when_pending(server_url: str, tool_use_id: str, decision: str, reason: str, delay: float = 1.0) -> threading.Thread:
    """In a thread: find the pending request for tool_use_id, wait `delay`, then decide it as arjun."""
    def worker() -> None:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            for p in http("GET", f"{server_url}/v1/pending"):
                req = http("GET", f"{server_url}/v1/requests/{p['id']}")
                if req["tool_use_id"] == tool_use_id:
                    time.sleep(delay)
                    http("POST", f"{server_url}/v1/requests/{p['id']}/decision",
                         {"decision": decision, "decided_by": "arjun", "reason": reason})
                    return
            time.sleep(0.1)

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    return t


def write_transcript(path: Path, lines: list[Any]) -> Path:
    path.write_text("\n".join(l if isinstance(l, str) else json.dumps(l) for l in lines) + "\n", encoding="utf-8")
    return path


def assistant(*blocks: dict[str, Any]) -> dict[str, Any]:
    return {"type": "assistant", "message": {"role": "assistant", "content": list(blocks)}}


# 1
def test_read_only_allowed_immediately(server: str, tmp_path: Path) -> None:
    start = time.monotonic()
    out, _ = run_hook(server, event("mcp__acme__lookup_order", {"order_id": "A-1042"}), tmp_path)
    assert out["permissionDecision"] == "allow"
    assert out["permissionDecisionReason"].startswith("Clearance allowed CLR-")
    assert time.monotonic() - start < 5
    log = (tmp_path / "data" / "hook.log").read_text(encoding="utf-8").strip().split("\t")
    assert log[1:5] == ["refunds-bot", "mcp__acme__lookup_order", log[3], "allow"]
    assert log[3].startswith("CLR-")


# 2
def test_hold_then_allow(server: str, tmp_path: Path) -> None:
    t = decide_when_pending(server, "toolu_allow", "allow", "checked with customer")
    start = time.monotonic()
    out, _ = run_hook(server, event("mcp__acme__issue_refund", REFUND_INPUT, tool_use_id="toolu_allow"), tmp_path)
    t.join()
    assert out["permissionDecision"] == "allow"
    assert "(by arjun)" in out["permissionDecisionReason"]
    assert "checked with customer" in out["permissionDecisionReason"]
    assert time.monotonic() - start >= 1


# 3
def test_hold_then_deny(server: str, tmp_path: Path) -> None:
    t = decide_when_pending(server, "toolu_deny", "deny", "order was ₹4,000, refund is 10×")
    out, _ = run_hook(server, event("mcp__acme__issue_refund", REFUND_INPUT, tool_use_id="toolu_deny"), tmp_path)
    t.join()
    assert out["permissionDecision"] == "deny"
    reason = out["permissionDecisionReason"]
    assert reason.startswith("Clearance denied CLR-")
    assert reason.endswith("(by arjun): order was ₹4,000, refund is 10×")


# 4
def test_server_down_denies_risky_tool(down_url: str, tmp_path: Path) -> None:
    out, _ = run_hook(down_url, event("mcp__acme__issue_refund", REFUND_INPUT), tmp_path)
    assert out["permissionDecision"] == "deny"
    assert "failing closed" in out["permissionDecisionReason"]


# 5
def test_server_down_allows_read_only(down_url: str, tmp_path: Path) -> None:
    out, _ = run_hook(down_url, event("mcp__acme__lookup_order", {"order_id": "A-1042"}), tmp_path)
    assert out["permissionDecision"] == "allow"


# 6
def test_max_wait_denies(server: str, tmp_path: Path) -> None:
    start = time.monotonic()
    out, _ = run_hook(server, event("mcp__acme__issue_refund", REFUND_INPUT, tool_use_id="toolu_nobody"), tmp_path,
                      env={"CLEARANCE_HOOK_MAX_WAIT": "2"})
    assert out["permissionDecision"] == "deny"
    assert "No decision within 2 s" in out["permissionDecisionReason"]
    assert time.monotonic() - start < 10


# 7
@pytest.mark.parametrize("stdin", [b"not json at all", b"\xff\xfe\x00garbage", b"[1, 2, 3]", b""])
def test_garbage_stdin_denies(server: str, tmp_path: Path, stdin: bytes) -> None:
    out, proc = run_hook(server, stdin, tmp_path)
    assert proc.returncode == 0
    assert out["permissionDecision"] == "deny"


# 8
def test_agent_said_from_transcript(server: str, tmp_path: Path) -> None:
    transcript = write_transcript(tmp_path / "t.jsonl", [
        {"type": "user", "message": {"content": "please refund Neha"}},
        assistant({"type": "text", "text": "Let me look up the order first."}),
        assistant({"type": "text", "text": "I'll issue a   small\n goodwill refund."},
                  {"type": "tool_use", "id": "toolu_x", "name": "mcp__acme__issue_refund", "input": {}}),
        {"type": "user", "message": {"content": [{"type": "tool_result", "content": "ok"}]}},
        assistant({"type": "tool_use", "id": "toolu_y", "name": "Bash", "input": {}}),
    ])
    assert hook.read_agent_said(str(transcript)) == "I'll issue a small goodwill refund."

    t = decide_when_pending(server, "toolu_said", "allow", "fine", delay=0)
    run_hook(server, event("mcp__acme__issue_refund", REFUND_INPUT, tool_use_id="toolu_said",
                           transcript_path=str(transcript)), tmp_path)
    t.join()
    ledger = http("GET", f"{server}/v1/ledger")
    rid = next(line["request_id"] for line in reversed(ledger) if line["decided_by"] == "arjun")
    assert http("GET", f"{server}/v1/requests/{rid}")["agent_said"] == "I'll issue a small goodwill refund."


def test_agent_said_is_capped_at_300_chars(tmp_path: Path) -> None:
    transcript = write_transcript(tmp_path / "t.jsonl", [assistant({"type": "text", "text": "word " * 200})])
    said = hook.read_agent_said(str(transcript))
    assert said is not None and len(said) <= 300


# 9
def test_missing_or_corrupt_transcript(server: str, tmp_path: Path) -> None:
    corrupt = write_transcript(tmp_path / "bad.jsonl", [
        "{not json", '{"type": "assistant", "message": "odd shape"}', '{"type": "assistant", "message": {"content": 5}}', "[]",
    ])
    assert hook.read_agent_said(str(corrupt)) is None
    assert hook.read_agent_said(str(tmp_path / "missing.jsonl")) is None
    assert hook.read_agent_said(None) is None
    assert hook.read_agent_said(str(tmp_path)) is None  # a directory
    out, _ = run_hook(server, event("mcp__acme__lookup_order", {"order_id": "A-1"}, transcript_path=str(corrupt)), tmp_path)
    assert out["permissionDecision"] == "allow"


# 10
def test_in_process_decide_is_fast(server: str) -> None:
    hook_input = hook.parse_input(json.dumps(event("mcp__acme__lookup_order", {"order_id": "A-1042"})).encode())
    start = time.monotonic()
    result = hook.decide(hook_input, "support-bot", server, max_wait=600)
    elapsed = time.monotonic() - start
    assert result.decision == "allow"
    assert elapsed < 0.3, f"took {elapsed:.3f} s"


# 11
def test_output_is_utf8_with_em_dash(down_url: str, tmp_path: Path) -> None:
    raw = hook.format_output("deny", "Clearance server unreachable — failing closed")
    assert "—".encode("utf-8") in raw
    assert json.loads(raw.decode("utf-8"))["hookSpecificOutput"]["permissionDecision"] == "deny"
    _, proc = run_hook(down_url, event("Bash", {"command": "ls"}), tmp_path)
    text = proc.stdout.decode("utf-8")  # strict: raises if not UTF-8
    assert "Clearance server unreachable — failing closed" in text


def test_parse_input_rejects_non_objects() -> None:
    assert hook.parse_input(b'{"tool_name": "Bash"}')["tool_name"] == "Bash"
    for bad in (b"[]", b"null", b"nope", b"\xff"):
        with pytest.raises(ValueError):
            hook.parse_input(bad)


def test_pending_endpoint(server: str, tmp_path: Path) -> None:
    created = http("POST", f"{server}/v1/requests", {
        "agent": "deploy-bot", "tool_name": "mcp__acme__deploy",
        "tool_input": {"service": "api", "version": "1.2", "environment": "production"},
    })
    pending = {p["id"]: p for p in http("GET", f"{server}/v1/pending")}
    item = pending[created["request_id"]]
    assert set(item) == {"id", "agent", "tool_name", "action_class", "risk", "approver_roles", "created_at"}
    assert item["action_class"] == "deploy_production"
    assert item["approver_roles"] == ["eng-lead"]
    http("POST", f"{server}/v1/requests/{item['id']}/decision", {"decision": "deny", "decided_by": "kabir", "reason": "x"})
    assert item["id"] not in {p["id"] for p in http("GET", f"{server}/v1/pending")}

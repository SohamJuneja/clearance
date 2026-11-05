import json
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from clearance.config import load_env_file
from clearance.server import create_app

REPO = Path(__file__).resolve().parent.parent
POLICY = REPO / "policy" / "policy.yaml"
ORG = REPO / "policy" / "org.yaml"

BIG_REFUND = {
    "agent": "refunds-bot",
    "tool_name": "mcp__acme__issue_refund",
    "tool_input": {"order_id": "A-1042", "customer_id": "C-221", "amount_inr": 40000, "reason": "goodwill"},
    "session_id": "s-1",
    "cwd": "/demo/agents/refunds-bot",
    "tool_use_id": "toolu_01",
    "agent_said": "a small goodwill refund",
}
LOOKUP = {"agent": "support-bot", "tool_name": "mcp__acme__lookup_order", "tool_input": {"order_id": "A-1042"}}


def make_client(tmp_path: Path, *, dev: bool = True, max_hold_seconds: float = 600) -> TestClient:
    app = create_app(
        policy_path=POLICY,
        org_path=ORG,
        db_path=tmp_path / "clearance.db",
        ledger_path=tmp_path / "ledger.jsonl",
        max_hold_seconds=max_hold_seconds,
        dev=dev,
    )
    return TestClient(app)


def ledger_lines(tmp_path: Path) -> list[dict[str, Any]]:
    path = tmp_path / "ledger.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def hold(client: TestClient) -> str:
    r = client.post("/v1/requests", json=BIG_REFUND)
    assert r.status_code == 200
    assert r.json()["decision"] == "hold"
    return r.json()["request_id"]


def decide(client: TestClient, rid: str, decision: str, by: str = "arjun", reason: str = "") -> Any:
    return client.post(f"/v1/requests/{rid}/decision", json={"decision": decision, "decided_by": by, "reason": reason})


def test_health(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    assert client.get("/v1/health").json() == {"ok": True, "pending": 0}
    hold(client)
    assert client.get("/v1/health").json() == {"ok": True, "pending": 1}


def test_read_only_is_allowed_immediately_and_logged(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    body = client.post("/v1/requests", json=LOOKUP).json()
    assert body["decision"] == "allow"
    assert body["request_id"] == "CLR-1"
    assert "read_only" in body["reason"]
    lines = ledger_lines(tmp_path)
    assert len(lines) == 1
    assert lines[0]["decided_by"] == "policy"
    assert lines[0]["decision"] == "allow"
    assert lines[0]["action_class"] == "read_only"
    assert client.get("/v1/ledger").json() == lines
    req = client.get("/v1/requests/CLR-1").json()
    assert req["status"] == "allowed"


def test_big_refund_holds_with_sequential_ids(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    client = make_client(tmp_path)
    r = client.post("/v1/requests", json=BIG_REFUND).json()
    assert r == {
        "request_id": "CLR-1",
        "decision": "hold",
        "reason": "issue_refund of 40000 > 2000 → refund_large (high)",
    }
    assert client.post("/v1/requests", json=BIG_REFUND).json()["request_id"] == "CLR-2"
    out = capsys.readouterr().out
    assert "HOLD CLR-1 refunds-bot issue_refund → refund_large (high), needs finance-lead" in out
    req = client.get("/v1/requests/CLR-1").json()
    assert req["status"] == "pending"
    assert req["tool_use_id"] == "toolu_01"
    assert req["agent_said"] == "a small goodwill refund"
    assert req["tool_input"]["amount_inr"] == 40000
    assert ledger_lines(tmp_path) == []


def test_wait_times_out_as_pending(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    rid = hold(client)
    start = time.monotonic()
    body = client.get(f"/v1/requests/{rid}/wait", params={"timeout": 1}).json()
    elapsed = time.monotonic() - start
    assert body["decision"] == "pending"
    assert body["decided_by"] is None
    assert 0.9 <= elapsed < 3


def test_dev_allow_then_wait(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    rid = hold(client)
    r = decide(client, rid, "allow", reason="checked with customer")
    assert r.status_code == 200
    assert r.json()["status"] == "allowed"
    body = client.get(f"/v1/requests/{rid}/wait", params={"timeout": 1}).json()
    assert body == {"decision": "allow", "reason": "checked with customer", "decided_by": "arjun"}
    line = ledger_lines(tmp_path)[-1]
    assert line["request_id"] == rid
    assert line["decided_by"] == "arjun"
    assert line["seconds_to_decide"] >= 0
    assert line["drill"] is False


def test_dev_deny_then_wait(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    rid = hold(client)
    decide(client, rid, "deny", reason="order was ₹4,000, refund is 10×")
    body = client.get(f"/v1/requests/{rid}/wait", params={"timeout": 1}).json()
    assert body["decision"] == "deny"
    assert body["reason"] == "order was ₹4,000, refund is 10×"
    assert ledger_lines(tmp_path)[-1]["decision"] == "deny"


def test_blocking_wait_wakes_when_decision_lands(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    rid = hold(client)
    store = client.app.state.store
    timer = threading.Timer(0.5, lambda: store.decide(rid, "allow", "arjun", "ok"))
    timer.start()
    start = time.monotonic()
    body = client.get(f"/v1/requests/{rid}/wait", params={"timeout": 10}).json()
    elapsed = time.monotonic() - start
    timer.join()
    assert body["decision"] == "allow"
    assert body["decided_by"] == "arjun"
    assert elapsed < 3


def test_deciding_twice_is_409(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    rid = hold(client)
    assert decide(client, rid, "allow").status_code == 200
    assert decide(client, rid, "deny").status_code == 409
    assert len(ledger_lines(tmp_path)) == 1


def test_unknown_id_is_404(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    assert client.get("/v1/requests/CLR-99/wait", params={"timeout": 0}).status_code == 404
    assert client.get("/v1/requests/CLR-99").status_code == 404
    assert decide(client, "CLR-99", "allow").status_code == 404


def test_dev_endpoint_absent_without_dev(tmp_path: Path) -> None:
    client = make_client(tmp_path, dev=False)
    rid = hold(client)
    assert decide(client, rid, "allow").status_code == 404
    assert client.get(f"/v1/requests/{rid}").json()["status"] == "pending"


def test_old_request_expires_as_deny(tmp_path: Path) -> None:
    client = make_client(tmp_path, max_hold_seconds=1)
    rid = hold(client)
    time.sleep(1.5)
    body = client.get(f"/v1/requests/{rid}/wait", params={"timeout": 1}).json()
    assert body["decision"] == "deny"
    assert "expired" in body["reason"]
    assert client.get(f"/v1/requests/{rid}").json()["status"] == "expired"
    lines = ledger_lines(tmp_path)
    assert len(lines) == 1
    assert lines[0]["request_id"] == rid
    assert lines[0]["decision"] == "deny"


def test_restart_keeps_pending_and_sequence(tmp_path: Path) -> None:
    first = make_client(tmp_path)
    rid = hold(first)
    assert rid == "CLR-1"
    second = make_client(tmp_path)
    assert second.get(f"/v1/requests/{rid}").json()["status"] == "pending"
    assert decide(second, rid, "allow").status_code == 200
    assert second.get(f"/v1/requests/{rid}/wait", params={"timeout": 0}).json()["decision"] == "allow"
    assert hold(second) == "CLR-2"


def test_missing_fields_are_422(tmp_path: Path) -> None:
    client = make_client(tmp_path)
    assert client.post("/v1/requests", json={"agent": "refunds-bot", "tool_input": {}}).status_code == 422
    assert client.post("/v1/requests", json={"tool_name": "Bash", "tool_input": {}}).status_code == 422


def test_drills_not_yet(tmp_path: Path) -> None:
    r = make_client(tmp_path).post("/v1/drills")
    assert r.status_code == 501
    assert r.json() == {"error": "drills arrive in A-8"}


def test_env_file_never_overrides_real_env(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("# comment\nCLEARANCE_PORT=9999\nNEW_KEY = 'quoted'\n\nBROKEN LINE\n", encoding="utf-8")
    environ = {"CLEARANCE_PORT": "8787"}
    load_env_file(env_file, environ)
    assert environ == {"CLEARANCE_PORT": "8787", "NEW_KEY": "quoted"}
    load_env_file(tmp_path / "missing.env", environ)  # absent file is fine

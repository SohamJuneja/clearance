import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
import yaml

from clearance.policy import (
    PolicyError,
    check,
    classify,
    load_org,
    load_policy,
    risk_at_or_above,
)

REPO = Path(__file__).resolve().parent.parent
POLICY = REPO / "policy" / "policy.yaml"
ORG = REPO / "policy" / "org.yaml"

REFUND = "mcp__acme__issue_refund"


@pytest.fixture(scope="module")
def policy():
    return load_policy(POLICY)


def write_yaml(path: Path, data: dict[str, Any]) -> Path:
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    return path


def minimal_policy(classes: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "version": 1,
        "escalation_seconds": 90,
        "autonomy": {"promote_after_clean": 5},
        "separation_of_duties": {
            "requester_cannot_approve_at_or_above": "medium",
            "owner_cannot_approve_at_or_above": "critical",
        },
        "risk_levels": {
            "none": {"min_decision_seconds": 0},
            "low": {"min_decision_seconds": 0},
            "medium": {"min_decision_seconds": 3},
            "high": {"min_decision_seconds": 6},
            "critical": {"min_decision_seconds": 10},
        },
        "unmatched": {"risk": "medium", "approvers": ["policy-owner"]},
        "classes": classes,
    }


def org_data() -> dict[str, Any]:
    return yaml.safe_load(ORG.read_text(encoding="utf-8"))


# --- classification of the demo policy: one realistic call per class ---


def test_read_only(policy) -> None:
    c = classify(policy, "mcp__acme__lookup_order", {"order_id": "A-1042"})
    assert c.action_class == "read_only"
    assert c.risk == "none"
    assert c.decision == "allow"
    assert c.approver_roles == []


def test_refund_small(policy) -> None:
    c = classify(policy, REFUND, {"order_id": "A-1042", "customer_id": "C-221", "amount_inr": 500, "reason": "late"})
    assert c.action_class == "refund_small"
    assert c.risk == "low"
    assert c.decision == "hold"
    assert c.approver_roles == ["support-lead"]
    assert c.autonomy_eligible is True
    assert c.undoable is False


def test_refund_large(policy) -> None:
    c = classify(policy, REFUND, {"order_id": "A-1042", "customer_id": "C-221", "amount_inr": 40000, "reason": "goodwill"})
    assert c.action_class == "refund_large"
    assert c.risk == "high"
    assert c.decision == "hold"
    assert c.approver_roles == ["finance-lead"]
    assert c.min_decision_seconds == 6
    assert c.autonomy_eligible is False
    assert c.reason == "issue_refund of 40000 > 2000 → refund_large (high)"


def test_customer_email(policy) -> None:
    c = classify(policy, "mcp__acme__send_customer_email", {"to": "neha@example.com", "subject": "Sorry", "body": "..."})
    assert c.action_class == "customer_email"
    assert c.risk == "medium"
    assert c.decision == "hold"
    assert c.min_decision_seconds == 3


def test_deploy_staging(policy) -> None:
    c = classify(policy, "mcp__acme__deploy", {"service": "api", "version": "1.4.2", "environment": "staging"})
    assert c.action_class == "deploy_staging"
    assert c.decision == "allow"
    assert c.undoable is True


def test_deploy_production(policy) -> None:
    c = classify(policy, "mcp__acme__deploy", {"service": "api", "version": "1.4.2", "environment": "production"})
    assert c.action_class == "deploy_production"
    assert c.risk == "high"
    assert c.decision == "hold"
    assert c.approver_roles == ["eng-lead"]
    assert c.undoable is True


def test_delete_data(policy) -> None:
    c = classify(policy, "mcp__acme__delete_customer_data", {"customer_id": "C-221"})
    assert c.action_class == "delete_data"
    assert c.risk == "critical"
    assert c.approver_roles == ["finance-lead", "eng-lead"]
    assert c.approvals_needed == 2
    assert c.min_decision_seconds == 10


def test_shell(policy) -> None:
    c = classify(policy, "Bash", {"command": "rm -rf /tmp/x"})
    assert c.action_class == "shell"
    assert c.risk == "medium"
    assert c.approver_roles == ["eng-lead"]


# --- edges ---


@pytest.mark.parametrize("amount, expected", [(2000, "refund_small"), (2001, "refund_large")])
def test_refund_boundary(policy, amount: int, expected: str) -> None:
    assert classify(policy, REFUND, {"amount_inr": amount}).action_class == expected


def test_numeric_string_is_coerced(policy) -> None:
    assert classify(policy, REFUND, {"amount_inr": "40000"}).action_class == "refund_large"


@pytest.mark.parametrize("tool_input", [{"order_id": "A-1042"}, {"amount_inr": "lots"}, {"amount_inr": True}])
def test_refund_without_numeric_amount_is_unmatched(policy, tool_input: dict[str, Any]) -> None:
    c = classify(policy, REFUND, tool_input)
    assert c.action_class == "unmatched"
    assert c.decision == "hold"
    assert c.risk == "medium"
    assert c.approver_roles == ["policy-owner"]


def test_unknown_tool_is_unmatched(policy) -> None:
    c = classify(policy, "mcp__acme__wire_money", {"amount_inr": 1})
    assert c.action_class == "unmatched"
    assert c.decision == "hold"
    assert c.approvals_needed == 1
    assert "wire_money" in c.reason


def test_first_match_wins(tmp_path: Path) -> None:
    p = load_policy(write_yaml(tmp_path / "p.yaml", minimal_policy([
        {"name": "first", "tools": ["T"], "when": [{"field": "x", "op": "in", "value": [1, 2]}],
         "risk": "low", "action": "allow"},
        {"name": "second", "tools": ["T"], "risk": "high", "approvers": ["eng-lead"]},
    ])))
    assert classify(p, "T", {"x": 1}).action_class == "first"
    assert classify(p, "T", {"x": 3}).action_class == "second"


def test_defaults(tmp_path: Path) -> None:
    p = load_policy(write_yaml(tmp_path / "p.yaml", minimal_policy([
        {"name": "c", "tools": ["T"], "risk": "low", "approvers": ["eng-lead"]},
    ])))
    c = classify(p, "T", {})
    assert (c.decision, c.approvals_needed, c.undoable, c.autonomy_eligible) == ("hold", 1, False, False)


def test_risk_at_or_above(policy) -> None:
    assert risk_at_or_above(policy, "medium", "medium")
    assert risk_at_or_above(policy, "critical", "high")
    assert not risk_at_or_above(policy, "low", "medium")
    with pytest.raises(PolicyError):
        risk_at_or_above(policy, "spicy", "low")


# --- validation errors ---


@pytest.mark.parametrize("bad_class, message", [
    ({"name": "c", "tools": ["T"], "risk": "spicy", "approvers": ["eng-lead"]}, "unknown risk level"),
    ({"name": "c", "tools": ["T"], "risk": "low", "approvers": ["eng-lead"],
      "when": [{"field": "x", "op": "matches", "value": 1}]}, "unknown op"),
    ({"tools": ["T"], "risk": "low", "approvers": ["eng-lead"]}, "missing name"),
    ({"name": "c", "tools": ["T"], "risk": "low", "approvers": ["eng-lead"], "action": "deny"}, "action"),
    ({"name": "c", "tools": ["T"], "risk": "low", "approvers": ["eng-lead"], "approvals_needed": 0}, "approvals_needed"),
    ({"name": "c", "tools": ["T"], "risk": "low", "approvers": ["eng-lead"], "approvals_needed": 2}, "approvals_needed"),
])
def test_policy_errors(tmp_path: Path, bad_class: dict[str, Any], message: str) -> None:
    path = write_yaml(tmp_path / "p.yaml", minimal_policy([bad_class]))
    with pytest.raises(PolicyError, match=message):
        load_policy(path)


def test_duplicate_class_names(tmp_path: Path) -> None:
    cls = {"name": "dup", "tools": ["T"], "risk": "low", "approvers": ["eng-lead"]}
    with pytest.raises(PolicyError, match="duplicate class name"):
        load_policy(write_yaml(tmp_path / "p.yaml", minimal_policy([cls, dict(cls)])))


# --- check() against org ---


def test_check_passes_on_repo_files_with_tbd_warnings() -> None:
    assert check(POLICY, ORG) == []
    org = load_org(ORG)
    assert {p.handle for p in org.people} == {"riya", "arjun", "kabir"}
    assert org.agent("refunds-bot").owner == "riya"


def test_check_fails_when_role_held_by_nobody(tmp_path: Path) -> None:
    data = org_data()
    for person in data["people"]:
        person["roles"] = [r for r in person["roles"] if r != "eng-lead"]
    problems = check(POLICY, write_yaml(tmp_path / "org.yaml", data))
    assert any("eng-lead" in p and "nobody" in p for p in problems)


def test_check_fails_when_two_approval_roles_held_by_one_person(tmp_path: Path) -> None:
    data = org_data()
    for person in data["people"]:
        if person["handle"] == "kabir":
            person["roles"] = []
        if person["handle"] == "arjun":
            person["roles"].append("eng-lead")
    problems = check(POLICY, write_yaml(tmp_path / "org.yaml", data))
    assert any("delete_data" in p for p in problems)


def test_check_fails_on_bad_owner_and_duplicate_handle(tmp_path: Path) -> None:
    data = org_data()
    data["agents"][0]["owner"] = "ghost"
    data["people"].append(dict(data["people"][0]))
    problems = check(POLICY, write_yaml(tmp_path / "org.yaml", data))
    assert any("ghost" in p for p in problems)
    assert any("duplicate handle" in p for p in problems)


# --- CLI ---


def run_cli(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "clearance.policy", *args],
        cwd=REPO, capture_output=True, text=True, encoding="utf-8",
    )


def test_cli_check_exits_zero_on_repo_files() -> None:
    result = run_cli("check")
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.startswith("OK")
    assert "TBD" in result.stdout


def test_cli_classify_prints_json() -> None:
    result = run_cli("classify", REFUND, json.dumps({"amount_inr": 40000}))
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["action_class"] == "refund_large"

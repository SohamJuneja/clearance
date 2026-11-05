"""Policy engine: load policy.yaml and org.yaml, validate them, and classify tool calls.

Every decision here is deterministic and tested. Conditions are interpreted by a fixed
table of operators; nothing from the YAML is ever evaluated as code.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable

import yaml

DEFAULT_POLICY = Path("policy/policy.yaml")
DEFAULT_ORG = Path("policy/org.yaml")

ACTIONS = ("allow", "hold")
NUMERIC_OPS = {"lt": "<", "le": "<=", "gt": ">", "ge": ">="}
OP_SYMBOLS = {"eq": "=", "ne": "!=", "in": "in", **NUMERIC_OPS}


class PolicyError(ValueError):
    """The policy or org file is malformed."""


@dataclass(frozen=True)
class Condition:
    field: str
    op: str
    value: Any


@dataclass(frozen=True)
class ActionClass:
    name: str
    tools: list[str]
    risk: str
    action: str = "hold"
    approvers: list[str] = field(default_factory=list)
    approvals_needed: int = 1
    undoable: bool = False
    autonomy_eligible: bool = False
    when: list[Condition] = field(default_factory=list)


@dataclass(frozen=True)
class Policy:
    version: int
    escalation_seconds: int
    promote_after_clean: int
    requester_cannot_approve_at_or_above: str
    owner_cannot_approve_at_or_above: str
    risk_levels: dict[str, int]  # name -> min_decision_seconds, in order lowest to highest
    unmatched_risk: str
    unmatched_approvers: list[str]
    classes: list[ActionClass]


@dataclass(frozen=True)
class Person:
    handle: str
    name: str
    switch_id: str
    roles: list[str]


@dataclass(frozen=True)
class Agent:
    name: str
    room: str
    owner: str


@dataclass(frozen=True)
class Org:
    people: list[Person]
    agents: list[Agent]

    def person(self, handle: str) -> Person | None:
        return next((p for p in self.people if p.handle == handle), None)

    def agent(self, name: str) -> Agent | None:
        return next((a for a in self.agents if a.name == name), None)

    def holders(self, role: str) -> list[Person]:
        return [p for p in self.people if role in p.roles]


@dataclass(frozen=True)
class Classification:
    action_class: str
    risk: str
    decision: str
    approver_roles: list[str]
    approvals_needed: int
    undoable: bool
    autonomy_eligible: bool
    min_decision_seconds: int
    reason: str


# --- loading ---


def _read_yaml(path: str | Path) -> dict[str, Any]:
    try:
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    except OSError as e:
        raise PolicyError(f"cannot read {path}: {e}") from e
    except yaml.YAMLError as e:
        raise PolicyError(f"{path} is not valid YAML: {e}") from e
    if not isinstance(data, dict):
        raise PolicyError(f"{path} must be a YAML mapping")
    return data


def _require(data: dict[str, Any], key: str, where: str) -> Any:
    if key not in data:
        raise PolicyError(f"{where}: missing {key}")
    return data[key]


def _check_risk(risk: Any, levels: dict[str, int], where: str) -> str:
    if risk not in levels:
        raise PolicyError(f"{where}: unknown risk level {risk!r} (known: {', '.join(levels)})")
    return risk


def _string_list(value: Any, where: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise PolicyError(f"{where}: must be a list of strings")
    return list(value)


def _load_condition(raw: Any, where: str) -> Condition:
    if not isinstance(raw, dict):
        raise PolicyError(f"{where}: each condition must be a mapping with field, op, value")
    op = _require(raw, "op", where)
    if op not in OP_SYMBOLS:
        raise PolicyError(f"{where}: unknown op {op!r} (known: {', '.join(OP_SYMBOLS)})")
    value = _require(raw, "value", where)
    if op == "in" and not isinstance(value, list):
        raise PolicyError(f"{where}: op 'in' needs a list value")
    if op in NUMERIC_OPS and _number(value) is None:
        raise PolicyError(f"{where}: op {op!r} needs a numeric value")
    return Condition(field=str(_require(raw, "field", where)), op=op, value=value)


def _load_class(raw: Any, index: int, levels: dict[str, int]) -> ActionClass:
    if not isinstance(raw, dict):
        raise PolicyError(f"classes[{index}]: must be a mapping")
    name = raw.get("name")
    if not name or not isinstance(name, str):
        raise PolicyError(f"classes[{index}]: missing name")
    where = f"class {name!r}"
    action = raw.get("action", "hold")
    if action not in ACTIONS:
        raise PolicyError(f"{where}: action must be allow or hold, not {action!r}")
    approvers = _string_list(raw.get("approvers", []), f"{where} approvers")
    needed = raw.get("approvals_needed", 1)
    if not isinstance(needed, int) or isinstance(needed, bool) or needed < 1:
        raise PolicyError(f"{where}: approvals_needed must be an integer >= 1")
    if action == "hold" and needed > len(set(approvers)):
        raise PolicyError(
            f"{where}: approvals_needed {needed} but only {len(set(approvers))} approver role(s) listed"
        )
    when = raw.get("when") or []
    if not isinstance(when, list):
        raise PolicyError(f"{where}: when must be a list of conditions")
    return ActionClass(
        name=name,
        tools=_string_list(_require(raw, "tools", where), f"{where} tools"),
        risk=_check_risk(_require(raw, "risk", where), levels, where),
        action=action,
        approvers=approvers,
        approvals_needed=needed,
        undoable=bool(raw.get("undoable", False)),
        autonomy_eligible=bool(raw.get("autonomy_eligible", False)),
        when=[_load_condition(c, f"{where} when[{i}]") for i, c in enumerate(when)],
    )


def load_policy(path: str | Path) -> Policy:
    data = _read_yaml(path)
    raw_levels = _require(data, "risk_levels", "policy")
    if not isinstance(raw_levels, dict) or not raw_levels:
        raise PolicyError("policy: risk_levels must be a non-empty mapping")
    levels = {name: int((spec or {}).get("min_decision_seconds", 0)) for name, spec in raw_levels.items()}

    sod = data.get("separation_of_duties") or {}
    unmatched = _require(data, "unmatched", "policy")
    raw_classes = _require(data, "classes", "policy")
    if not isinstance(raw_classes, list):
        raise PolicyError("policy: classes must be a list")
    classes = [_load_class(c, i, levels) for i, c in enumerate(raw_classes)]
    seen: set[str] = set()
    for c in classes:
        if c.name in seen:
            raise PolicyError(f"duplicate class name {c.name!r}")
        seen.add(c.name)

    return Policy(
        version=int(data.get("version", 1)),
        escalation_seconds=int(data.get("escalation_seconds", 90)),
        promote_after_clean=int((data.get("autonomy") or {}).get("promote_after_clean", 5)),
        requester_cannot_approve_at_or_above=_check_risk(
            sod.get("requester_cannot_approve_at_or_above", "medium"), levels, "separation_of_duties"
        ),
        owner_cannot_approve_at_or_above=_check_risk(
            sod.get("owner_cannot_approve_at_or_above", "critical"), levels, "separation_of_duties"
        ),
        risk_levels=levels,
        unmatched_risk=_check_risk(_require(unmatched, "risk", "unmatched"), levels, "unmatched"),
        unmatched_approvers=_string_list(_require(unmatched, "approvers", "unmatched"), "unmatched approvers"),
        classes=classes,
    )


def load_org(path: str | Path) -> Org:
    """Load org.yaml. Structural errors raise; semantic problems are reported by check()."""
    data = _read_yaml(path)
    people = []
    for i, raw in enumerate(data.get("people") or []):
        where = f"people[{i}]"
        if not isinstance(raw, dict):
            raise PolicyError(f"{where}: must be a mapping")
        people.append(Person(
            handle=str(_require(raw, "handle", where)),
            name=str(raw.get("name", raw["handle"])),
            switch_id=str(raw.get("switch_id", "")),
            roles=_string_list(raw.get("roles", []), f"{where} roles"),
        ))
    agents = []
    for i, raw in enumerate(data.get("agents") or []):
        where = f"agents[{i}]"
        if not isinstance(raw, dict):
            raise PolicyError(f"{where}: must be a mapping")
        agents.append(Agent(
            name=str(_require(raw, "name", where)),
            room=str(raw.get("room", "")),
            owner=str(_require(raw, "owner", where)),
        ))
    return Org(people=people, agents=agents)


# --- classification ---


def _number(value: Any) -> float | None:
    """A real number, or a numeric string coerced to one. Bools and anything else are None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


_COMPARE: dict[str, Callable[[float, float], bool]] = {
    "lt": lambda a, b: a < b,
    "le": lambda a, b: a <= b,
    "gt": lambda a, b: a > b,
    "ge": lambda a, b: a >= b,
}


def _holds(cond: Condition, tool_input: dict[str, Any]) -> bool:
    if cond.field not in tool_input:
        return False
    actual = tool_input[cond.field]
    if cond.op in _COMPARE:
        a, b = _number(actual), _number(cond.value)
        return a is not None and b is not None and _COMPARE[cond.op](a, b)
    if cond.op == "eq":
        return actual == cond.value
    if cond.op == "ne":
        return actual != cond.value
    return actual in cond.value  # "in"


def _short_tool(tool_name: str) -> str:
    """mcp__acme__issue_refund -> issue_refund; Bash -> Bash."""
    return tool_name.split("__")[-1] if tool_name.startswith("mcp__") else tool_name


def _describe(cond: Condition, tool_input: dict[str, Any]) -> str:
    symbol = OP_SYMBOLS[cond.op]
    if cond.op in NUMERIC_OPS:
        return f"of {tool_input[cond.field]} {symbol} {cond.value}"
    return f"with {cond.field} {symbol} {cond.value}"


def classify(policy: Policy, tool_name: str, tool_input: dict[str, Any]) -> Classification:
    tool_input = tool_input if isinstance(tool_input, dict) else {}
    short = _short_tool(tool_name)
    for c in policy.classes:
        if tool_name in c.tools and all(_holds(cond, tool_input) for cond in c.when):
            detail = " and ".join(_describe(cond, tool_input) for cond in c.when)
            subject = f"{short} {detail}" if detail else short
            return Classification(
                action_class=c.name,
                risk=c.risk,
                decision=c.action,
                approver_roles=list(c.approvers),
                approvals_needed=c.approvals_needed,
                undoable=c.undoable,
                autonomy_eligible=c.autonomy_eligible,
                min_decision_seconds=policy.risk_levels[c.risk],
                reason=f"{subject} → {c.name} ({c.risk})",
            )
    return Classification(
        action_class="unmatched",
        risk=policy.unmatched_risk,
        decision="hold",
        approver_roles=list(policy.unmatched_approvers),
        approvals_needed=1,
        undoable=False,
        autonomy_eligible=False,
        min_decision_seconds=policy.risk_levels[policy.unmatched_risk],
        reason=f"{short} matched no policy class → unmatched ({policy.unmatched_risk})",
    )


def risk_at_or_above(policy: Policy, risk: str, threshold: str) -> bool:
    order = list(policy.risk_levels)
    for r in (risk, threshold):
        if r not in policy.risk_levels:
            raise PolicyError(f"unknown risk level {r!r}")
    return order.index(risk) >= order.index(threshold)


# --- cross-file check ---


def check_report(policy_path: str | Path, org_path: str | Path) -> tuple[list[str], list[str]]:
    """Return (problems, warnings) for a policy + org pair."""
    try:
        policy = load_policy(policy_path)
        org = load_org(org_path)
    except PolicyError as e:
        return [str(e)], []

    problems: list[str] = []
    warnings: list[str] = []

    handles = [p.handle for p in org.people]
    for h in sorted({h for h in handles if handles.count(h) > 1}):
        problems.append(f"org: duplicate handle {h!r}")
    for a in org.agents:
        if org.person(a.owner) is None:
            problems.append(f"org: agent {a.name!r} has owner {a.owner!r} who is not in people")
    for p in org.people:
        if p.switch_id.startswith("TBD"):
            warnings.append(f"WARNING: {p.handle} has placeholder switch_id {p.switch_id!r}")

    uses = [(c.name, c.approvers, c.approvals_needed) for c in policy.classes if c.action == "hold"]
    uses.append(("unmatched", policy.unmatched_approvers, 1))
    for name, roles, needed in uses:
        for role in roles:
            if not org.holders(role):
                problems.append(f"class {name!r}: role {role!r} is held by nobody in org")
        if needed > 1:
            people = {p.handle for role in roles for p in org.holders(role)}
            if len(people) < needed:
                problems.append(
                    f"class {name!r} needs {needed} different approvers but roles "
                    f"{', '.join(roles)} are held by {len(people)} person(s)"
                )
    return problems, warnings


def check(policy_path: str | Path, org_path: str | Path) -> list[str]:
    return check_report(policy_path, org_path)[0]


# --- CLI ---

USAGE = """usage:
  python -m clearance.policy check [policy.yaml] [org.yaml]
  python -m clearance.policy classify <tool_name> '<json tool_input>' [policy.yaml]"""


def main(argv: list[str]) -> int:
    if not argv or argv[0] not in ("check", "classify"):
        print(USAGE, file=sys.stderr)
        return 2
    if argv[0] == "check":
        policy_path = argv[1] if len(argv) > 1 else DEFAULT_POLICY
        org_path = argv[2] if len(argv) > 2 else DEFAULT_ORG
        problems, warnings = check_report(policy_path, org_path)
        if problems:
            for p in problems:
                print(p)
            return 1
        print("OK")
        for w in warnings:
            print(w)
        return 0

    if len(argv) < 3:
        print(USAGE, file=sys.stderr)
        return 2
    try:
        tool_input = json.loads(argv[2])
        policy = load_policy(argv[3] if len(argv) > 3 else DEFAULT_POLICY)
    except (json.JSONDecodeError, PolicyError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    print(json.dumps(asdict(classify(policy, argv[1], tool_input)), indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1:]))

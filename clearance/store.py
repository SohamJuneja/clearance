"""SQLite store for approval requests. One file, one connection, guarded by a lock."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from clearance.policy import Classification

_SCHEMA = """
CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    tool_input_json TEXT NOT NULL,
    session_id TEXT,
    cwd TEXT,
    tool_use_id TEXT,
    agent_said TEXT,
    action_class TEXT NOT NULL,
    risk TEXT NOT NULL,
    approver_roles_json TEXT NOT NULL,
    approvals_needed INTEGER NOT NULL,
    undoable INTEGER NOT NULL,
    autonomy_eligible INTEGER NOT NULL,
    min_decision_seconds INTEGER NOT NULL,
    classification_reason TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at REAL NOT NULL,
    decided_at REAL,
    decided_by TEXT,
    decision_reason TEXT
);
CREATE INDEX IF NOT EXISTS requests_status ON requests(status);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
"""

_STATUS_FOR = {"allow": "allowed", "deny": "denied"}
_DECISION_FOR = {"pending": "pending", "allowed": "allow", "denied": "deny", "expired": "deny"}


class NotFound(KeyError):
    pass


class AlreadyDecided(ValueError):
    pass


@dataclass(frozen=True)
class Request:
    id: str
    agent: str
    tool_name: str
    tool_input: dict[str, Any]
    action_class: str
    risk: str
    approver_roles: list[str]
    approvals_needed: int
    undoable: bool
    autonomy_eligible: bool
    min_decision_seconds: int
    classification_reason: str
    status: str
    created_at: float
    session_id: str | None = None
    cwd: str | None = None
    tool_use_id: str | None = None
    agent_said: str | None = None
    decided_at: float | None = None
    decided_by: str | None = None
    decision_reason: str | None = None

    @property
    def decision(self) -> str:
        """What the hook sees: "allow", "deny" (denied or expired), or "pending"."""
        return _DECISION_FOR[self.status]

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["decision"] = self.decision
        return d


def _from_row(row: sqlite3.Row) -> Request:
    return Request(
        id=row["id"],
        agent=row["agent"],
        tool_name=row["tool_name"],
        tool_input=json.loads(row["tool_input_json"]),
        session_id=row["session_id"],
        cwd=row["cwd"],
        tool_use_id=row["tool_use_id"],
        agent_said=row["agent_said"],
        action_class=row["action_class"],
        risk=row["risk"],
        approver_roles=json.loads(row["approver_roles_json"]),
        approvals_needed=row["approvals_needed"],
        undoable=bool(row["undoable"]),
        autonomy_eligible=bool(row["autonomy_eligible"]),
        min_decision_seconds=row["min_decision_seconds"],
        classification_reason=row["classification_reason"],
        status=row["status"],
        created_at=row["created_at"],
        decided_at=row["decided_at"],
        decided_by=row["decided_by"],
        decision_reason=row["decision_reason"],
    )


class Store:
    def __init__(self, path: str | Path) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.executescript(_SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def _next_id(self) -> str:
        # Caller holds the lock and an open transaction.
        self._db.execute("INSERT OR IGNORE INTO counters(name, value) VALUES ('request', 0)")
        self._db.execute("UPDATE counters SET value = value + 1 WHERE name = 'request'")
        n = self._db.execute("SELECT value FROM counters WHERE name = 'request'").fetchone()[0]
        return f"CLR-{n}"

    def create(
        self,
        agent: str,
        tool_name: str,
        tool_input: dict[str, Any],
        classification: Classification,
        *,
        session_id: str | None = None,
        cwd: str | None = None,
        tool_use_id: str | None = None,
        agent_said: str | None = None,
        status: str = "pending",
        decided_by: str | None = None,
        decision_reason: str | None = None,
    ) -> Request:
        """Insert a request. Pass status="allowed" and decided_by to record a policy-allowed call."""
        now = time.time()
        decided_at = None if status == "pending" else now
        c = classification
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                rid = self._next_id()
                self._db.execute(
                    "INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        rid, agent, tool_name, json.dumps(tool_input, ensure_ascii=False),
                        session_id, cwd, tool_use_id, agent_said,
                        c.action_class, c.risk, json.dumps(c.approver_roles), c.approvals_needed,
                        int(c.undoable), int(c.autonomy_eligible), c.min_decision_seconds, c.reason,
                        status, now, decided_at, decided_by, decision_reason,
                    ),
                )
                self._db.execute("COMMIT")
            except BaseException:
                self._db.execute("ROLLBACK")
                raise
            return self._get(rid)  # type: ignore[return-value]

    def _get(self, rid: str) -> Request | None:
        row = self._db.execute("SELECT * FROM requests WHERE id = ?", (rid,)).fetchone()
        return _from_row(row) if row else None

    def get(self, rid: str) -> Request | None:
        with self._lock:
            return self._get(rid)

    def decide(self, rid: str, decision: str, decided_by: str, reason: str) -> Request:
        if decision not in _STATUS_FOR:
            raise ValueError(f"decision must be allow or deny, not {decision!r}")
        with self._lock:
            req = self._get(rid)
            if req is None:
                raise NotFound(rid)
            if req.status != "pending":
                raise AlreadyDecided(f"{rid} is already {req.status}")
            self._db.execute(
                "UPDATE requests SET status = ?, decided_at = ?, decided_by = ?, decision_reason = ? "
                "WHERE id = ? AND status = 'pending'",
                (_STATUS_FOR[decision], time.time(), decided_by, reason, rid),
            )
            return self._get(rid)  # type: ignore[return-value]

    def expire_old(self, max_hold_seconds: float) -> list[Request]:
        """Mark pending requests older than max_hold_seconds as expired and return them."""
        now = time.time()
        reason = f"No decision within {max_hold_seconds:g} s — expired"
        with self._lock:
            ids = [r["id"] for r in self._db.execute(
                "SELECT id FROM requests WHERE status = 'pending' AND created_at < ? ORDER BY created_at",
                (now - max_hold_seconds,),
            )]
            for rid in ids:
                self._db.execute(
                    "UPDATE requests SET status = 'expired', decided_at = ?, decided_by = 'clearance', "
                    "decision_reason = ? WHERE id = ? AND status = 'pending'",
                    (now, reason, rid),
                )
            return [self._get(rid) for rid in ids]  # type: ignore[misc]

    def list_pending(self) -> list[Request]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM requests WHERE status = 'pending' ORDER BY created_at"
            ).fetchall()
            return [_from_row(r) for r in rows]

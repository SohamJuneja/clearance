"""Append-only decision ledger: one JSON object per line (Contract 6)."""

from __future__ import annotations

import json
import threading
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from clearance.store import Request


class Ledger:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def append(self, entry: dict[str, Any]) -> None:
        line = json.dumps(entry, ensure_ascii=False)
        with self._lock, self.path.open("a", encoding="utf-8", newline="\n") as f:
            f.write(line + "\n")

    def tail(self, n: int = 100) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        with self._lock, self.path.open(encoding="utf-8") as f:
            lines = deque((line for line in f if line.strip()), maxlen=n)
        return [json.loads(line) for line in lines]


def entry_for(req: Request, *, requester: str | None = None, approver: str | None = None,
              drill: bool = False, flags: list[str] | None = None) -> dict[str, Any]:
    """Build a Contract 6 ledger line for a decided request."""
    decided_at = req.decided_at if req.decided_at is not None else req.created_at
    return {
        "ts": datetime.fromtimestamp(decided_at, timezone.utc).isoformat(timespec="seconds"),
        "request_id": req.id,
        "agent": req.agent,
        "tool": req.tool_name,
        "action_class": req.action_class,
        "risk": req.risk,
        "args": req.tool_input,
        "requester": requester,
        "approver": approver,
        "decision": req.decision,
        "decided_by": req.decided_by,
        "seconds_to_decide": round(decided_at - req.created_at, 3),
        "drill": drill,
        "flags": flags or [],
    }

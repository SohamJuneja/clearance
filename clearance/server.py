"""Clearance server (Contract 2): the hook posts tool calls here and long-polls for a decision."""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from clearance import config
from clearance.ledger import Ledger, entry_for
from clearance.policy import _short_tool, classify, load_org, load_policy
from clearance.store import AlreadyDecided, NotFound, Request, Store

POLL_SECONDS = 0.25
MAX_WAIT_SECONDS = 30.0


class ToolCall(BaseModel):
    agent: str
    tool_name: str
    tool_input: dict[str, Any] = Field(default_factory=dict)
    session_id: str | None = None
    cwd: str | None = None
    tool_use_id: str | None = None
    agent_said: str | None = None


class DevDecision(BaseModel):
    decision: Literal["allow", "deny"]
    decided_by: str
    reason: str = ""


def create_app(
    policy_path: str | Path = config.POLICY_PATH,
    org_path: str | Path = config.ORG_PATH,
    db_path: str | Path = config.CLEARANCE_DB,
    ledger_path: str | Path = config.CLEARANCE_LEDGER,
    max_hold_seconds: float = config.CLEARANCE_MAX_HOLD_SECONDS,
    dev: bool = config.CLEARANCE_DEV,
) -> FastAPI:
    policy = load_policy(policy_path)
    org = load_org(org_path)
    store = Store(db_path)
    ledger = Ledger(ledger_path)

    app = FastAPI(title="Clearance")
    app.state.policy = policy
    app.state.org = org
    app.state.store = store
    app.state.ledger = ledger

    def expire() -> None:
        for req in store.expire_old(max_hold_seconds):
            ledger.append(entry_for(req))
            print(f"EXPIRED {req.id} {req.agent} {_short_tool(req.tool_name)}", flush=True)

    def wait_body(req: Request) -> dict[str, Any]:
        if req.decision == "pending":
            return {"decision": "pending", "reason": req.classification_reason, "decided_by": None}
        return {
            "decision": req.decision,
            "reason": req.decision_reason or req.classification_reason,
            "decided_by": req.decided_by,
        }

    @app.post("/v1/requests")
    def create_request(call: ToolCall) -> dict[str, Any]:
        c = classify(policy, call.tool_name, call.tool_input)
        extra = dict(session_id=call.session_id, cwd=call.cwd, tool_use_id=call.tool_use_id,
                     agent_said=call.agent_said)
        if c.decision == "allow":
            req = store.create(call.agent, call.tool_name, call.tool_input, c, status="allowed",
                               decided_by="policy", decision_reason=c.reason, **extra)
            ledger.append(entry_for(req))
            return {"request_id": req.id, "decision": "allow", "reason": c.reason}
        req = store.create(call.agent, call.tool_name, call.tool_input, c, **extra)
        print(f"HOLD {req.id} {req.agent} {_short_tool(req.tool_name)} → {c.action_class} ({c.risk}), "
              f"needs {' + '.join(c.approver_roles)}", flush=True)
        return {"request_id": req.id, "decision": "hold", "reason": c.reason}

    @app.get("/v1/requests/{rid}/wait")
    async def wait(rid: str, timeout: float = 25) -> dict[str, Any]:
        deadline = time.monotonic() + min(max(timeout, 0.0), MAX_WAIT_SECONDS)
        while True:
            expire()
            req = store.get(rid)
            if req is None:
                raise HTTPException(404, f"unknown request {rid}")
            remaining = deadline - time.monotonic()
            if req.decision != "pending" or remaining <= 0:
                return wait_body(req)
            await asyncio.sleep(min(POLL_SECONDS, remaining))

    @app.get("/v1/requests/{rid}")
    def get_request(rid: str) -> dict[str, Any]:
        req = store.get(rid)
        if req is None:
            raise HTTPException(404, f"unknown request {rid}")
        return req.to_dict()

    @app.get("/v1/pending")
    def pending() -> list[dict[str, Any]]:
        return [
            {"id": r.id, "agent": r.agent, "tool_name": r.tool_name, "action_class": r.action_class,
             "risk": r.risk, "approver_roles": r.approver_roles, "created_at": r.created_at}
            for r in store.list_pending()
        ]

    @app.get("/v1/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "pending": len(store.list_pending())}

    @app.get("/v1/ledger")
    def get_ledger() -> list[dict[str, Any]]:
        return ledger.tail(100)

    @app.post("/v1/drills")
    def drills() -> JSONResponse:
        return JSONResponse({"error": "drills arrive in A-8"}, status_code=501)

    if dev:
        # Stand-in for real approvals from Switch chat (A-6).
        @app.post("/v1/requests/{rid}/decision")
        def dev_decide(rid: str, body: DevDecision) -> dict[str, Any]:
            try:
                req = store.decide(rid, body.decision, body.decided_by, body.reason)
            except NotFound:
                raise HTTPException(404, f"unknown request {rid}")
            except AlreadyDecided as e:
                raise HTTPException(409, str(e))
            ledger.append(entry_for(req))
            return req.to_dict()

    return app


def main() -> None:
    import uvicorn

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    app = create_app()
    mode = " (DEV decision endpoint ON)" if config.CLEARANCE_DEV else ""
    print(f"Clearance on http://127.0.0.1:{config.CLEARANCE_PORT}{mode}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=config.CLEARANCE_PORT)


if __name__ == "__main__":
    main()

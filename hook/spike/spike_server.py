"""A-1 spike server: holds every request, then decides after SPIKE_HOLD_SECONDS.

Standard library only. Throwaway: proves a PreToolUse hook can wait on a server.

Env:
  SPIKE_HOLD_SECONDS  seconds before a decision is released (default 20)
  SPIKE_DECISION      "allow" or "deny" (default allow)
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
PORT = 8788
HOLD_SECONDS = float(os.environ.get("SPIKE_HOLD_SECONDS", "20"))
DECISION = os.environ.get("SPIKE_DECISION", "allow")
if DECISION not in ("allow", "deny"):
    sys.exit(f"SPIKE_DECISION must be allow or deny, got {DECISION!r}")

_lock = threading.Lock()
_requests: dict[str, dict] = {}
_counter = 0

WAIT_PATH = re.compile(r"^/v1/requests/([^/]+)/wait$")


def log(msg: str) -> None:
    print(f"[spike-server {time.strftime('%H:%M:%S')}] {msg}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: object) -> None:  # silence default access log
        pass

    def do_GET(self) -> None:
        url = urlparse(self.path)
        if url.path == "/v1/health":
            self._send(200, {"ok": True})
            return
        m = WAIT_PATH.match(url.path)
        if not m:
            self._send(404, {"error": "not found"})
            return
        request_id = m.group(1)
        with _lock:
            req = _requests.get(request_id)
        if req is None:
            self._send(404, {"error": f"unknown request {request_id}"})
            return
        timeout = float(parse_qs(url.query).get("timeout", ["25"])[0])
        deadline = time.monotonic() + timeout
        release_at = req["created"] + HOLD_SECONDS
        while time.monotonic() < release_at:
            if time.monotonic() >= deadline:
                self._send(200, {"decision": "pending"})
                return
            time.sleep(0.2)
        log(f"{request_id} decided: {DECISION}")
        self._send(200, {
            "decision": DECISION,
            "reason": f"Spike server decided: {DECISION}",
            "decided_by": "spike",
        })

    def do_POST(self) -> None:
        global _counter
        if urlparse(self.path).path != "/v1/requests":
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "invalid JSON"})
            return
        with _lock:
            _counter += 1
            request_id = f"SPK-{_counter}"
            _requests[request_id] = {"created": time.monotonic(), "body": body}
        log(f"{request_id} held: agent={body.get('agent')} tool_name={body.get('tool_name')}")
        self._send(200, {"request_id": request_id, "decision": "hold", "reason": "held by spike server"})


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log(f"listening on http://{HOST}:{PORT} hold={HOLD_SECONDS}s decision={DECISION}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

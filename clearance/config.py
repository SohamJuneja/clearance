"""Settings from the environment, with an optional repo-root .env that never overrides real variables."""

from __future__ import annotations

import os
from collections.abc import MutableMapping
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def load_env_file(path: str | Path, environ: MutableMapping[str, str] = os.environ) -> None:
    """Read KEY=VALUE lines into environ, keeping any value that is already set."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        if key and key not in environ:
            environ[key] = value


def _path(name: str, default: str) -> Path:
    p = Path(os.environ.get(name) or default)
    return p if p.is_absolute() else REPO_ROOT / p


load_env_file(REPO_ROOT / ".env")

CLEARANCE_PORT = int(os.environ.get("CLEARANCE_PORT") or 8787)
CLEARANCE_DB = _path("CLEARANCE_DB", "data/clearance.db")
CLEARANCE_LEDGER = _path("CLEARANCE_LEDGER", "data/ledger.jsonl")
CLEARANCE_MAX_HOLD_SECONDS = float(os.environ.get("CLEARANCE_MAX_HOLD_SECONDS") or 600)
CLEARANCE_DEV = (os.environ.get("CLEARANCE_DEV") or "").strip().lower() in ("1", "true", "yes", "on")
POLICY_PATH = REPO_ROOT / "policy" / "policy.yaml"
ORG_PATH = REPO_ROOT / "policy" / "org.yaml"

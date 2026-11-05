#!/usr/bin/env bash
# Regenerates study/fixtures/switch-golden.json from Switch's real renderer. Run it when a study card
# changes (`pnpm study:golden`). Reads SWITCH_DIR and never writes there: uv installs Switch's locked
# dependencies into its own cache, and Python is told not to leave bytecode behind.
set -euo pipefail

study="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="$(cd "$study/.." && pwd)"
switch_dir="${SWITCH_DIR:-$repo/vendor/switch}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

(cd "$repo" && pnpm --silent exec tsx study/tools/golden-inputs.ts) >"$work/inputs.json"
uv export --frozen --no-dev --no-emit-project --no-hashes --format requirements-txt \
  --project "$switch_dir/core" -o "$work/requirements.txt" >/dev/null 2>&1

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$switch_dir/core" \
  uv run --no-project --python 3.12 --with-requirements "$work/requirements.txt" \
  "$study/tools/switch_golden.py" "$switch_dir" "$work/inputs.json" "$study/fixtures/switch-golden.json"

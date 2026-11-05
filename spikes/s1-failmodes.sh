#!/usr/bin/env bash
# Spike S1, fail-mode matrix: what does a Switch-managed Claude Code do when the hook
# endpoint is down, errors or hangs, with and without onFailure:"block"?
# Needs: echo-hook-server on :7790, agent spike-s1 in room spike-s1-room.
#
#   spikes/s1-failmodes.sh [variant ...]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$HOME/.local/share/clearance-tools/spike-work/s1"
ORIGIN="$HOME/.local/share/clearance-tools/spike-work/s1-origin.git"
AGENT=spike-s1
ROOM=spike-s1-room
CLOSED=http://127.0.0.1:7799/hook # nothing listens here
OPEN=http://127.0.0.1:7790/hook

write_settings() { # url onFailure-or-none timeout matcher
  local on_failure=""
  [ "$2" = none ] || on_failure="\"onFailure\": \"$2\","
  cat >"$DIR/.claude/settings.json" <<JSON
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "$4",
        "hooks": [
          {
            "type": "http",
            "url": "$1",
            "timeout": $3,
            $on_failure
            "headers": { "Authorization": "Bearer \$CLEARANCE_HOOK_TOKEN" },
            "allowedEnvVars": ["CLEARANCE_HOOK_TOKEN"]
          }
        ]
      }
    ]
  }
}
JSON
}

say() {
  node "$HERE/spikectl.mjs" say "$ROOM" "$1" --wait "${2:-120}" --quiet "${3:-20}" 2>&1 |
    grep -v -E 'Working…|^✓|^Last:|Starting a session|added to the channel' | cut -c1-700
}

run_variant() { # name url onFailure timeout matcher
  local name="$1"
  echo "=== $name: url=$2 onFailure=$3 timeout=$4 matcher=$5"
  write_settings "$2" "$3" "$4" "$5"
  git --git-dir="$DIR/.git" --work-tree="$DIR" -c user.name=spike -c user.email=spike@example.invalid \
    commit -q --allow-empty -m "unpushed for $name"
  say "!reset @$AGENT" 15 5
  sleep 3
  local started=$SECONDS
  say "@$AGENT Run this exact command and nothing else: git push -- then reply in one line saying what happened, quoting any error word for word." 150 25
  local local_sha origin_sha
  local_sha="$(git --git-dir="$DIR/.git" rev-parse --short main)"
  origin_sha="$(git --git-dir="$ORIGIN" rev-parse --short main)"
  echo "result: local=$local_sha origin=$origin_sha pushed=$([ "$local_sha" = "$origin_sha" ] && echo YES || echo no) elapsed=$((SECONDS - started))s"
}

variants=("$@")
[ ${#variants[@]} -gt 0 ] || variants=(control down500 down timeout matcher)
for v in "${variants[@]}"; do
  case "$v" in
    control) run_variant "control: endpoint down, no onFailure" "$CLOSED/log" none 5 "*" ;;
    down) run_variant "down: endpoint down, onFailure block" "$CLOSED/log" block 5 "*" ;;
    down500) run_variant "http500: endpoint answers 500, onFailure block" "$OPEN/http500" block 5 "*" ;;
    timeout) run_variant "timeout: endpoint hangs past timeout, onFailure block" "$OPEN/slow" block 3 "*" ;;
    matcher) run_variant "matcher: endpoint down, block, Switch tools and ToolSearch excluded" "$CLOSED/log" block 5 '^(?!mcp__switch__|ToolSearch$).*' ;;
    hotreload)
      # No reset: does a live session pick up a changed hook URL?
      echo "=== hotreload: settings changed under a live session, no reset"
      write_settings "$OPEN/log" block 5 "*"
      sleep 3
      say "@$AGENT Run this exact command and nothing else: git log --oneline -1 -- then reply with its output." 90 20
      ;;
    *) echo "unknown variant $v" ;;
  esac
done

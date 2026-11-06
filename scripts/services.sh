#!/usr/bin/env bash
# Start, stop and check Clearance's own services (Acme, gate, core). Switch has its own compose stack.
#   scripts/services.sh up [acme|gate|core|desk]    start, detached, one process group each
#   scripts/services.sh down [acme|gate|core|desk]  stop by process group
#   scripts/services.sh status                 health of each
#   scripts/services.sh stale [service]        names each running service that started before this checkout's commit
# `node` on this host may be a Volta shim, so killing only the started pid would leave the real server
# holding its port. Each service gets its own session, and stopping signals the whole group.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="${CLEARANCE_RUN_DIR:-$ROOT/data/run}"
mkdir -p "$RUN"
TSX="$ROOT/node_modules/.bin/tsx"
BOOT_ID="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || sysctl -n kern.boottime 2>/dev/null || echo unknown)"

# The process group a service started, or nothing if it was started before this boot: that number may now belong to
# something else, which must not be signalled, and must not pass for the service being up.
live_pgid() {
  local name="$1" pgid
  [ -s "$RUN/$name.pgid" ] || return 1
  # No boot file means this script's older self started it, so the number is trusted.
  if [ -f "$RUN/$name.boot" ] && [ "$(cat "$RUN/$name.boot")" != "$BOOT_ID" ]; then
    : >"$RUN/$name.pgid"
    return 1
  fi
  pgid="$(cat "$RUN/$name.pgid")"
  kill -0 -- "-$pgid" 2>/dev/null || return 1
  echo "$pgid"
}

# The commit this checkout is on. Empty with no git, as in an unpacked tarball, where nothing can be called old.
head_commit() { git -C "$ROOT" rev-parse HEAD 2>/dev/null || true; }

# True when a service is running code this checkout has moved past. One with no record was started by this script's
# older self, so nobody can say what it's running.
is_stale() {
  local name="$1" head
  live_pgid "$name" >/dev/null || return 1
  head="$(head_commit)"
  [ -n "$head" ] || return 1
  [ "$(cat "$RUN/$name.commit" 2>/dev/null || true)" != "$head" ]
}

entry() {
  case "$1" in
    acme) echo "packages/acme/src/main.ts" ;;
    gate) echo "packages/gate/src/main.ts" ;;
    core) echo "packages/core/src/main.ts" ;;
    desk) echo "packages/desk/src/server/main.ts" ;;
    *) echo "unknown service: $1" >&2; exit 2 ;;
  esac
}

port() {
  case "$1" in
    acme) echo 7800 ;;
    gate) echo 7710 ;;
    core) echo 7700 ;;
    desk) echo 7900 ;;
  esac
}

up_one() {
  local name="$1"
  if live_pgid "$name" >/dev/null; then
    echo "$name: already running"
    return 0
  fi
  # Not a subshell around the `&`: that would keep the caller's stdout open and record the wrong pid.
  # setsid execs in place here (a background job in a non-interactive shell is not a group leader), so
  # $! is both the pid and the new session's process group.
  cd "$ROOT"
  "$ROOT/scripts/new-session.sh" "$TSX" --env-file=.env "$(entry "$name")" >>"$RUN/$name.log" 2>&1 </dev/null &
  echo $! >"$RUN/$name.pgid"
  echo "$BOOT_ID" >"$RUN/$name.boot"
  head_commit >"$RUN/$name.commit"
  for _ in $(seq 1 40); do
    if curl -s -m 1 -o /dev/null "http://127.0.0.1:$(port "$name")/"; then
      echo "$name: up on $(port "$name")"
      return 0
    fi
    sleep 0.5
  done
  echo "$name: did not open port $(port "$name"); see $RUN/$name.log" >&2
  tail -5 "$RUN/$name.log" >&2 || true
  return 1
}

down_one() {
  local name="$1"
  local pgid
  if pgid="$(live_pgid "$name")"; then
    kill -TERM -- "-$pgid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 -- "-$pgid" 2>/dev/null || break
      sleep 0.25
    done
    kill -KILL -- "-$pgid" 2>/dev/null || true
  fi
  : >"$RUN/$name.pgid"
  rm -f "$RUN/$name.commit"
  echo "$name: stopped"
}

status_one() {
  local name="$1"
  local code path=/health
  # Core's health route needs the internal token, so a 401 still proves it's listening.
  [ "$name" = core ] && path=/v1/health
  [ "$name" = desk ] && path=/
  code="$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$(port "$name")$path" || true)"
  case "$code" in
    200 | 401) echo "$name: up (http $code)" ;;
    *) echo "$name: down (http $code)" ;;
  esac
}

command="${1:-status}"
services=("${@:2}")
[ "${#services[@]}" -gt 0 ] || services=(acme gate core desk)

case "$command" in
  up) for s in "${services[@]}"; do up_one "$s"; done ;;
  down) for s in "${services[@]}"; do down_one "$s"; done ;;
  status) for s in "${services[@]}"; do status_one "$s"; done ;;
  stale) for s in "${services[@]}"; do if is_stale "$s"; then echo "$s"; fi; done ;;
  *) echo "usage: $0 up|down|status|stale [acme|gate|core|desk]" >&2; exit 2 ;;
esac

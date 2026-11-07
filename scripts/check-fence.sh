#!/usr/bin/env bash
# Proves the fence with no LLM. For each machine it runs a probe inside the same bwrap arguments a controller
# runs with: what must be hidden is hidden, and what an agent needs still works. Canary files planted outside
# for the run make the hidden checks mean something on any host, even one with no ~/.ssh.
#
#   scripts/check-fence.sh                     every machine, from fresh arguments
#   scripts/check-fence.sh --machine <name>    one machine
#   scripts/check-fence.sh --live              also run the probe inside each running controller's own namespaces
#   scripts/check-fence.sh --no-services       skip the core and gate checks, before they are up
#
# Exits non-zero if anything fails. Prints paths and verdicts, never a file's contents.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${CLEARANCE_ROOT:-$(cd "$HERE/.." && pwd)}"
# shellcheck source=scripts/fence.sh
source "$HERE/fence.sh"

ONLY=""
LIVE=0
SERVICES=1
while [ $# -gt 0 ]; do
  case "$1" in
    --machine)
      ONLY="$2"
      shift 2
      ;;
    --live)
      LIVE=1
      shift
      ;;
    --no-services)
      SERVICES=0
      shift
      ;;
    *)
      echo "usage: $0 [--machine <name>] [--live] [--no-services]" >&2
      exit 2
      ;;
  esac
done

fence_supported || exit 1
if [ ! -d "$TOOLS/controller-src" ]; then
  echo "no controller build at $TOOLS/controller-src yet: run scripts/setup-controller.sh first" >&2
  exit 1
fi

CANARY_NAME=".fence-canary-$$"
CANARIES=("$HOME/$CANARY_NAME" "$REPO_ROOT/$CANARY_NAME" "$TOOLS/$CANARY_NAME")
if [ -d "$REPO_ROOT/data/" ]; then CANARIES+=("$REPO_ROOT/data/$CANARY_NAME"); fi
cleanup() { rm -f "${CANARIES[@]}"; }
trap cleanup EXIT
for canary in "${CANARIES[@]}"; do
  ( umask 077; echo canary >"$canary" )
  [ -r "$canary" ] || { echo "could not plant a canary at $canary" >&2; exit 1; }
done

# Everything hidden from this machine. Control: a path the host has is marked, so a pass there means something.
hidden_paths() {
  local machine="$1" other agent
  printf '%s\n' "${CANARIES[@]}" \
    "$HOME/.ssh" "$HOME/.aws" "$HOME/.gnupg" "$HOME/.netrc" "$HOME/.config/gh" "$HOME/.docker" \
    "$REPO_ROOT" "$REPO_ROOT/.env" "$REPO_ROOT/data" "$REPO_ROOT/data/secrets.json" \
    "$REPO_ROOT/data/hook-tokens.json" "$REPO_ROOT/data/gate-tokens.json" "$REPO_ROOT/vendor/switch/.env" \
    /var/run/docker.sock /run/docker.sock "/run/user/$(id -u)" "/proc/$$/cwd"
  fence_has_provider "$machine" claude || printf '%s\n' "$HOME/.claude/.credentials.json"
  fence_has_provider "$machine" codex || printf '%s\n' "$HOME/.codex/auth.json"
  for other in "${FENCE_MACHINES[@]}"; do
    [ "$other" = "$machine" ] && continue
    printf '%s\n' "$(fence_data_dir "$other")" "$(fence_home "$other")"
    for agent in $(fence_agents "$other"); do
      printf '%s\n' "$(fence_workspaces)/$agent"
    done
  done
}

# The probe, as text with every path quoted. It runs inside, where the host's helpers do not exist.
probe_script() {
  local machine="$1" path workspaces agent
  workspaces="$(fence_workspaces)"
  cat <<'PROBE'
bad=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; bad=1; }
hidden() { if [ -e "$1" ] || [ -L "$1" ]; then fail "visible: $1"; else pass "hidden: $1"; fi; }
touches() { { : >"$1/.fence-probe"; } 2>/dev/null; }
writes() { if touches "$1"; then rm -f "$1/.fence-probe"; pass "writes: $1"; else fail "cannot write: $1"; fi; }
readonly_path() { if touches "$1"; then rm -f "$1/.fence-probe"; fail "writable: $1"; else pass "read-only: $1"; fi; }
locked() {
  if [ -d "$1" ]; then if touches "$1"; then rm -f "$1/.fence-probe"; fail "an agent can rewrite: $1"; else pass "read-only to its agent: $1"; fi
  elif { : >>"$1"; } 2>/dev/null; then fail "an agent can rewrite: $1"; else pass "read-only to its agent: $1"; fi
}
runs() { if "$@" >/dev/null 2>&1; then pass "runs: $*"; else fail "does not run: $*"; fi; }
refused() { if "$@" >/dev/null 2>&1; then fail "should be refused: $*"; else pass "refused: $*"; fi; }
answers() {
  code="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$2" 2>/dev/null)"
  case "$code" in 200 | 401) pass "reaches $1 over loopback (http $code)" ;; *) fail "cannot reach $1 (http $code)" ;; esac
}
PROBE
  while IFS= read -r path; do
    printf 'hidden %q\n' "$path"
  done < <(hidden_paths "$machine")
  printf 'refused docker ps\n'
  for path in /usr /etc /opt "$TOOLS/controller-src"; do printf 'readonly_path %q\n' "$path"; done
  printf 'writes %q\nwrites /tmp\n' "$(fence_data_dir "$machine")"
  printf 'writes "$HOME"\n'
  printf 'if [ -e "$HOME/.claude/settings.json" ]; then locked "$HOME/.claude/settings.json"; fi\n'
  for agent in $(fence_agents "$machine"); do
    printf 'writes %q\n' "$workspaces/$agent"
    while IFS= read -r path; do printf 'locked %q\n' "$path"; done < <(fence_hook_paths "$workspaces/$agent")
  done
  printf 'runs node --version\nruns git --version\n'
  fence_has_provider "$machine" claude && printf 'runs claude --version\n'
  fence_has_provider "$machine" opencode && printf 'runs opencode --version\n'
  # An agent on a Claude machine can read this file. It must never hold the refresh token, which would let an
  # agent outlive the fence, or break the operator's own login by rotating it.
  if fence_has_provider "$machine" claude; then
    printf 'if grep -q refreshToken "$HOME/.claude/.credentials.json" 2>/dev/null; then fail "refresh token inside the fence"; else pass "no refresh token inside the fence"; fi\n'
  fi
  printf 'procs="$(ls /proc | grep -c "^[0-9]")"; if [ "$procs" -lt 40 ]; then pass "sees only its own $procs processes"; else fail "sees $procs processes"; fi\n'
  if [ "$SERVICES" = 1 ]; then
    printf 'answers core http://127.0.0.1:%s/v1/health\n' "${CLEARANCE_CORE_PORT:-7700}"
    printf 'answers gate http://127.0.0.1:%s/health\n' "${CLEARANCE_GATE_PORT:-7710}"
  fi
  printf 'exit "$bad"\n'
}

FAILED=0
check_machine() {
  local machine="$1" script
  fence_prepare "$machine"
  fence_args "$machine"
  fence_env
  script="$(probe_script "$machine")"
  echo "== $machine (owner $(fence_owner "$machine"), providers: $(fence_providers "$machine"))"
  if ! "${FENCE_ENV[@]}" "$(command -v bwrap)" "${FENCE_ARGS[@]}" bash -c "$script" 2>&1; then
    FAILED=1
  fi
}

# By what the process is, not just its number: after a reboot a pid file can name something else.
running_controller() { { tr '\0' ' ' <"/proc/$1/cmdline"; } 2>/dev/null | grep -q 'cli.mjs run'; }

# The process the controller really is: the node under the two bwrap processes, or the pid itself if unfenced.
live_pid() {
  local file pid child
  file="$REPO_ROOT/data/$(fence_stem "$1").pid"
  [ -f "$file" ] || return 1
  pid="$(cat "$file")"
  running_controller "$pid" || return 1
  child="$(pgrep -P "$pid" | head -n 1)"
  [ -n "$child" ] || return 1
  pgrep -P "$child" -x node | head -n 1
}

check_live() {
  local machine="$1" pid script
  if ! pid="$(live_pid "$machine")" || [ -z "$pid" ]; then
    echo "== $machine live: not running, or not fenced"
    if [ -f "$REPO_ROOT/data/$(fence_stem "$machine").pid" ] && running_controller "$(cat "$REPO_ROOT/data/$(fence_stem "$machine").pid")"; then
      echo "FAIL  $machine is running outside the fence"
      FAILED=1
    fi
    return 0
  fi
  script="$(probe_script "$machine")"
  echo "== $machine live, inside pid $pid"
  if [ "$(readlink "/proc/$pid/ns/mnt")" = "$(readlink /proc/$$/ns/mnt)" ]; then
    echo "FAIL  $machine shares the host's mount namespace"
    FAILED=1
    return 0
  fi
  if ! nsenter -t "$pid" -U -m -p -i -u --preserve-credentials -F \
    env -i "HOME=$HOME" "PATH=$(tr '\0' '\n' <"/proc/$pid/environ" | sed -n 's/^PATH=//p')" bash -c "$script" 2>&1; then
    FAILED=1
  fi
}

for machine in "${FENCE_MACHINES[@]}"; do
  if [ -n "$ONLY" ] && [ "$machine" != "$ONLY" ]; then continue; fi
  check_machine "$machine"
done
if [ "$LIVE" = 1 ]; then
  for machine in "${FENCE_MACHINES[@]}"; do
    if [ -n "$ONLY" ] && [ "$machine" != "$ONLY" ]; then continue; fi
    check_live "$machine"
  done
fi

if [ "$FAILED" != 0 ]; then
  echo "fence check FAILED"
  exit 1
fi
echo "fence check passed"

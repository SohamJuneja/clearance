#!/usr/bin/env bash
# Build, enroll and start the headless Switch agent controller on this host.
# Repeatable: each step is skipped when it is already done. No sudo.
#
#   scripts/setup-controller.sh            # build + enroll + start
#   scripts/setup-controller.sh --doctor   # doctor only
#   scripts/setup-controller.sh --restart  # stop, rewrite the env file, start
#   scripts/setup-controller.sh --stop     # stop
#
# Secrets are read from .env files by this script and never printed.
set -euo pipefail

REPO_ROOT="${CLEARANCE_ROOT:-/home/prashant/projects/Clearance}"
SWITCH_DIR="$REPO_ROOT/vendor/switch"
TOOLS="$HOME/.local/share/clearance-tools"
SRC="$TOOLS/controller-src/console"
CLI="$SRC/packages/agent-controller/dist/cli.mjs"
DATA_DIR="$TOOLS/controller-data"
RUN_DIR="$REPO_ROOT/data"
ENV_FILE="$RUN_DIR/controller.env"
LOG_FILE="$RUN_DIR/controller.log"
PID_FILE="$RUN_DIR/controller.pid"
BRIDGE_URL="${SWITCH_BRIDGE_URL:-http://127.0.0.1:8000}"
GATEWAY_URL="${SWITCH_GATEWAY_URL:-http://127.0.0.1:3000}"
MACHINE_NAME="${CLEARANCE_MACHINE_NAME:-clearance-host}"
PNPM="npx --yes pnpm@10.28.2"

# The PATH agents get. The pinned OpenCode comes first; the controller appends
# the login shell's entries after whatever it is given (login-path.ts).
AGENT_PATH="$TOOLS/node_modules/.bin:$HOME/.local/bin:$HOME/.volta/bin:/usr/local/bin:/usr/bin:/bin"

# Only these reach the controller, so nothing from the invoking shell (a parent
# agent's CLAUDE_* variables, say) leaks in.
CLEAN_ENV=(env -i "HOME=$HOME" "USER=${USER:-$(id -un)}" "SHELL=${SHELL:-/bin/bash}"
  "LANG=${LANG:-C.UTF-8}" "PATH=$AGENT_PATH")

env_value() { # file name
  sed -n "s/^$2=//p" "$1" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

running_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  kill -0 "$pid" 2>/dev/null || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q 'cli.mjs run' || return 1
  echo "$pid"
}

stop_controller() {
  local pid
  if pid="$(running_pid)"; then
    kill -TERM "$pid"
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    echo "stopped controller pid $pid"
  else
    echo "controller not running"
  fi
  rm -f "$PID_FILE"
}

doctor() {
  "${CLEAN_ENV[@]}" node "$CLI" doctor --data-dir "$DATA_DIR" --env-file "$ENV_FILE" || true
}

build_controller() {
  if [ -x "$CLI" ] && [ -f "$SRC/packages/agent-providers/dist/shared-host-daemon.mjs" ]; then
    echo "controller already built: $CLI"
    return
  fi
  mkdir -p "$SRC"
  # A copy, so the pinned checkout stays untouched: the build writes dist/ and node_modules/.
  rsync -a --delete --exclude node_modules --exclude dist "$SWITCH_DIR/console/" "$SRC/"
  (
    cd "$SRC"
    $PNPM install --frozen-lockfile --filter '@switch-console/agent-controller...' \
      --config.engine-strict=false --ignore-scripts --store-dir "$TOOLS/pnpm-store"
    NODE_OPTIONS=--max-old-space-size=2048 \
      $PNPM -r --filter '@switch-console/agent-controller...' run build
  )
}

write_env_file() {
  mkdir -p "$RUN_DIR"
  local token
  token="$(env_value "$REPO_ROOT/.env" CLEARANCE_HOOK_TOKEN)"
  [ -n "$token" ] || {
    echo "CLEARANCE_HOOK_TOKEN is empty in $REPO_ROOT/.env" >&2
    exit 1
  }
  (
    umask 077
    {
      echo "CLEARANCE_HOOK_TOKEN=$token"
      echo "PATH=$AGENT_PATH"
      # A build from source cannot update itself, and we pin the commit.
      echo "SWITCH_CONTROLLER_SELF_UPDATE=off"
    } >"$ENV_FILE"
  )
  chmod 600 "$ENV_FILE"
}

# The Machines page's "Add machine" button: POST /gateway/management/enrollment-codes
# with the signed-in admin's cookie. The code is valid for 10 minutes.
enrollment_code() {
  SWITCH_ENV="$SWITCH_DIR/.env" GATEWAY_URL="$GATEWAY_URL" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const env = Object.fromEntries(
      readFileSync(process.env.SWITCH_ENV, "utf8").split("\n")
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^(["\x27])(.*)\1$/, "$2")])
    );
    const base = process.env.GATEWAY_URL + "/gateway";
    const login = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: env.GATEWAY_ADMIN_EMAIL, password: env.GATEWAY_ADMIN_PASSWORD }),
    });
    if (!login.ok) throw new Error("gateway login failed: " + login.status);
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const res = await fetch(base + "/management/enrollment-codes", { method: "POST", headers: { cookie } });
    if (!res.ok) throw new Error("enrollment code refused: " + res.status);
    process.stdout.write((await res.json()).code);
  '
}

enroll_if_needed() {
  if [ -f "$DATA_DIR/controller.db" ] && [ -f "$DATA_DIR/secrets/controller-credential" ]; then
    echo "already enrolled: $DATA_DIR"
    return
  fi
  local code
  code="$(enrollment_code)"
  "${CLEAN_ENV[@]}" node "$CLI" enroll --server "$BRIDGE_URL" --code "$code" \
    --name "$MACHINE_NAME" --description "Clearance demo host" \
    --data-dir "$DATA_DIR" --secret-store file
}

start_controller() {
  local pid
  if pid="$(running_pid)"; then
    echo "controller already running, pid $pid"
    return
  fi
  nohup setsid "${CLEAN_ENV[@]}" node "$CLI" run --data-dir "$DATA_DIR" --env-file "$ENV_FILE" \
    >>"$LOG_FILE" 2>&1 </dev/null &
  echo $! >"$PID_FILE"
  sleep 5
  pid="$(running_pid)" || {
    echo "controller exited at once; see $LOG_FILE" >&2
    tail -n 20 "$LOG_FILE" >&2
    exit 1
  }
  echo "controller running, pid $pid, log $LOG_FILE"
}

case "${1:-}" in
  --doctor)
    doctor
    exit 0
    ;;
  --stop)
    stop_controller
    exit 0
    ;;
  --restart) stop_controller ;;
  "") ;;
  *)
    echo "usage: $0 [--doctor|--stop|--restart]" >&2
    exit 2
    ;;
esac

build_controller
write_env_file
enroll_if_needed
doctor
start_controller

#!/usr/bin/env bash
# Build, enroll and start a headless Switch agent controller on this host, one per owner: an agent can
# only run on a machine its owner holds. Repeatable: each step is skipped when it is already done. No sudo.
#
#   scripts/setup-controller.sh --owner priya            # build + enroll + start
#   scripts/setup-controller.sh --owner priya --doctor   # doctor only
#   scripts/setup-controller.sh --owner priya --restart  # stop, rewrite the env file, start
#   scripts/setup-controller.sh --owner priya --stop     # stop
#   scripts/setup-controller.sh --owner priya --status   # PID and RSS of the controller and its children
#   scripts/setup-controller.sh --owner priya --isolated-home   # run sessions from the isolated HOME,
#                                                                 which needs ANTHROPIC_API_KEY in .env
#
# --owner defaults to admin, the Gateway admin's machine `clearance-host`. A persona signs in to the
# Gateway as <owner>@clearance.example with PERSONA_PASSWORD from the root .env.
# CLEARANCE_EXTRA_PATH goes first on the PATH agents get, for a probe like spikes/claude-init-tee.
# Secrets are read from .env files by this script and never printed.
set -euo pipefail

OWNER=admin
ACTION=up
ISOLATED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --owner)
      OWNER="$2"
      shift 2
      ;;
    --doctor | --stop | --restart | --status)
      ACTION="${1#--}"
      shift
      ;;
    --isolated-home)
      ISOLATED=1
      shift
      ;;
    *)
      echo "usage: $0 [--owner <name>] [--isolated-home] [--doctor|--stop|--restart|--status]" >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="${CLEARANCE_ROOT:-/home/prashant/projects/Clearance}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SWITCH_DIR="$REPO_ROOT/vendor/switch"
TOOLS="$HOME/.local/share/clearance-tools"
SRC="$TOOLS/controller-src/console"
CLI="$SRC/packages/agent-controller/dist/cli.mjs"
RUN_DIR="$REPO_ROOT/data"
if [ "$OWNER" = admin ]; then
  DATA_DIR="$TOOLS/controller-data"
  STEM=controller
  MACHINE_NAME="${CLEARANCE_MACHINE_NAME:-clearance-host}"
else
  DATA_DIR="$TOOLS/controller-data-$OWNER"
  STEM="controller-$OWNER"
  MACHINE_NAME="${CLEARANCE_MACHINE_NAME:-clearance-$OWNER}"
fi
ENV_FILE="$RUN_DIR/$STEM.env"
LOG_FILE="$RUN_DIR/$STEM.log"
PID_FILE="$RUN_DIR/$STEM.pid"
BRIDGE_URL="${SWITCH_BRIDGE_URL:-http://127.0.0.1:8000}"
GATEWAY_URL="${SWITCH_GATEWAY_URL:-http://127.0.0.1:3000}"
PNPM="npx --yes pnpm@10.28.2"

NODE="$(node -p process.execPath)"
# The PATH agents get. The pinned OpenCode comes first; the controller appends the login shell's
# entries after whatever it is given (login-path.ts). Node's own folder is named because Volta's shim
# cannot find its home under an isolated HOME.
AGENT_PATH="${CLEARANCE_EXTRA_PATH:+$CLEARANCE_EXTRA_PATH:}$TOOLS/node_modules/.bin:$(dirname "$NODE"):$HOME/.local/bin:$HOME/.volta/bin:/usr/local/bin:/usr/bin:/bin"

SESSION_HOME="$HOME"
if [ "$ISOLATED" = 1 ]; then
  SESSION_HOME="$TOOLS/agent-home"
fi

# Only these reach the controller, so nothing from the invoking shell (a parent agent's CLAUDE_*
# variables, say) leaks in. Sessions take HOME from here.
CLEAN_ENV=(env -i "HOME=$SESSION_HOME" "USER=${USER:-$(id -un)}" "SHELL=${SHELL:-/bin/bash}"
  "LANG=${LANG:-C.UTF-8}" "PATH=$AGENT_PATH")

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
    echo "stopped $MACHINE_NAME, pid $pid"
  else
    echo "$MACHINE_NAME not running"
  fi
  rm -f "$PID_FILE"
}

status() {
  local pid
  if pid="$(running_pid)"; then
    echo "$MACHINE_NAME pid $pid"
    ps -o pid,ppid,rss,etime,comm -p "$pid" --ppid "$pid"
  else
    echo "$MACHINE_NAME not running"
  fi
}

doctor() {
  "${CLEAN_ENV[@]}" "$NODE" "$CLI" doctor --data-dir "$DATA_DIR" --env-file "$ENV_FILE" || true
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

# CLEARANCE_HOOK_TOKEN does not go here: the session allowlist drops it (spikes/RESULTS-vendors.md).
# scripts/setup-agents.ts delivers it per agent directory instead.
write_env_file() {
  mkdir -p "$RUN_DIR"
  (
    umask 077
    {
      echo "PATH=$AGENT_PATH"
      # A build from source cannot update itself, and we pin the commit.
      echo "SWITCH_CONTROLLER_SELF_UPDATE=off"
    } >"$ENV_FILE"
  )
  chmod 600 "$ENV_FILE"
}

# The Machines page's "Add machine" button: POST /gateway/management/enrollment-codes with the owner's
# session cookie. The code is valid for 10 minutes and is bound to whoever asked for it.
enrollment_code() {
  OWNER="$OWNER" SWITCH_ENV="$SWITCH_DIR/.env" ROOT_ENV="$REPO_ROOT/.env" GATEWAY_URL="$GATEWAY_URL" \
    "$NODE" --input-type=module -e '
    import { readFileSync } from "node:fs";
    const read = (path) => Object.fromEntries(
      readFileSync(path, "utf8").split("\n")
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^(["\x27])(.*)\1$/, "$2")])
    );
    const owner = process.env.OWNER;
    let email, password;
    if (owner === "admin") {
      const env = read(process.env.SWITCH_ENV);
      email = env.GATEWAY_ADMIN_EMAIL;
      password = env.GATEWAY_ADMIN_PASSWORD;
    } else {
      email = owner + "@clearance.example";
      password = read(process.env.ROOT_ENV).PERSONA_PASSWORD;
    }
    if (!password) throw new Error("no password for " + owner);
    const base = process.env.GATEWAY_URL + "/gateway";
    const login = await fetch(base + "/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!login.ok) throw new Error("gateway login as " + owner + " failed: " + login.status);
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const res = await fetch(base + "/management/enrollment-codes", { method: "POST", headers: { cookie } });
    if (!res.ok) throw new Error("enrollment code refused for " + owner + ": " + res.status);
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
  "${CLEAN_ENV[@]}" "$NODE" "$CLI" enroll --server "$BRIDGE_URL" --code "$code" \
    --name "$MACHINE_NAME" --description "Clearance demo machine for $OWNER" \
    --data-dir "$DATA_DIR" --secret-store file
}

start_controller() {
  local pid
  if pid="$(running_pid)"; then
    echo "$MACHINE_NAME already running, pid $pid"
    return
  fi
  nohup setsid "${CLEAN_ENV[@]}" "$NODE" "$CLI" run --data-dir "$DATA_DIR" --env-file "$ENV_FILE" \
    >>"$LOG_FILE" 2>&1 </dev/null &
  echo $! >"$PID_FILE"
  sleep 5
  pid="$(running_pid)" || {
    echo "$MACHINE_NAME exited at once; see $LOG_FILE" >&2
    tail -n 20 "$LOG_FILE" >&2
    exit 1
  }
  echo "$MACHINE_NAME running, pid $pid, log $LOG_FILE"
}

case "$ACTION" in
  doctor)
    doctor
    exit 0
    ;;
  stop)
    stop_controller
    exit 0
    ;;
  status)
    status
    exit 0
    ;;
  restart) stop_controller ;;
esac

if [ "$ISOLATED" = 1 ]; then
  "$HERE/setup-agent-home.sh"
fi
build_controller
write_env_file
enroll_if_needed
doctor
start_controller
status

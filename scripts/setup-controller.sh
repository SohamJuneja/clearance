#!/usr/bin/env bash
# Build, enroll and start a headless Switch agent controller on this host, one per machine: an agent can
# only run on a machine its owner holds. Each controller runs inside the fence in scripts/fence.sh, and its
# sessions inherit it. Repeatable: each step is skipped when it is already done. No sudo.
#
#   scripts/setup-controller.sh --owner priya            # clearance-priya: build + enroll + start
#   scripts/setup-controller.sh --machine clearance-alex-open   # a machine by name, from fence.sh's list
#   scripts/setup-controller.sh --owner priya --doctor   # doctor only, from inside the fence
#   scripts/setup-controller.sh --owner priya --restart  # stop, rewrite the env file, start. Ends its sessions
#   scripts/setup-controller.sh --owner priya --stop     # stop. Ends its sessions
#   scripts/setup-controller.sh --owner priya --status   # PID and RSS of the controller and its children
#   scripts/setup-controller.sh --owner priya --no-fence # no sandbox at all, for a host without bubblewrap. It says what
#                                                          that loses, and it never happens without this flag
#
# --owner defaults to admin, the Gateway admin's machine `clearance-host`. A persona signs in to the
# Gateway as <owner>@clearance.example with PERSONA_PASSWORD from the root .env.
# CLEARANCE_EXTRA_PATH goes first on the PATH agents get, for a probe like spikes/claude-init-tee.
# Secrets are read from .env files by this script and never printed.
set -euo pipefail
# So a step that fails says which, rather than just stopping. This is the command as written, so no secret is in it.
trap 'echo "setup-controller.sh stopped at line $LINENO: $BASH_COMMAND" >&2' ERR

OWNER=""
MACHINE_NAME=""
ACTION=up
NO_FENCE="${CLEARANCE_NO_FENCE:-0}"
while [ $# -gt 0 ]; do
  case "$1" in
    --owner)
      OWNER="$2"
      shift 2
      ;;
    --machine)
      MACHINE_NAME="$2"
      shift 2
      ;;
    --doctor | --stop | --restart | --status)
      ACTION="${1#--}"
      shift
      ;;
    --no-fence)
      NO_FENCE=1
      shift
      ;;
    *)
      echo "usage: $0 [--owner <name> | --machine <name>] [--no-fence] [--doctor|--stop|--restart|--status]" >&2
      exit 2
      ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${CLEARANCE_ROOT:-$(cd "$HERE/.." && pwd)}"
# shellcheck source=scripts/fence.sh
source "$HERE/fence.sh"
if [ -z "$MACHINE_NAME" ]; then
  case "${OWNER:-admin}" in
    admin) MACHINE_NAME=clearance-host ;;
    *) MACHINE_NAME="clearance-$OWNER" ;;
  esac
fi
if ! OWNER="$(fence_owner "$MACHINE_NAME")"; then
  echo "no machine named $MACHINE_NAME in scripts/fence.sh" >&2
  exit 2
fi

SWITCH_DIR="$REPO_ROOT/vendor/switch"
SRC="$TOOLS/controller-src/console"
CLI="$SRC/packages/agent-controller/dist/cli.mjs"
RUN_DIR="$REPO_ROOT/data"
DATA_DIR="$(fence_data_dir "$MACHINE_NAME")"
STEM="$(fence_stem "$MACHINE_NAME")"
FENCE_HOME="$(fence_home "$MACHINE_NAME")"
# In the machine's own data folder, because data/ is not visible from inside the fence.
ENV_FILE="$DATA_DIR/controller.env"
LOG_FILE="$RUN_DIR/$STEM.log"
PID_FILE="$RUN_DIR/$STEM.pid"
TOKEN_PID_FILE="$RUN_DIR/$STEM.token.pid"
FINGERPRINT_FILE="$RUN_DIR/$STEM.fence"
BRIDGE_URL="${SWITCH_BRIDGE_URL:-http://127.0.0.1:8000}"
GATEWAY_URL="${SWITCH_GATEWAY_URL:-http://127.0.0.1:3000}"
PNPM="npx --yes pnpm@10.28.2"

NODE="$(node -p process.execPath)"
AGENT_PATH="$(fence_path)"
fence_env
BWRAP="$(command -v "${CLEARANCE_BWRAP:-bwrap}" || true)"
FENCE_ARGS=()

# Where the controller runs: in the fence, or, only when --no-fence said so, plainly as this user.
wrapper() {
  WRAPPER=("${FENCE_ENV[@]}")
  if [ "$NO_FENCE" != 1 ]; then WRAPPER+=("$BWRAP" "${FENCE_ARGS[@]}"); fi
}

fenced() {
  wrapper
  "${WRAPPER[@]}" "$@"
}

running_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  kill -0 "$pid" 2>/dev/null || return 1
  fence_cmdline "$pid" | grep -q 'cli.mjs run' || return 1
  echo "$pid"
}

# The controller itself: the node under bwrap's two processes, or the pid when it predates the fence.
inner_pid() {
  local pid="$1" child
  case "$(fence_comm "$pid")" in
    *node) echo "$pid" ;;
    *)
      child="$(pgrep -P "$pid" | head -n 1 || true)"
      if [ -n "$child" ]; then pgrep -P "$child" -x node | head -n 1; fi
      ;;
  esac
}

stop_token_sync() {
  if [ -f "$TOKEN_PID_FILE" ]; then
    local pid
    pid="$(cat "$TOKEN_PID_FILE")"
    # By what it is: after a reboot that number can belong to anything.
    if fence_cmdline "$pid" | grep -q fence-claude-token; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$TOKEN_PID_FILE"
  fi
}

stop_controller() {
  local pid inner
  stop_token_sync
  if pid="$(running_pid)"; then
    inner="$(inner_pid "$pid" || true)"
    # Stopping the controller ends the sandbox's first process, and with it every session inside.
    kill -TERM "${inner:-$pid}"
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
    echo "$MACHINE_NAME pid $pid, $(case "$(fence_comm "$pid")" in *bwrap) echo fenced ;; *) echo NOT FENCED ;; esac)"
    ps -o pid,ppid,rss,etime,comm -p "$pid" --ppid "$pid"
  else
    echo "$MACHINE_NAME not running"
  fi
}

# Switch's CLI talks to someone installing a controller by hand. These lines tell a person running the demo to do things
# they shouldn't, with a command that isn't on their PATH. Node's warning about its own SQLite is no use to them either.
quiet_cli() {
  grep -v -e 'install-service' -e '^or in this terminal' -e 'ExperimentalWarning' -e 'trace-warnings' || true
}

doctor() {
  fenced "$NODE" "$CLI" doctor --data-dir "$DATA_DIR" --env-file "$ENV_FILE" 2>&1 | quiet_cli || true
}

build_controller() {
  if [ -x "$CLI" ] && [ -f "$SRC/packages/agent-providers/dist/shared-host-daemon.mjs" ]; then
    echo "controller already built: $CLI"
    return
  fi
  mkdir -p "$SRC" "$RUN_DIR"
  # A copy, so the pinned checkout stays untouched: the build writes dist/ and node_modules/.
  rsync -a --delete --exclude node_modules --exclude dist "$SWITCH_DIR/console/" "$SRC/"
  local log="$RUN_DIR/controller-build.log"
  echo "building Switch's agent controller, once. This takes a minute or two"
  if ! (
    cd "$SRC"
    $PNPM install --frozen-lockfile --filter '@switch-console/agent-controller...' \
      --config.engine-strict=false --ignore-scripts --store-dir "$TOOLS/pnpm-store"
    NODE_OPTIONS=--max-old-space-size=2048 \
      $PNPM -r --filter '@switch-console/agent-controller...' run build
  ) >"$log" 2>&1; then
    tail -n 30 "$log" >&2
    echo "the controller did not build. All of it is in $log" >&2
    return 1
  fi
}

# Hook tokens do not go here: the session allowlist drops them (spikes/RESULTS-vendors.md).
# scripts/setup-agents.ts delivers each agent's own to its directory instead.
write_env_file() {
  mkdir -p "$RUN_DIR" "$DATA_DIR"
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
  fenced "$NODE" "$CLI" enroll --server "$BRIDGE_URL" --code "$code" \
    --name "$MACHINE_NAME" --description "Clearance demo machine for $OWNER" \
    --data-dir "$DATA_DIR" --secret-store file 2>&1 | quiet_cli
}

fence_fingerprint() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s\n' "${FENCE_ARGS[@]+"${FENCE_ARGS[@]}"}" "${FENCE_ENV[@]}" | sha256sum | cut -d' ' -f1
  else
    printf '%s\n' "${FENCE_ARGS[@]+"${FENCE_ARGS[@]}"}" "${FENCE_ENV[@]}" | shasum -a 256 | cut -d' ' -f1
  fi
}

start_controller() {
  local pid
  if pid="$(running_pid)"; then
    # A login that landed since, or a new tool, changes the arguments. A running controller can't pick that up.
    if [ "$(cat "$FINGERPRINT_FILE" 2>/dev/null)" = "$(fence_fingerprint)" ]; then
      echo "$MACHINE_NAME already running, pid $pid"
      start_token_sync "$pid"
      return
    fi
    echo "$MACHINE_NAME's fence changed, so it restarts. That ends its sessions"
    stop_controller
  fi
  fence_fingerprint >"$FINGERPRINT_FILE"
  wrapper
  nohup "$HERE/new-session.sh" "${WRAPPER[@]}" "$NODE" "$CLI" run --data-dir "$DATA_DIR" --env-file "$ENV_FILE" \
    >>"$LOG_FILE" 2>&1 </dev/null &
  echo $! >"$PID_FILE"
  sleep 5
  pid="$(running_pid)" || {
    echo "$MACHINE_NAME exited at once; see $LOG_FILE" >&2
    tail -n 20 "$LOG_FILE" >&2
    exit 1
  }
  echo "$MACHINE_NAME running $([ "$NO_FENCE" = 1 ] && echo WITH NO FENCE || echo in the fence), pid $pid, log $LOG_FILE"
  start_token_sync "$pid"
}

# How Claude authenticates in this machine's home. An API key wins. Otherwise the operator's login, without its
# refresh token: see scripts/fence-claude-token.sh for why it cannot simply be bound in.
# The fence hides the home that OpenCode's own installer uses, so a machine that runs it gets a copy under $TOOLS.
OPENCODE_VERSION=1.18.27
install_opencode() {
  fence_has_provider "$MACHINE_NAME" opencode || return 0
  if [ "$NO_FENCE" = 1 ]; then
    command -v opencode >/dev/null 2>&1 && return 0
    echo "warning: OpenCode is not installed, so $MACHINE_NAME's agent will not run: curl -fsSL https://opencode.ai/install | bash" >&2
    return 0
  fi
  [ -x "$TOOLS/node_modules/.bin/opencode" ] && return 0
  echo "installing OpenCode $OPENCODE_VERSION for $MACHINE_NAME"
  mkdir -p "$TOOLS"
  if ! npm install --prefix "$TOOLS" --no-audit --no-fund --loglevel=error "opencode-ai@$OPENCODE_VERSION"; then
    echo "warning: OpenCode did not install, so $MACHINE_NAME's agent will not run. Rerun to try again." >&2
  fi
}

prepare_claude_login() {
  fence_has_provider "$MACHINE_NAME" claude || return 0
  # With no fence, sessions run in the real home and use whatever login is there.
  [ "$NO_FENCE" != 1 ] || return 0
  local key=""
  if [ -f "$REPO_ROOT/.env" ]; then
    key="$(sed -n 's/^ANTHROPIC_API_KEY=//p' "$REPO_ROOT/.env" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
  fi
  if [ -n "$key" ]; then
    rm -f "$FENCE_HOME/.claude/.credentials.json"
    CLEARANCE_ROOT="$REPO_ROOT" CLEARANCE_AGENT_HOME="$FENCE_HOME" CLEARANCE_AGENT_HOME_INSIDE="$HOME" "$HERE/setup-agent-home.sh"
    CLAUDE_AUTH=key
    return 0
  fi
  if [ ! -f "$HOME/.claude/.credentials.json" ]; then
    echo "warning: $MACHINE_NAME runs Claude agents, but .env has no ANTHROPIC_API_KEY and this host has no Claude login. They will not start." >&2
    CLAUDE_AUTH=none
    return 0
  fi
  cat >"$FENCE_HOME/.claude/settings.json" <<'JSON'
{
  "disableClaudeAiConnectors": true,
  "permissions": { "deny": ["mcp__claude_ai_*"] }
}
JSON
  "$HERE/fence-claude-token.sh" "$FENCE_HOME" --once
  CLAUDE_AUTH=login
}

start_token_sync() {
  [ "${CLAUDE_AUTH:-}" = login ] || return 0
  stop_token_sync
  nohup setsid "$HERE/fence-claude-token.sh" "$FENCE_HOME" --follow "$1" >>"$LOG_FILE" 2>&1 </dev/null &
  echo $! >"$TOKEN_PID_FILE"
}

# Codex and Cursor hooks run this, and the repo is not visible from inside the fence.
install_hook_cli() {
  mkdir -p "$TOOLS/hook-cli"
  cp "$REPO_ROOT/packages/hook-cli/src/main.ts" "$REPO_ROOT/packages/hook-cli/src/hook.ts" "$TOOLS/hook-cli/"
}

case "$ACTION" in
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

if [ "$NO_FENCE" = 1 ]; then
  fence_off_warning
elif ! fence_supported; then
  echo "refusing to run $MACHINE_NAME unfenced without --no-fence" >&2
  exit 1
fi
build_controller
install_hook_cli
install_opencode
fence_prepare "$MACHINE_NAME"
if [ "$NO_FENCE" != 1 ]; then fence_args "$MACHINE_NAME"; fi
if [ "$ACTION" = doctor ]; then
  doctor
  exit 0
fi
write_env_file
prepare_claude_login
enroll_if_needed
doctor
start_controller
status

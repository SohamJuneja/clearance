#!/usr/bin/env bash
# The fence around every agent controller, sourced by setup-controller.sh and check-fence.sh so that the
# check tests the very arguments a controller runs with. Sessions inherit it, because a controller's
# children stay in its namespaces.
#
# Everything is read-only, the real home is replaced by one private to the machine, and only these come back:
# that machine's agent folders and data folder read-write, and the tools it needs read-only. The repo, data/,
# other machines' folders, ~/.ssh, the Docker socket and other processes are not visible at all. The network
# stays shared so that loopback reaches core and the gate. docs/threat-model.md says what that leaves open.
#
# Set before sourcing: REPO_ROOT. HOME and PATH are the real ones. Never prints a secret.

TOOLS="${CLEARANCE_TOOLS:-$HOME/.local/share/clearance-tools}"
FENCE_BRIDGE_URL="${SWITCH_BRIDGE_URL:-http://127.0.0.1:8000}"

# machine -> owner, agents, and which logins it gets. scripts/setup-agents.test.ts checks this against the template.
# OpenCode has its own machine, with no Claude or Codex login, because a third-party model is on the other end.
# The baseline has its own because its folder holds the Acme admin key, on purpose. E2's OpenCode baseline has both
# reasons, so it shares with nobody. Only scripts/setup-e2.ts starts that one: `just demo` doesn't need it.
FENCE_MACHINES=(clearance-host clearance-priya clearance-priya-base clearance-priya-open-base clearance-alex clearance-alex-open)

fence_owner() {
  case "$1" in
    clearance-host) echo admin ;;
    clearance-priya | clearance-priya-base | clearance-priya-open-base) echo priya ;;
    clearance-alex | clearance-alex-open) echo alex ;;
    *) return 1 ;;
  esac
}

fence_agents() {
  case "$1" in
    clearance-priya) echo "refunds-agent support-agent" ;;
    clearance-priya-base) echo "refunds-agent-vanilla" ;;
    clearance-priya-open-base) echo "ops-agent-vanilla" ;;
    clearance-alex) echo "coder reviewer" ;;
    clearance-alex-open) echo "ops-agent" ;;
    *) echo "" ;;
  esac
}

fence_providers() {
  case "$1" in
    clearance-priya) echo "claude codex" ;;
    clearance-priya-base) echo "claude" ;;
    clearance-priya-open-base) echo "opencode" ;;
    clearance-alex) echo "claude cursor" ;;
    clearance-alex-open) echo "opencode" ;;
    # Runs no agent and is never enrolled: it only tries free models. It has no owner, so setup-controller.sh refuses it.
    clearance-opencode-probe) echo "opencode" ;;
    *) echo "" ;;
  esac
}

fence_has_provider() {
  case " $(fence_providers "$1") " in
    *" $2 "*) return 0 ;;
    *) return 1 ;;
  esac
}

# The folders the host side knows a machine by. The admin's machine keeps its older, unsuffixed names.
fence_data_dir() {
  if [ "$1" = clearance-host ]; then echo "$TOOLS/controller-data"; else echo "$TOOLS/controller-data-${1#clearance-}"; fi
}
fence_stem() {
  if [ "$1" = clearance-host ]; then echo controller; else echo "controller-${1#clearance-}"; fi
}
fence_home() { echo "$TOOLS/homes/$1"; }

# `paths.ts` in Switch: where a machine keeps agents, for this server.
fence_workspaces() {
  local host="${FENCE_BRIDGE_URL#*://}"
  host="${host%%/*}"
  echo "$HOME/.switch/agents/$(printf '%s' "$host" | sed -E 's/[^A-Za-z0-9._-]+/-/g')"
}

# One tool, read-only: the folder its real file lives in, and the name on PATH when that is in the hidden home.
_fence_tool() {
  local machine="$1" name="$2" found real
  found="$(command -v "$name" 2>/dev/null)" || return 0
  real="$(readlink -f "$found")"
  case "$real" in
    "$HOME"/*) FENCE_ARGS+=(--ro-bind "$(dirname "$real")" "$(dirname "$real")") ;;
  esac
  case "$found" in
    "$HOME"/*)
      if [ "$found" != "$real" ]; then
        # bwrap makes a file's mount point only in a folder that exists, and $HOME inside is this machine's home.
        mkdir -p "$(fence_home "$machine")$(dirname "${found#"$HOME"}")"
        FENCE_ARGS+=(--ro-bind "$real" "$found")
      fi
      ;;
  esac
}

# Creates what the bind mounts need on the host. Idempotent, and it writes no credential.
fence_prepare() {
  local machine="$1" home workspaces agent
  home="$(fence_home "$machine")"
  workspaces="$(fence_workspaces)"
  mkdir -p "$home/tmp" "$home/.claude" "$(fence_data_dir "$machine")" "$workspaces"
  chmod 700 "$home" "$home/.claude"
  # Agents commit as themselves: the operator's name and his signing setup stay outside.
  [ -f "$home/.gitconfig" ] || printf '[user]\n\tname = %s\n\temail = %s@clearance.example\n' "$machine" "$machine" >"$home/.gitconfig"
  [ -f "$home/.claude.json" ] || printf '{"hasCompletedOnboarding":true}\n' >"$home/.claude.json"
  for agent in $(fence_agents "$machine"); do
    mkdir -p "$workspaces/$agent"
  done
}

# Fills FENCE_ARGS. Binds later in the list win, so the order is: hide first, then give back.
fence_args() {
  local machine="$1" home data workspaces node_prefix agent
  home="$(fence_home "$machine")"
  data="$(fence_data_dir "$machine")"
  workspaces="$(fence_workspaces)"
  node_prefix="$(dirname "$(dirname "$(node -p process.execPath)")")"

  FENCE_ARGS=(
    --unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try
    --hostname "$machine"
    --new-session
    --ro-bind / /
    --dev /dev
    --proc /proc
    # The Docker socket and every per-user socket live under /run. DNS on systemd hosts does too.
    --tmpfs /run
    --ro-bind-try /run/systemd/resolve /run/systemd/resolve
    --tmpfs /var/tmp
    --tmpfs /mnt
    --tmpfs /media
    --bind "$home/tmp" /tmp
  )
  # All of /home, so another user's home and the repo in it are gone too.
  case "$HOME" in
    /home/*) FENCE_ARGS+=(--tmpfs /home) ;;
    *) FENCE_ARGS+=(--tmpfs "$(dirname "$HOME")") ;;
  esac
  FENCE_ARGS+=(--bind "$home" "$HOME")
  # A repo outside the home, say a judge's clone in /srv, is hidden by name.
  case "$REPO_ROOT" in
    "$HOME"/* | /home/* | /tmp/* | /var/tmp/* | /mnt/* | /media/*) ;;
    *) FENCE_ARGS+=(--tmpfs "$REPO_ROOT") ;;
  esac

  case "$node_prefix" in
    "$HOME"/*) FENCE_ARGS+=(--ro-bind "$node_prefix" "$node_prefix") ;;
  esac
  FENCE_ARGS+=(
    --ro-bind "$TOOLS/controller-src" "$TOOLS/controller-src"
    --ro-bind-try "$TOOLS/node_modules" "$TOOLS/node_modules"
    --ro-bind-try "$TOOLS/hook-cli" "$TOOLS/hook-cli"
    --bind "$data" "$data"
  )

  if fence_has_provider "$machine" claude; then
    _fence_tool "$machine" claude
  fi
  if fence_has_provider "$machine" codex; then
    # Volta's shim needs its whole home to work, so a Volta install is bound as the package, and on PATH directly.
    if [ -d "$HOME/.volta/tools/image/packages/@openai/codex" ]; then
      FENCE_ARGS+=(--ro-bind "$HOME/.volta/tools/image/packages/@openai/codex" "$HOME/.volta/tools/image/packages/@openai/codex")
    else
      _fence_tool "$machine" codex
    fi
    mkdir -p "$home/.codex"
    FENCE_ARGS+=(--ro-bind-try "$HOME/.codex/auth.json" "$HOME/.codex/auth.json")
  fi
  if fence_has_provider "$machine" cursor; then
    _fence_tool "$machine" cursor-agent
    mkdir -p "$home/.cursor" "$home/.config/cursor"
    FENCE_ARGS+=(
      --ro-bind-try "$HOME/.cursor/cli-config.json" "$HOME/.cursor/cli-config.json"
      --ro-bind-try "$HOME/.config/cursor/auth.json" "$HOME/.config/cursor/auth.json"
    )
  fi

  for agent in $(fence_agents "$machine"); do
    FENCE_ARGS+=(--bind "$workspaces/$agent" "$workspaces/$agent")
  done
  # The stand-in for GitHub: a push that gets through has to land somewhere the demo can see.
  if [ -n "$(fence_agents "$machine")" ]; then
    mkdir -p "$workspaces/.origin"
    FENCE_ARGS+=(--bind "$workspaces/.origin" "$workspaces/.origin")
  fi
}

# PATH inside: the pinned tools first. The controller appends the login shell's entries after this.
fence_path() {
  local node_bin extra=""
  node_bin="$(dirname "$(node -p process.execPath)")"
  if [ -d "$HOME/.volta/tools/image/packages/@openai/codex/bin" ]; then
    extra="$HOME/.volta/tools/image/packages/@openai/codex/bin:"
  fi
  local base="$TOOLS/node_modules/.bin:$node_bin:$extra$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
  # Claude Code wherever it was installed, as npm's global folder can be anywhere. Only when that isn't on the list already.
  local found
  if found="$(command -v claude 2>/dev/null)"; then
    case ":$base:" in
      *":$(dirname "$found"):"*) ;;
      *) base="$base:$(dirname "$found")" ;;
    esac
  fi
  echo "${CLEARANCE_EXTRA_PATH:+$CLEARANCE_EXTRA_PATH:}$base"
}

# A setting from the root .env. REPO_ROOT is the caller's, and the value is never printed.
_fence_env_value() {
  [ -f "$REPO_ROOT/.env" ] || return 0
  sed -n "s/^$1=//p" "$REPO_ROOT/.env" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# OPENCODE_PROVIDER_KEY goes in OpenCode's auth file in this machine's fenced home, under the provider its model names.
# It goes to machines that run OpenCode and no others. A key taken out of .env comes out of the machine too.
# The key reaches node by the environment, so it's never in a process's arguments.
fence_opencode_auth() {
  local machine="$1" file key model provider
  fence_has_provider "$machine" opencode || return 0
  [ -n "$(fence_agents "$machine")" ] || return 0
  file="$(fence_home "$machine")/.local/share/opencode/auth.json"
  key="$(_fence_env_value OPENCODE_PROVIDER_KEY)"
  model="$(_fence_env_value CLEARANCE_OPENCODE_MODEL)"
  case "$key:$model" in
    :*)
      rm -f "$file"
      return 0
      ;;
    */*) provider="${model%%/*}" ;;
    *)
      # Nothing says which provider it's for, and a key put under the wrong one is no use to anyone.
      rm -f "$file"
      return 0
      ;;
  esac
  (
    umask 077
    mkdir -p "$(dirname "$file")"
    OPENCODE_AUTH_KEY="$key" OPENCODE_AUTH_PROVIDER="$provider" OPENCODE_AUTH_FILE="$file" node -e '
      const { writeFileSync, chmodSync } = require("node:fs");
      const { OPENCODE_AUTH_KEY: key, OPENCODE_AUTH_PROVIDER: provider, OPENCODE_AUTH_FILE: file } = process.env;
      writeFileSync(file, `${JSON.stringify({ [provider]: { type: "api", key } }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
    '
  )
  echo "$machine: OpenCode has its key for $provider, in this machine's fenced home"
}

# OpenCode only knows models from a list it fetches, and the one it ships with is old. A model chosen from the fresh list
# is "not found" on a machine that hasn't fetched it, with nothing in the room to say so. A short command run first in a
# new home can leave that fetch undone, so this goes first. Returns non-zero if it couldn't, which callers warn about.
fence_opencode_refresh() {
  local machine="$1"
  fence_has_provider "$machine" opencode || return 0
  [ -d "$(fence_data_dir "$machine")" ] || return 0
  fence_args "$machine"
  fence_env
  timeout -k 3 60 "${FENCE_ENV[@]}" "$(command -v "${CLEARANCE_BWRAP:-bwrap}")" "${FENCE_ARGS[@]}" --die-with-parent \
    opencode models --refresh >/dev/null 2>&1
}

# What the fence's environment starts from. Nothing from the invoking shell gets in.
fence_env() {
  FENCE_ENV=(env -i "HOME=$HOME" "USER=${USER:-$(id -un)}" "SHELL=/bin/bash" "LANG=${LANG:-C.UTF-8}"
    "PATH=$(fence_path)" "TMPDIR=/tmp" "DISABLE_AUTOUPDATER=1")
}

# True when this host can make the fence at all. Says why when not, with the two usual remedies and the two ways on.
fence_supported() {
  local out bwrap="${CLEARANCE_BWRAP:-bwrap}"
  if ! command -v "$bwrap" >/dev/null 2>&1; then
    echo "bubblewrap is not installed, and agents do not run without the fence unless you say so. On Debian or Ubuntu: sudo apt install bubblewrap. Without it: just demo --no-agents for the scripted spine with no agents and no key, or just demo --no-fence to run agents with no sandbox." >&2
    return 1
  fi
  if ! out="$("$bwrap" --unshare-user --unshare-pid --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp true 2>&1)"; then
    echo "bwrap is installed but cannot make a sandbox here: $out" >&2
    echo "On Ubuntu 24.04 or later, AppArmor blocks it unless the profile is loaded: sudo apt install apparmor-profiles && sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict. Otherwise: just demo --no-agents, or just demo --no-fence." >&2
    return 1
  fi
}

# Stated once wherever agents are about to run without the fence, so nobody gets there by accident.
fence_off_warning() {
  cat >&2 <<'WARNING'
WARNING: --no-fence. Agents run with no sandbox, as you, on this machine. Here is what that loses:
  - They can read your home directory: SSH keys, cloud credentials, your Claude login, other projects.
  - They can read this repo's .env and data/, which hold the Acme admin key and every agent's tokens. With that key an
    agent can call Acme directly, so the gate is not a boundary on this run. Hooks are only a guardrail.
  - They can reach the Docker socket and see other processes.
Clearance's cards, routing and refusals work as usual. Use this on a machine or account you can throw away.
WARNING
}

# What a process is, without /proc, which macOS has not got.
fence_cmdline() { ps -p "$1" -o command= 2>/dev/null; }
fence_comm() { ps -p "$1" -o comm= 2>/dev/null; }

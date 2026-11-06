#!/usr/bin/env bash
# Prepare an isolated HOME for agent sessions, the strong connector containment. Sessions take HOME from
# the controller, so a session started from this HOME has no operator login, no claude.ai connectors,
# no user plugins and no operator settings. It authenticates with ANTHROPIC_API_KEY from the root .env,
# through apiKeyHelper, so the key is not in the session's environment.
#
#   scripts/setup-agent-home.sh           # exits 3 and changes nothing if there is no key yet
#   scripts/setup-agent-home.sh --check   # say what Claude Code would use from this HOME
#
# Never copies the operator's Claude credentials. Secrets are read here and never printed.
# CLEARANCE_AGENT_HOME picks another HOME. CLEARANCE_AGENT_API_KEY overrides the key, for tests only.
set -euo pipefail

REPO_ROOT="${CLEARANCE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
AGENT_HOME="${CLEARANCE_AGENT_HOME:-$HOME/.local/share/clearance-tools/agent-home}"
# Where a session sees this home. Inside the fence it is the session's $HOME, wherever it lives on the host.
AGENT_HOME_INSIDE="${CLEARANCE_AGENT_HOME_INSIDE:-$AGENT_HOME}"
KEY_FILE="$AGENT_HOME/.claude/api-key"
SETTINGS="$AGENT_HOME/.claude/settings.json"

if [ "${1:-}" = "--check" ]; then
  # Wherever it's installed: npm's global folder isn't ~/.local/bin. Only this asks, so only this needs it.
  CLAUDE_BIN="$(readlink -f "$(command -v claude)")"
  # auth status makes no model call.
  env -i HOME="$AGENT_HOME" USER="${USER:-$(id -un)}" LANG=C.UTF-8 PATH=/usr/bin:/bin \
    "$CLAUDE_BIN" auth status 2>&1 | head -n 20 || true
  [ ! -e "$AGENT_HOME/.claude/.credentials.json" ] && echo "no .credentials.json in $AGENT_HOME"
  exit 0
fi

key="${CLEARANCE_AGENT_API_KEY:-}"
if [ -z "$key" ] && [ -f "$REPO_ROOT/.env" ]; then
  key="$(sed -n 's/^ANTHROPIC_API_KEY=//p' "$REPO_ROOT/.env" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
fi
if [ -z "$key" ]; then
  echo "ANTHROPIC_API_KEY is empty in $REPO_ROOT/.env, so there is no isolated HOME yet." >&2
  echo "Agents stay on the operator's login, contained by disableClaudeAiConnectors and permissions.deny in their .claude/settings.json." >&2
  exit 3
fi

mkdir -p "$AGENT_HOME/.claude"
chmod 700 "$AGENT_HOME" "$AGENT_HOME/.claude"
(
  umask 077
  printf '%s\n' "$key" >"$KEY_FILE"
)
chmod 600 "$KEY_FILE"
cat >"$SETTINGS" <<JSON
{
  "apiKeyHelper": "cat $AGENT_HOME_INSIDE/.claude/api-key",
  "disableClaudeAiConnectors": true,
  "permissions": { "deny": ["mcp__claude_ai_*"] }
}
JSON
if [ -e "$AGENT_HOME/.claude/.credentials.json" ]; then
  echo "refusing: $AGENT_HOME holds Claude credentials, which must not be copied here" >&2
  exit 1
fi
echo "agent home ready: $AGENT_HOME"

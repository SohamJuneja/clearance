#!/usr/bin/env bash
# Spike S5, Codex without a login: real `codex exec` against spikes/codex-stub-model.mjs,
# in a scratch CODEX_HOME, so ~/.codex is never touched. NOT a run under Switch.
#
#   spikes/s5-codex-local.sh <variant>
#     project-trusted    hooks in <repo>/.codex/hooks.json, project trusted, hook not reviewed
#     project-untrusted  same hooks, project not trusted
#     user               hooks in $CODEX_HOME/hooks.json, hook not reviewed
#     none               no hooks: the control
#     project-seeded     as project-trusted, with trust written to config.toml first
#     user-seeded        as user, with trust written to config.toml first
#     project-untrusted-seeded  as project-untrusted, with seeding attempted
#     crash-seeded, badoutput-seeded, hang-seeded  the hook itself fails: does Codex fail open?
#     wrapped-crash-seeded, wrapped-hang-seeded    the same failures inside a shell wrapper
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
VARIANT="${1:?variant}"
BASE="$HOME/.local/share/clearance-tools/spike-work"
HOME_DIR="$BASE/codex-home-$VARIANT"
NAME="s5-codex-$VARIANT"
DIR="$(bash "$HERE/make-workdir.sh" "$NAME")"
ORIGIN="$BASE/$NAME-origin.git"
rm -rf "$HOME_DIR"
mkdir -p "$HOME_DIR"

{
  echo 'model = "stub-model"'
  echo 'model_provider = "stub"'
  echo 'approval_policy = "never"'
  echo 'sandbox_mode = "danger-full-access"'
  echo '[model_providers.stub]'
  echo 'name = "stub"'
  echo 'base_url = "http://127.0.0.1:7792/v1"'
  echo 'wire_api = "responses"'
  if [ "$VARIANT" != project-untrusted ] && [ "$VARIANT" != project-untrusted-seeded ]; then
    echo "[projects.\"$DIR\"]"
    echo 'trust_level = "trusted"'
  fi
} >"$HOME_DIR/config.toml"

HOOK_COMMAND="node $HERE/vendor-hook.mjs codex"
case "$VARIANT" in
  crash-seeded) HOOK_COMMAND="node $HERE/does-not-exist.mjs" ;;
  badoutput-seeded) HOOK_COMMAND="echo not-json" ;;
  hang-seeded) HOOK_COMMAND="sleep 20" ;;
  # Any failure of the inner command becomes exit 2, which blocks. The inner timeout is shorter
  # than Codex's own, so it fires first.
  wrapped-crash-seeded) HOOK_COMMAND="timeout 2 node $HERE/does-not-exist.mjs || { echo Clearance hook failed, blocking >&2; exit 2; }" ;;
  wrapped-hang-seeded) HOOK_COMMAND="timeout 2 sleep 20 || { echo Clearance hook timed out, blocking >&2; exit 2; }" ;;
esac

hooks_json() {
  cat <<JSON
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [ { "type": "command", "command": "$HOOK_COMMAND", "timeout": 3 } ] }
    ],
    "PermissionRequest": [
      { "hooks": [ { "type": "command", "command": "$HOOK_COMMAND", "timeout": 3 } ] }
    ]
  }
}
JSON
}

case "$VARIANT" in
  project-trusted | project-untrusted | project-seeded | project-untrusted-seeded | crash-seeded | badoutput-seeded | hang-seeded | wrapped-crash-seeded | wrapped-hang-seeded)
    mkdir -p "$DIR/.codex"
    hooks_json >"$DIR/.codex/hooks.json"
    ;;
  user | user-seeded) hooks_json >"$HOME_DIR/hooks.json" ;;
  none) ;;
  *)
    echo "unknown variant" >&2
    exit 2
    ;;
esac

echo "=== codex $VARIANT"
case "$VARIANT" in
  *-seeded) node "$HERE/codex-hooks-trust.mjs" "$HOME_DIR" "$DIR" --seed 2>&1 | cut -c1-320 ;;
  *) node "$HERE/codex-hooks-trust.mjs" "$HOME_DIR" "$DIR" 2>&1 | cut -c1-320 ;;
esac
(
  cd "$DIR" || exit 1
  env -u OPENAI_API_KEY CODEX_HOME="$HOME_DIR" timeout 60 codex exec --json "push my commit" 2>&1 </dev/null
) | cut -c1-500 | tail -n 14
LOCAL_SHA="$(git --git-dir="$DIR/.git" rev-parse --short main)"
ORIGIN_SHA="$(git --git-dir="$ORIGIN" rev-parse --short main)"
echo "result: local=$LOCAL_SHA origin=$ORIGIN_SHA pushed=$([ "$LOCAL_SHA" = "$ORIGIN_SHA" ] && echo YES || echo no)"

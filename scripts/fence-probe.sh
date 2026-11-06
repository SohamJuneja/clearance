#!/usr/bin/env bash
# Runs one command on the machine that only tries OpenCode's free models: fenced like an OpenCode agent, because a
# third-party model drives its tools, but with a home of its own, no agent's folder and no key. So trying a model can't
# reach a running agent's state. scripts/opencode-model.ts writes the file it reads and removes this home afterwards.
#
#   scripts/fence-probe.sh opencode models opencode --refresh --verbose
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLEARANCE_ROOT:-$(cd "$HERE/.." && pwd)}"
# shellcheck source=scripts/fence.sh
source "$HERE/fence.sh"

machine=clearance-opencode-probe
home="$(fence_home "$machine")"
mkdir -p "$home/work" "$home/tmp" "$(fence_data_dir "$machine")"
chmod 700 "$home"

# --no-fence was asked for and warned about. Its own home still keeps this away from anyone's OpenCode state.
if [ "${CLEARANCE_NO_FENCE:-0}" = 1 ]; then
  cd "$home/work"
  exec env -i "HOME=$home" "PATH=$PATH" "TMPDIR=$home/tmp" "LANG=${LANG:-C.UTF-8}" "$@"
fi

fence_args "$machine"
fence_env
exec "${FENCE_ENV[@]}" "$(command -v "${CLEARANCE_BWRAP:-bwrap}")" "${FENCE_ARGS[@]}" \
  --die-with-parent --chdir "$HOME/work" "$@"

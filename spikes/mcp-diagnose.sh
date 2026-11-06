#!/usr/bin/env bash
# Why does a session report clearance_gate:failed? Asks Claude Code's own `mcp` command in the agent's folder
# with the clean environment a session gets. No model call. Tokens are masked.
#   spikes/mcp-diagnose.sh <agent-dir>
DIR="$1"
cd "$DIR" || exit 1
env -i HOME="$HOME" USER="${USER:-prashant}" SHELL=/bin/bash LANG=C.UTF-8 PATH="$HOME/.local/bin:/usr/bin:/bin" \
  "$(readlink -f "$HOME/.local/bin/claude")" mcp list 2>&1 | sed -E 's/Bearer [A-Za-z0-9._-]+/Bearer ***/g' | cut -c1-200
env -i HOME="$HOME" USER="${USER:-prashant}" SHELL=/bin/bash LANG=C.UTF-8 PATH="$HOME/.local/bin:/usr/bin:/bin" \
  "$(readlink -f "$HOME/.local/bin/claude")" mcp get clearance_gate 2>&1 | sed -E 's/Bearer [A-Za-z0-9._-]+/Bearer ***/g' | cut -c1-200

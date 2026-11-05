#!/usr/bin/env bash
# Spike: is ENABLE_CLAUDEAI_MCP_SERVERS itself real, or only too late when set in a settings env block?
# One Haiku call outside Switch, with the variable as real process env, reading the init message.
# Under Switch the variable cannot arrive this way: it is not on the session allowlist.
set -uo pipefail
DIR="$(mktemp -d)"
cd "$DIR" || exit 1
env -i HOME="$HOME" USER="${USER:-prashant}" SHELL=/bin/bash LANG=C.UTF-8 PATH="$HOME/.local/bin:/usr/bin:/bin" \
  ENABLE_CLAUDEAI_MCP_SERVERS="${1:-false}" \
  claude -p "reply with the single word OK" --model haiku --output-format stream-json --verbose --max-turns 1 </dev/null 2>/dev/null |
  grep -m1 '"subtype":"init"' |
  python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
tools = d['tools']
print(json.dumps({
    'process_env_value': '${1:-false}',
    'tools_total': len(tools),
    'tools_mcp_claude_ai': sum(t.startswith('mcp__claude_ai_') for t in tools),
    'claude_ai_servers': [s['name'] for s in d['mcp_servers'] if s['name'].startswith('claude.ai')],
}))"
rm -rf "$DIR"

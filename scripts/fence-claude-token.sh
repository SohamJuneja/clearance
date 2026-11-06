#!/usr/bin/env bash
# Gives a fenced machine the operator's Claude login without the refresh token, and keeps it current.
#
#   scripts/fence-claude-token.sh <machine home> --once            write it now
#   scripts/fence-claude-token.sh <machine home> --follow <pid>    keep writing it until that pid ends
#
# Why not bind ~/.claude/.credentials.json in: Claude replaces that file by rename, so a bind keeps showing the old
# file. A session then refreshes from a stale refresh token, and refresh tokens rotate, which can break the
# operator's own login. Here only the host refreshes. An agent can read a short-lived access token, not the means
# to get another. When it expires and nothing has refreshed it, the agent stops working, which fails closed.
#
# If no Claude on this host has refreshed the login by 15 minutes before it expires, this makes one tiny Claude
# call on the host, with no tools and no settings, because that is what refreshes it. An API key in .env avoids
# all of this. Never prints a token.
set -euo pipefail

FENCE_HOME="$1"
MODE="${2:---once}"
FOLLOW="${3:-}"
SOURCE="$HOME/.claude/.credentials.json"
DEST="$FENCE_HOME/.claude/.credentials.json"
NUDGE_BELOW_MINUTES=15

# Writes the file only when it would change, by rename so a session never reads half of it. Prints minutes left.
sync_once() {
  SOURCE="$SOURCE" DEST="$DEST" node --input-type=module -e '
    import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
    import { dirname } from "node:path";
    const { SOURCE, DEST } = process.env;
    const login = JSON.parse(readFileSync(SOURCE, "utf8"));
    const oauth = login.claudeAiOauth;
    if (!oauth?.accessToken) throw new Error("no Claude login in the credentials file");
    const { refreshToken: _r, refreshTokenExpiresAt: _e, ...kept } = oauth;
    const next = JSON.stringify({ ...login, claudeAiOauth: kept });
    if (!existsSync(DEST) || readFileSync(DEST, "utf8") !== next) {
      mkdirSync(dirname(DEST), { recursive: true });
      const part = `${DEST}.${process.pid}.tmp`;
      writeFileSync(part, next, { mode: 0o600 });
      chmodSync(part, 0o600);
      renameSync(part, DEST);
    }
    process.stdout.write(String(Math.floor((oauth.expiresAt - Date.now()) / 60000)));
  '
}

nudge_host_login() {
  local dir
  dir="$(mktemp -d)"
  (
    cd "$dir"
    env -i "HOME=$HOME" "PATH=$PATH" "LANG=${LANG:-C.UTF-8}" claude -p ok --model haiku --tools "" \
      --setting-sources "" --strict-mcp-config --no-session-persistence >/dev/null 2>&1 || true
  )
  rmdir "$dir" 2>/dev/null || true
}

case "$MODE" in
  --once)
    sync_once >/dev/null
    ;;
  --follow)
    last_nudge=0
    seen=""
    last_full=0
    while kill -0 "$FOLLOW" 2>/dev/null; do
      # A refresh revokes the old token, so every second the copy lags can fail an agent's turn. Looking at the file is
      # cheap, so that's every second. Starting node to read it is not, so that's when it changed, or every 30 s for the
      # time left on the login.
      now="$(date +%s)"
      stamp="$(stat -c '%y %i' "$SOURCE" 2>/dev/null || true)"
      if [ "$stamp" != "$seen" ] || [ $((now - last_full)) -ge 30 ]; then
        seen="$stamp"
        last_full="$now"
        if left="$(sync_once 2>/dev/null)"; then
          if [ "$left" -lt "$NUDGE_BELOW_MINUTES" ] && [ $((now - last_nudge)) -gt 600 ]; then
            last_nudge="$now"
            echo "fence-claude-token: login has $left minutes left, asking Claude on the host to refresh it"
            nudge_host_login
            sync_once >/dev/null 2>&1 || true
          fi
        fi
      fi
      sleep 1
    done
    ;;
  *)
    echo "usage: $0 <machine home> --once | --follow <pid>" >&2
    exit 2
    ;;
esac

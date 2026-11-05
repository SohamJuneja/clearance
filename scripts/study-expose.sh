#!/usr/bin/env bash
# Puts Mattermost on a public tunnel for the study, once signup is proven off (PLAN 11.5, S10).
#
#   scripts/study-expose.sh                     apply, verify, start the tunnel, print the URL
#   scripts/study-expose.sh --verify-only       apply and verify, start no tunnel
#   scripts/study-expose.sh --max-seconds 90    stop the tunnel by itself after 90 seconds
#
#   SWITCH_DIR   the Switch checkout. Default: vendor/switch in this repo
#
# Recreates the Mattermost container and nothing else, so everyone connected drops for a few seconds.
# Stops the tunnel if signup turns out to be open through it. Ctrl-C stops the tunnel; the signup
# settings stay off until the stack is next brought up without the override.
#
# SiteURL stays http://localhost:8065, and that matters for one thing. This Mattermost only upgrades a
# websocket whose Origin is SiteURL or is listed in AllowCorsFrom, and without a websocket a browser
# never hears about a new card. A quick tunnel's URL isn't known until it starts, and SiteURL is locked
# by Switch's compose, so the tunnel's origin goes in AllowCorsFrom, which takes effect at once, keeps
# local browsers working, and is cleared again on exit. If this script is killed outright, it stays
# set until the next run replaces it. Nothing else here depends on SiteURL: cookies carry no domain, and
# cards hold no links.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWITCH_DIR="${SWITCH_DIR:-$REPO_ROOT/vendor/switch}"
OVERRIDE="$REPO_ROOT/deploy/study-exposure.compose.yml"
LOCAL_URL="http://127.0.0.1:8065"
export SWITCH_ENV_FILE="${SWITCH_ENV_FILE:-$SWITCH_DIR/.env}"

VERIFY_ONLY=false
MAX_SECONDS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify-only) VERIFY_ONLY=true ;;
    --max-seconds)
      MAX_SECONDS="${2:?--max-seconds needs a number}"
      shift
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

[[ -f "$SWITCH_DIR/deploy/local/standalone-docker-compose.yml" ]] || {
  echo "no Switch checkout at $SWITCH_DIR; set SWITCH_DIR" >&2
  exit 1
}

verify() {
  (cd "$REPO_ROOT" && pnpm exec tsx scripts/study-verify-signup.ts "$1")
}

compose() {
  docker compose \
    -f "$SWITCH_DIR/deploy/local/standalone-docker-compose.yml" \
    -f "$SWITCH_DIR/deploy/local/standalone-docker-compose.build.yml" \
    -f "$OVERRIDE" \
    --profile collab --profile gateway \
    --project-directory "$SWITCH_DIR" \
    "$@"
}

allow_origin() {
  compose exec -T mattermost mmctl --local config set ServiceSettings.AllowCorsFrom "$1" >/dev/null
}

# What a browser does to hear about new cards. curl waits on the open socket, so the time limit is normal.
websocket_status() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 --http1.1 \
    -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
    -H "Sec-WebSocket-Key: $(head -c 16 /dev/urandom | base64)" -H "Origin: $1" \
    "$1/api/v4/websocket" || true
}

echo "applying the override to the mattermost container"
compose up -d --no-deps --no-build mattermost

echo "waiting for mattermost"
for _ in $(seq 1 90); do
  if curl -fsS -o /dev/null "$LOCAL_URL/api/v4/system/ping" 2>/dev/null; then
    break
  fi
  sleep 2
done
curl -fsS -o /dev/null "$LOCAL_URL/api/v4/system/ping" || {
  echo "mattermost did not come back" >&2
  exit 1
}

echo "verifying signup is off"
if ! verify "$LOCAL_URL"; then
  echo "REFUSING to start a tunnel: signup is not proven off" >&2
  exit 1
fi

if [[ "$VERIFY_ONLY" == true ]]; then
  echo "signup is off. No tunnel started."
  exit 0
fi

command -v cloudflared >/dev/null || {
  echo "cloudflared is not installed" >&2
  exit 1
}

LOG_FILE="$(mktemp)"
TUNNEL_PID=""
ORIGIN_ALLOWED=false
cleanup() {
  if [[ -n "$TUNNEL_PID" ]]; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi
  if [[ "$ORIGIN_ALLOWED" == true ]]; then
    allow_origin "" || echo "could not clear AllowCorsFrom; set it back to empty by hand" >&2
  fi
  rm -f "$LOG_FILE"
  echo "tunnel stopped"
}
trap cleanup EXIT

cloudflared tunnel --no-autoupdate --url "$LOCAL_URL" >"$LOG_FILE" 2>&1 &
TUNNEL_PID=$!

PUBLIC_URL=""
for _ in $(seq 1 60); do
  PUBLIC_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_FILE" | head -n 1 || true)"
  [[ -n "$PUBLIC_URL" ]] && break
  kill -0 "$TUNNEL_PID" 2>/dev/null || {
    echo "cloudflared exited" >&2
    exit 1
  }
  sleep 1
done
[[ -n "$PUBLIC_URL" ]] || {
  echo "cloudflared gave no URL" >&2
  exit 1
}

# The tunnel takes a moment to be routable. Check what the outside sees before telling anyone the URL.
echo "verifying through the tunnel"
READY=false
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null --max-time 5 "$PUBLIC_URL/api/v4/system/ping"; then
    READY=true
    break
  fi
  sleep 2
done
[[ "$READY" == true ]] || {
  echo "the tunnel never became reachable" >&2
  exit 1
}
if ! verify "$PUBLIC_URL"; then
  echo "STOPPING the tunnel: signup is not proven off through it" >&2
  exit 1
fi

echo "allowing live updates from the tunnel's origin"
allow_origin "$PUBLIC_URL"
ORIGIN_ALLOWED=true
STATUS="$(websocket_status "$PUBLIC_URL")"
if [[ "$STATUS" != "101" ]]; then
  echo "STOPPING the tunnel: a browser would get no live updates through it (websocket answered $STATUS)" >&2
  exit 1
fi

echo
echo "Study URL: $PUBLIC_URL"
[[ -n "${STUDY_TUNNEL_URL_FILE:-}" ]] && printf '%s\n' "$PUBLIC_URL" >"$STUDY_TUNNEL_URL_FILE"
echo

if [[ -n "$MAX_SECONDS" ]]; then
  echo "stopping by itself after $MAX_SECONDS seconds"
  sleep "$MAX_SECONDS"
else
  echo "Ctrl-C stops the tunnel"
  wait "$TUNNEL_PID"
fi

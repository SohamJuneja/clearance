#!/usr/bin/env bash
# `pnpm eval:authority:live`: all of E1's live run, against the running stack. It sets up what the run needs and removes it
# afterwards: a throwaway agent, and a real second chat account for Sam, for case 10. Each run needs a new agent name,
# because a person's direct room with an agent outlives it, and an archived one stays silent.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2
export CLEARANCE_EVAL_LIVE_OK=1
NAME="e1-live-$(date +%H%M%S)"
pnpm exec tsx --env-file=.env spikes/e1-live-agent.ts up "$NAME" 2>&1 | cut -c1-200
pnpm exec tsx --env-file=.env spikes/e1-live-second-account.ts up 2>&1 | cut -c1-300
CLEARANCE_EVAL_LIVE_AGENT="$NAME" pnpm exec tsx eval/authority-suite/run.ts --live 2>&1 | cut -c1-2200
status=${PIPESTATUS[0]}
pnpm exec tsx --env-file=.env spikes/e1-live-second-account.ts down 2>&1 | cut -c1-300
pnpm exec tsx --env-file=.env spikes/e1-live-agent.ts down "$NAME" 2>&1 | cut -c1-200
# Switch queues a message to a stopped agent, and delivers it whenever that agent next starts. This run's asks must not
# carry over, or an agent starts on one in the middle of a later scene. A queued message goes with its room.
for room in support eng; do
  pnpm exec tsx scripts/demo/fresh-room.ts "$room" 2>&1 | tail -1 | cut -c1-200
done
pnpm exec tsx scripts/setup-e2.ts --restore 2>&1 | tail -1 | cut -c1-200
# Core loaded both names at its last start, so it restarts without them.
pnpm -s demo:reset 2>&1 | tail -1 | cut -c1-200
exit "$status"

#!/usr/bin/env bash
# Runs the Codex stub-model variants one after another and keeps only the lines that
# decide each result. Full output goes to data/spike-logs/s5-codex.log.
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG=/home/you/projects/Clearance/data/spike-logs/s5-codex.log
for variant in "$@"; do
  bash "$HERE/s5-codex-local.sh" "$variant" 2>&1 | tee -a "$LOG" |
    grep -E '^===|"trustStatus"|no hooks seen|warnings|errors|seeded [0-9]|ERROR|hook|^result' |
    grep -v 'permission_request' | sed -E 's/"currentHash.*//' | cut -c1-320
done

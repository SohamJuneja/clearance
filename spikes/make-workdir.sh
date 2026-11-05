#!/usr/bin/env bash
# Make one spike working directory: a git repo with one pushed commit, one local
# unpushed commit, and a local bare `origin`, so a `git push` that gets through is
# visible and can never leave this machine.
#
#   spikes/make-workdir.sh <name>     # prints the directory
set -euo pipefail
NAME="$1"
BASE="$HOME/.local/share/clearance-tools/spike-work"
DIR="$BASE/$NAME"
ORIGIN="$BASE/$NAME-origin.git"
mkdir -p "$BASE"
rm -rf "$DIR" "$ORIGIN"
git init --bare -q -b main "$ORIGIN"
git init -q -b main "$DIR"
cd "$DIR"
git config user.name spike
git config user.email spike@example.invalid
echo "# $NAME spike repo" >README.md
git add README.md
git commit -q -m "first"
git remote add origin "$ORIGIN"
git push -q -u origin main
echo "second" >>README.md
git commit -q -am "second, not pushed yet"
echo "$DIR"

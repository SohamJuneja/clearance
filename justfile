# Clearance. `just demo` brings up everything a judge needs.
set dotenv-load := false

switch_dir := "vendor/switch"
switch_sha := "1fe56227b6e330452ac80d7b7b2ca0a66aaeaeab"

default:
    @just --list

# Clone Switch at the pinned commit (never modified; see DECISIONS.md)
switch-fetch:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ ! -d {{switch_dir}}/.git ]; then
      git clone https://github.com/sandbox-quantum/switch {{switch_dir}}
    fi
    git -C {{switch_dir}} checkout --quiet {{switch_sha}}

# Install JS dependencies
install:
    pnpm install

# Typecheck, lint, test
check:
    pnpm typecheck
    pnpm lint
    pnpm test

# Clearance. `just demo` brings up everything a judge needs.
set dotenv-load := false

switch_dir := "vendor/switch"
switch_sha := "1fe56227b6e330452ac80d7b7b2ca0a66aaeaeab"

default:
    @just --list

# Everything a judge needs, from a fresh clone, safe to rerun. `just demo --check` changes nothing in the stack.
demo *args:
    bash scripts/demo.sh {{args}}

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

# Agents' working copies and the Acme rooms, safe to rerun. Needs Switch up and each machine's controller.
# Codex and Cursor agents wait for their logins, and a rerun creates them.
world:
    pnpm exec tsx --env-file=.env scripts/setup-agents.ts --source acme-mini-app
    scripts/services.sh down core
    scripts/services.sh up core
    pnpm exec tsx --env-file=.env scripts/setup-world.ts

# Prove the fence around agents, with no LLM: what must be hidden is hidden, and what they need still works.
check-fence:
    scripts/check-fence.sh --live

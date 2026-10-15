#!/usr/bin/env bash
# check.sh — the static gate: formatting, lint, type-check (CLI, MCP servers and libraries, hooks,
# tools, brain, tests), shell scripts (bash -n, shellcheck) and the desktop app's Rust.
# Run by `deno task check`, the pre-commit hook and scripts/ci.sh. The three groups (Deno, shell, Rust)
# share nothing and run at once, each into its own log; a failed one prints its log and the script fails.
#
#   scripts/check.sh            all three groups
#   scripts/check.sh --desktop  the Rust group only (the release job: the rest passed on `dev` already)
#   scripts/check.sh --fast     Deno and shell only: what a workstation runs before a commit (the Rust is CI's)
# The shellcheck step is optional on a workstation (skipped with a warning) and required in CI (CI=true).
# The Rust step runs where cargo and WebKitGTK are installed, CI included; elsewhere it is skipped.
set -euo pipefail
cd "$(dirname "$0")/.."

# optional <tool>: succeeds when the tool is installed; a missing tool fails only in CI.
optional() {
  command -v "$1" >/dev/null && return 0
  if [[ "${CI:-}" == true ]]; then
    echo "check: $1 is required in CI" >&2
    exit 1
  fi
  echo "check: $1 is not installed, skipped" >&2
  return 1
}

mode=${1:-all}
[[ "$mode" == all || "$mode" == --desktop || "$mode" == --fast ]] || {
  echo "usage: check.sh [--desktop|--fast]" >&2
  exit 2
}

deno_group() {
  deno fmt --check --quiet
  deno lint --quiet
  deno check --quiet apps/cli/*.ts apps/cli/lib/*.ts apps/cli/console/*.ts apps/cli/mcp/*.ts apps/cli/doctor/*.ts apps/cli/doctor/checks/*.ts apps/cli/tests/*.ts shared/mcp/lib/*.ts shared/mcp/lib/tasks/*.ts shared/mcp/*/server.ts shared/hooks/*.ts \
    shared/tools/*/*.ts scripts/*.ts apps/brain/*.ts apps/brain/tests/*.ts
}

# Every bash script, found by its shebang: a script added anywhere below is checked unedited.
shell_group() {
  local shell=() f
  for f in bin/* bin/lib/*.sh shared/statusline-command.sh shared/hooks/*.sh shared/hooks/lib/*.sh .githooks/* scripts/*.sh \
    apps/desktop/scripts/*.sh; do
    [[ -f "$f" ]] || continue
    head -n1 "$f" | grep -Eq '^#!.*(bash|sh)$|^# shellcheck shell=' || continue
    bash -n "$f" || {
      echo "bash syntax: $f" >&2
      return 1
    }
    shell+=("$f")
  done
  if optional shellcheck; then shellcheck -S warning "${shell[@]}"; fi
}

# The desktop app (apps/desktop): formatting and clippy, no release build. Building it needs WebKitGTK's
# headers besides cargo, which CI's image does not have yet: skipped, never required.
rust_group() {
  if ! command -v cargo >/dev/null; then
    echo "check: cargo is not installed, desktop app skipped" >&2
  elif ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    echo "check: webkit2gtk-4.1 is not installed, desktop app skipped" >&2
  else
    (cd apps/desktop/src-tauri && cargo fmt --check && cargo clippy --quiet --all-targets -- -D warnings)
  fi
}

logs=$(mktemp -d)
trap 'rm -rf "$logs"' EXIT
groups=(rust)
[[ "$mode" == all ]] && groups=(deno shell rust)
[[ "$mode" == --fast ]] && groups=(deno shell)
pids=()
for g in "${groups[@]}"; do
  "${g}_group" >"$logs/$g" 2>&1 &
  pids+=($!)
done
failed=0
for i in "${!groups[@]}"; do
  if wait "${pids[$i]}"; then
    cat "$logs/${groups[$i]}"
  else
    failed=1
    echo "check: ${groups[$i]} failed:" >&2
    cat "$logs/${groups[$i]}" >&2
  fi
done
((failed)) && exit 1
echo "check ok"

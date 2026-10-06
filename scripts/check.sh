#!/usr/bin/env bash
# check.sh — the static gate: formatting, lint, type-check (CLI, MCP servers and libraries, hooks,
# tools, brain, tests), shell scripts (bash -n, shellcheck) and the desktop app's Python.
# Run by `deno task check`, the pre-commit hook and scripts/ci.sh. Stops at the first failure.
# The shellcheck step is optional on a workstation (skipped with a warning) and required in CI (CI=true).
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

deno fmt --check --quiet
deno lint --quiet
deno check --quiet apps/cli/*.ts apps/cli/tests/*.ts shared/mcp/lib/*.ts shared/mcp/*/server.ts shared/hooks/*.ts \
  shared/tools/*/*.ts scripts/*.ts apps/brain/*.ts apps/brain/tests/*.ts

# Every bash script, found by its shebang: a script added anywhere below is checked unedited.
shell=()
for f in bin/* bin/lib/*.sh shared/statusline-command.sh shared/hooks/*.sh shared/hooks/lib/*.sh .githooks/* scripts/*.sh; do
  [[ -f "$f" ]] || continue
  head -n1 "$f" | grep -Eq '^#!.*(bash|sh)$|^# shellcheck shell=' || continue
  bash -n "$f" || {
    echo "bash syntax: $f" >&2
    exit 1
  }
  shell+=("$f")
done
if optional shellcheck; then shellcheck -S warning "${shell[@]}"; fi

python3 -m py_compile apps/tray/*.py
echo "check ok"

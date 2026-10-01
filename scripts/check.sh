#!/usr/bin/env bash
# check.sh — type-checks and lints the CLI and the brain service (tests included) and the console, and checks the syntax of
# every bash script and of the desktop app.
# Used by `deno task check`, by the pre-commit hook and by CI. Exits non-zero on the first problem.
set -euo pipefail
cd "$(dirname "$0")/.."
deno check cli/*.ts cli/tests/*.ts shared/mcp/lib/*.ts shared/mcp/*/server.ts brain/*.ts brain/tests/*.ts
deno lint --quiet
# Globs, not a list: a wrapper added to bin/ is checked without editing this file.
for f in bin/* bin/lib/*.sh shared/statusline-command.sh shared/hooks/*.sh .githooks/pre-commit scripts/check.sh; do
  [[ -f "$f" ]] || continue
  head -n1 "$f" | grep -q '^#!.*\(bash\|sh\)$' || continue
  bash -n "$f" || { echo "bash syntax: $f" >&2; exit 1; }
done
python3 -m py_compile lib/claude-multi-app/*.py
echo "check ok"

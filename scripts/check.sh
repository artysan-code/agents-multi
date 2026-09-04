#!/usr/bin/env bash
# check.sh — type-check della CLI (test inclusi) + sintassi di ogni script bash del repo. Usato da `deno task check`,
# dal pre-commit e dalla CI. Exit != 0 al primo problema.
set -euo pipefail
cd "$(dirname "$0")/.."
deno check cli/*.ts cli/tests/*.ts
for f in bin/claude bin/claude-work bin/claude-personal bin/claude-multi bin/claude-launch bin/claude-update \
         bin/claude-update-notify bin/claude-desktop-update bin/claude-desktop-work-rebuild bin/lib/prelaunch.sh \
         shared/statusline-command.sh shared/hooks/*.sh .githooks/pre-commit scripts/check.sh; do
  bash -n "$f" || { echo "sintassi bash: $f" >&2; exit 1; }
done
python3 -m py_compile lib/claude-update-gui/app.py
echo "check ok"

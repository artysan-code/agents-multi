#!/usr/bin/env bash
# Global desktop notification on session Stop.
# Silent no-op if notify-send is unavailable (CI, headless, other dev machines).
#
# Repo-specific override: defer if $CLAUDE_PROJECT_DIR/.claude/hooks/notify-stop.sh exists.

set -euo pipefail

# Defer to repo-local override if present
if [ -f "${CLAUDE_PROJECT_DIR:-$PWD}/.claude/hooks/notify-stop.sh" ]; then
  exit 0
fi

if command -v notify-send >/dev/null 2>&1; then
  repo=$(basename "${CLAUDE_PROJECT_DIR:-$PWD}")
  notify-send -t 4000 -a "Claude Code" "Task done — $repo" "Risposta completata" 2>/dev/null || true
fi

exit 0

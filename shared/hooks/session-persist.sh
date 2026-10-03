#!/usr/bin/env bash
# Stop hook: persist minimal session metadata (R5 EXTEND model).
# Writes to ~/.local/share/claude-sessions/ (NOT synced, XDG).
# NEVER parses the transcript — zero PII risk.
# Repo-local override: if $CLAUDE_PROJECT_DIR/.claude/hooks/session-persist.sh exists, exec it.

set -uo pipefail

# Defer to repo-local override
if [ -f "${CLAUDE_PROJECT_DIR:-$PWD}/.claude/hooks/session-persist.sh" ]; then
  exec bash "${CLAUDE_PROJECT_DIR:-$PWD}/.claude/hooks/session-persist.sh"
fi

SESSION_DIR="$HOME/.local/share/claude-sessions"
mkdir -p "$SESSION_DIR"
chmod 700 "$SESSION_DIR"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
project_name=$(basename "$PROJECT_DIR")
branch=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "no-git")
date_str=$(date +%Y-%m-%d)
time_str=$(date +%H:%M:%S)

# Derive a short id: last 8 chars of session UUID env, or git short sha
short_id="local"
if [ -n "${CLAUDE_SESSION_ID:-}" ]; then
  short_id=$(printf '%s' "$CLAUDE_SESSION_ID" | tail -c 8)
elif git -C "$PROJECT_DIR" rev-parse --short HEAD >/dev/null 2>&1; then
  short_id=$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null)
fi

session_file="$SESSION_DIR/${date_str}-${project_name}-session.tmp"

if [ -f "$session_file" ]; then
  # Update 'Last Updated' line only
  # Use a temp file to avoid sed -i portability issues
  tmp=$(mktemp)
  grep -v '^\*\*Last Updated:\*\*' "$session_file" > "$tmp" || true
  printf '**Last Updated:** %s\n' "$time_str" >> "$tmp"
  mv "$tmp" "$session_file"
else
  # Create minimal header — no transcript content
  cat > "$session_file" <<HEADER
# Session: $date_str

**Date:** $date_str
**Started:** $time_str
**Last Updated:** $time_str
**Project:** $project_name
**Branch:** $branch
**Worktree:** $PROJECT_DIR
**ShortID:** $short_id

---

(Auto-created by session-persist.sh — use /save-session to add rich context)
HEADER
  chmod 600 "$session_file"
fi

exit 0

#!/usr/bin/env bash
# PreCompact hook: mark session file before context compaction.
# Appends compaction event to the project's .tmp so the next session
# knows context was summarized and Serena needs re-activation.

set -uo pipefail

SESSION_DIR="~/.local/share/claude-sessions"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
project_name=$(basename "$PROJECT_DIR")
date_str=$(date +%Y-%m-%d)
time_str=$(date '+%Y-%m-%d %H:%M:%S')

# Find most recent .tmp for this project
session_file="$SESSION_DIR/${date_str}-${project_name}-session.tmp"
if [ ! -f "$session_file" ]; then
  # Try any date prefix
  session_file=$(ls -t "$SESSION_DIR"/*-"${project_name}-session.tmp" 2>/dev/null | head -1 || true)
fi

if [ -f "$session_file" ]; then
  printf '\n---\n[Compaction at %s] Context summarized. Re-run mcp__serena__activate_project before next edit in files >300 lines.\n' "$time_str" >> "$session_file"
fi

exit 0

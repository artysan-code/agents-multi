#!/usr/bin/env bash
# PreToolUse(Read|Edit|Write) hook: loads the AGENTS.md of the folder the agent is about to work
# in, the first time that folder is touched in a session.
#
# Why: Claude Code natively discovers the root AGENTS.md, but a NESTED one (AGENTS.md or
# CLAUDE.md in a subfolder) was not picked up in empirical tests (Claude Code 2.1.258, print
# mode), so it cannot be relied on. This hook makes it deterministic, and it also works for
# subagents and print mode.
#
# Lazy by design: it injects only the touched folder's file, once per session, so twenty maps
# do not become thousands of dead tokens.
#
# Input: PreToolUse JSON on stdin (tool_input.file_path, session_id, cwd).
# Output: hookSpecificOutput.additionalContext JSON on stdout. Never blocks; always exit 0.
set -uo pipefail
trap 'exit 0' EXIT

INPUT=$(cat 2>/dev/null) || exit 0

FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
[ -n "$FILE" ] || exit 0

SESSION=$(printf '%s' "$INPUT" | jq -r '.session_id // "nosession"' 2>/dev/null)
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null); CWD="${CWD:-$PWD}"

DIR=$(dirname "$FILE")
[ -d "$DIR" ] || exit 0

# Root to stop at: the project (its own AGENTS.md is already loaded natively).
ROOT="${CLAUDE_PROJECT_DIR:-}"
[ -z "$ROOT" ] && ROOT=$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null)
[ -z "$ROOT" ] && ROOT="$CWD"
ROOT=$(cd "$ROOT" 2>/dev/null && pwd -P) || exit 0
DIR=$(cd "$DIR" 2>/dev/null && pwd -P) || exit 0

# the file must be inside the root
case "$DIR/" in "$ROOT"/*) ;; *) exit 0 ;; esac

# Nearest AGENTS.md walking upwards, stopping BEFORE the root
FOUND=""
D="$DIR"
while [ "$D" != "$ROOT" ] && [ "$D" != "/" ]; do
  if [ -f "$D/AGENTS.md" ]; then FOUND="$D/AGENTS.md"; break; fi
  D=$(dirname "$D")
done
[ -n "$FOUND" ] || exit 0

# already injected in this session?
STATE_DIR="${XDG_RUNTIME_DIR:-/tmp}/claude-agents-md/$SESSION"
KEY=$(printf '%s' "$FOUND" | md5sum | cut -d' ' -f1)
[ -f "$STATE_DIR/$KEY" ] && exit 0
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

# Safety cap: an oversized AGENTS.md is a bug in that repo, not a reason to flood the context.
BYTES=$(wc -c < "$FOUND" 2>/dev/null || echo 0)
if [ "$BYTES" -gt 12000 ]; then
  : > "$STATE_DIR/$KEY"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"Nested AGENTS.md in %s is %s bytes (>12k): not injected. Read it yourself if needed, and consider shortening it: it should only contain what does not go stale with every commit."}}\n' \
    "${FOUND#$ROOT/}" "$BYTES"
  exit 0
fi

: > "$STATE_DIR/$KEY"

BODY=$(cat "$FOUND")
REL="${FOUND#$ROOT/}"

jq -cn --arg rel "$REL" --arg body "$BODY" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:("FOLDER INSTRUCTIONS — " + $rel + " (loaded because you are working in that folder; they take precedence over the root conventions for the files it contains):\n\n" + $body)}}' \
  2>/dev/null || exit 0

exit 0

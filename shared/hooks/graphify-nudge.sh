#!/usr/bin/env bash
# Global graphify-nudge: PreToolUse hook that steers toward graphify before a broad search
# (grep/find/rg via Bash, or the native Grep/Glob tools).
#
# Never blocks: only emits additionalContext (hookSpecificOutput JSON on stdout).
# Self-disabling: no-op if graphify-out/graph.json does not exist in the current project.
#
# Repo-specific override: if $CLAUDE_PROJECT_DIR/.claude/hooks/graphify-nudge.sh exists,
# this global hook NO-OPs (the project's local version takes precedence).

set -uo pipefail

# Defer to repo-local override if present
if [ -f "${CLAUDE_PROJECT_DIR:-$PWD}/.claude/hooks/graphify-nudge.sh" ]; then
  exit 0
fi

GRAPH="${CLAUDE_PROJECT_DIR:-.}/graphify-out/graph.json"
[ -f "$GRAPH" ] || exit 0

INPUT=$(cat)

TOOL=$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try: d=json.load(sys.stdin); print(d.get("tool_name",""))
except: pass' 2>/dev/null || echo "")

case "$TOOL" in
  Bash)
    CMD=$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try: d=json.load(sys.stdin); print(d.get("tool_input",{}).get("command",""))
except: pass' 2>/dev/null || echo "")
    case "$CMD" in
      *grep*|*" rg "*|*" find "*|*" fd "*|*" ack "*|*" ag "*) ;;
      *) exit 0 ;;
    esac
    ;;
  Grep|Glob) ;;
  *) exit 0 ;;
esac

# Freshness: warn if the graph is more than 7 days old
NOW=$(date +%s)
MTIME=$(stat -c %Y "$GRAPH" 2>/dev/null || echo "$NOW")
AGE_DAYS=$(( (NOW - MTIME) / 86400 ))
FRESH_WARN=""
if [ "$AGE_DAYS" -gt 7 ]; then
  FRESH_WARN=" The graph is $AGE_DAYS days old: consider \`graphify update .\` (AST-only, no cost) or \`graphify rebuild .\` (semantic, ~\$0.05) before querying if the area has changed."
fi

MSG='graphify decision tree: broad or conceptual discovery → `graphify query "<question>"` or `graphify explain "<node>"` (BFS subgraph, tokens scoped). A specific symbol or its callers → `grep -rn '"'"'name('"'"'` with a narrow scope. A literal text pattern (TODO, env name, regex) → native search with a narrow scope. Never Read a whole file of 300+ lines.'
# serialised by Python, never by hand: the message holds quotes and backticks
MSG="$MSG$FRESH_WARN" python3 -c 'import json,os
print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":os.environ["MSG"]}}, ensure_ascii=False))'

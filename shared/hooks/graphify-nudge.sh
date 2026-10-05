#!/usr/bin/env bash
# Global graphify-nudge — PreToolUse hook che spinge verso graphify
# prima di search broad (grep/find/rg via Bash, oppure Grep/Glob nativi).
#
# Non blocca: solo emette additionalContext.
# Auto-disabling: no-op se graphify-out/graph.json non esiste nel progetto corrente.
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
      *grep*|*" rg "*|*ripgrep*|*" find "*|*" fd "*|*" ack "*|*" ag "*) ;;
      *) exit 0 ;;
    esac
    ;;
  Grep|Glob) ;;
  *) exit 0 ;;
esac

# Freshness: warn if graph > 7 days old
NOW=$(date +%s)
MTIME=$(stat -c %Y "$GRAPH" 2>/dev/null || echo "$NOW")
AGE_DAYS=$(( (NOW - MTIME) / 86400 ))
FRESH_WARN=""
if [ "$AGE_DAYS" -gt 7 ]; then
  FRESH_WARN=" Graph è di $AGE_DAYS giorni fa — considera \`graphify update .\` (AST-only, zero costo) o \`graphify rebuild .\` (semantico, ~\$0.05) prima della query se l'area è cambiata."
fi

cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"graphify decision tree: discovery broad/concettuale → \`graphify query \\\"<domanda>\\\"\` o \`graphify explain \\\"<nodo>\\\"\` (BFS subgraph, tokens scoped). Simbolo specifico o chi lo chiama → \`grep -rn 'nome('\` con scope limitato. Pattern testuale letterale (TODO, env name, regex) → search nativa con scope limitato. Mai Read full su file ≥300 righe.${FRESH_WARN}"}}
EOF

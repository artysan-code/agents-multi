#!/usr/bin/env bash
# Global SessionStart hook — ricorda di chiamare mcp__serena__activate_project
# se il progetto ha un .serena/project.yml già configurato.
#
# Lo state Serena non persiste cross-session anche se .serena/ esiste, quindi
# il bootstrap va fatto ad ogni sessione nuova. Questo hook emette solo
# additionalContext (non blocca, non chiama il tool).
#
# Repo-specific override: se la session-context.sh del progetto già ricorda
# Serena, questo è ridondante — è un fallback per progetti senza session hook.

set -uo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -f "$PROJECT_DIR/.serena/project.yml" ] || exit 0

# Se c'è già un session-context.sh nel repo, deferisci (probabile menzioni già Serena)
if [ -f "$PROJECT_DIR/.claude/hooks/session-context.sh" ]; then
  exit 0
fi

cat <<EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Serena MCP project detected (.serena/project.yml). Prima del primo code work, chiama \`mcp__serena__activate_project\` con path repo — lo state non persiste cross-session. Decision tree: simbolo TS/Python specifico → \`find_symbol\` / \`find_referencing_symbols\` / \`get_symbols_overview\`. Edit di 1 simbolo in file >300 righe → \`replace_symbol_body\`. Pattern testuale letterale → grep nativo. Read full su file ≥300 righe è bloccato dal read-guard."}}
EOF

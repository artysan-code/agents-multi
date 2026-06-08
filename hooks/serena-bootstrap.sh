#!/usr/bin/env bash
# Global SessionStart hook — ricorda di chiamare mcp__serena__activate_project
# se il progetto ha un .serena/project.yml già configurato.
#
# Lo state Serena non persiste cross-session anche se .serena/ esiste, quindi
# il bootstrap va fatto ad ogni sessione nuova. Questo hook emette solo
# additionalContext (non blocca, non chiama il tool).
#
# ESTESO (R5): oltre al nudge Serena, inietta l'ultima sessione persistita
# (<=7gg, come HISTORICAL REFERENCE) e nudge a creare TASKS.md se assente.
# Emette un SINGOLO oggetto JSON via jq.
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

# (1) Testo Serena (statico). Single-quote: backtick e → restano letterali.
serena_ctx='Serena MCP project detected (.serena/project.yml). Prima del primo code work, chiama `mcp__serena__activate_project` con path repo — lo state non persiste cross-session. Decision tree: simbolo TS/Python specifico → `find_symbol` / `find_referencing_symbols` / `get_symbols_overview`. Edit di 1 simbolo in file >300 righe → `replace_symbol_body`. Pattern testuale letterale → grep nativo. Read full su file ≥300 righe è bloccato dal read-guard.'

# (2) Session inject — ultimo .tmp del progetto (NON syncato, no transcript)
SESSION_DIR="~/.local/share/claude-sessions"
project_name=$(basename "$PROJECT_DIR")
session_ctx=""
session_file=$(ls -t "$SESSION_DIR"/*-"${project_name}-session.tmp" 2>/dev/null | head -1 || true)
if [ -n "$session_file" ] && [ -f "$session_file" ]; then
  now=$(date +%s)
  mtime=$(stat -c %Y "$session_file" 2>/dev/null || echo "$now")
  age_days=$(( (now - mtime) / 86400 ))
  if [ "$age_days" -le 7 ]; then
    content=$(cat "$session_file")
    session_ctx=$'\n\n--- Ultima sessione su questo progetto (HISTORICAL REFERENCE ONLY — NON agire senza verificare lo stato attuale) ---\n'"$content"
  else
    session_ctx=$'\n\nSessione precedente stale (>7gg): '"$session_file"$' — controlla manualmente se serve.'
  fi
fi

# (3) TASKS nudge
tasks_ctx=""
if [ ! -f "$PROJECT_DIR/TASKS.md" ]; then
  tasks_ctx=$'\n\nNessun TASKS.md nel progetto: se inizi un lavoro multi-step, crea TASKS.md per tracciare le attività.'
fi

additional_ctx="${serena_ctx}${session_ctx}${tasks_ctx}"

jq -n --arg ctx "$additional_ctx" \
  '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'

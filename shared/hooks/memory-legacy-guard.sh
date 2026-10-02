#!/usr/bin/env bash
# PreToolUse guard: l'auto-memory di Claude Code è CONGELATA.
#
# La memoria canonica è il brain (brain_*) — vedi
# shared/rules/memory-brain.md. Questo hook intercetta i tentativi di
# scrivere nuovi fatti nell'auto-memory legacy
# (<config>/projects/<slug>/memory/...) e le BLOCCA (deny), spingendo a
# scrivere nel brain. Per manutenzione legittima dei file legacy (es.
# cancellarli) disabilita temporaneamente il matcher Write|Edit in
# settings.json o commenta questo hook.
#
# Scatta su Write|Edit (matcher in settings.json). Scoping stretto: solo path
# dentro una config Claude (.claude-multi/<profilo>/ o .claude/) sotto
# projects/*/memory/ → NON tocca 'memory/' di repo utente arbitrari.
#
# Robustezza: exit 0 SEMPRE; su errore di parsing fall-through al flusso
# permessi normale (nessuna decisione) invece di bloccare la sessione.

set -uo pipefail
trap 'exit 0' EXIT

INPUT=$(cat 2>/dev/null) || exit 0

# file_path del target (Write/Edit lo espongono in tool_input.file_path)
FP=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
[ -z "$FP" ] && exit 0

# Solo auto-memory di una config Claude: .claude-multi/<profilo>/projects/*/memory/
# oppure .claude/projects/*/memory/ (setup standard). Niente falsi positivi su repo utente.
if printf '%s' "$FP" | grep -Eq '(\.claude-multi/[^/]+|\.claude)/projects/[^/]+/memory/'; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Auto-memory CONGELATA/OFF (shared/rules/memory-brain.md): scrittura BLOCCATA. La memoria è il brain: scrivi il fatto lì con gli strumenti brain_* (diario, pagina del progetto, persone, note), rispettando il paletto NDA; un fatto di un solo repo va nel suo CLAUDE.md. Per manutenzione dei file legacy disabilita temporaneamente questo hook."
    }
  }' 2>/dev/null
  exit 0
fi

exit 0

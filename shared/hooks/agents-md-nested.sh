#!/usr/bin/env bash
# PreToolUse(Read|Edit|Write) — agents-md-nested: carica in contesto l'AGENTS.md
# della cartella in cui stai per operare, la prima volta che ci entri.
#
# Perché esiste: la discovery nativa del root AGENTS.md è confermata (test empirico
# 2026-09-03, Claude Code 2.1.258: sessione con solo AGENTS.md → contenuto letto).
# Quella NESTED invece non si è attivata in nessuna delle due varianti provate
# (né AGENTS.md né CLAUDE.md di sottocartella, in print mode) → non è una base su
# cui costruire uno standard. Questo hook la rende deterministica, e in più vale
# per subagent e print mode.
#
# Lazy per design: inietta solo la cartella toccata, una volta per sessione, così
# venti mappe non diventano migliaia di token morti.
#
# NON blocca mai. Parte dello standard repository (wiki: skills/repo-standard).
set -uo pipefail
trap 'exit 0' EXIT

INPUT=$(cat 2>/dev/null) || exit 0

FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || exit 0
[ -n "$FILE" ] || exit 0

SESSION=$(printf '%s' "$INPUT" | jq -r '.session_id // "nosession"' 2>/dev/null)
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null); CWD="${CWD:-$PWD}"

DIR=$(dirname "$FILE")
[ -d "$DIR" ] || exit 0

# Radice oltre cui non risalire: il progetto (il suo AGENTS.md è già nativo).
ROOT="${CLAUDE_PROJECT_DIR:-}"
[ -z "$ROOT" ] && ROOT=$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null)
[ -z "$ROOT" ] && ROOT="$CWD"
ROOT=$(cd "$ROOT" 2>/dev/null && pwd -P) || exit 0
DIR=$(cd "$DIR" 2>/dev/null && pwd -P) || exit 0

# il file deve stare dentro la radice
case "$DIR/" in "$ROOT"/*) ;; *) exit 0 ;; esac

# AGENTS.md più vicino, risalendo ma SENZA arrivare alla radice
FOUND=""
D="$DIR"
while [ "$D" != "$ROOT" ] && [ "$D" != "/" ]; do
  if [ -f "$D/AGENTS.md" ]; then FOUND="$D/AGENTS.md"; break; fi
  D=$(dirname "$D")
done
[ -n "$FOUND" ] || exit 0

# già iniettato in questa sessione?
STATE_DIR="${XDG_RUNTIME_DIR:-/tmp}/claude-agents-md/$SESSION"
KEY=$(printf '%s' "$FOUND" | md5sum | cut -d' ' -f1)
[ -f "$STATE_DIR/$KEY" ] && exit 0
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

# cap di sicurezza: un AGENTS.md sproporzionato è un bug di quel repo, non un
# motivo per allagare il contesto
BYTES=$(wc -c < "$FOUND" 2>/dev/null || echo 0)
if [ "$BYTES" -gt 12000 ]; then
  : > "$STATE_DIR/$KEY"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"AGENTS.md nested in %s è %s byte (>12k): non iniettato. Leggilo tu se serve, e valuta di accorciarlo — deve contenere solo ciò che non invecchia a ogni commit."}}\n' \
    "${FOUND#$ROOT/}" "$BYTES"
  exit 0
fi

: > "$STATE_DIR/$KEY"

BODY=$(cat "$FOUND")
REL="${FOUND#$ROOT/}"

jq -cn --arg rel "$REL" --arg body "$BODY" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:("ISTRUZIONI DI CARTELLA — " + $rel + " (caricate perché stai operando in quella cartella; valgono sopra le convenzioni di root per i file che contiene):\n\n" + $body)}}' \
  2>/dev/null || exit 0

exit 0

#!/usr/bin/env bash
# SessionStart hook: dove guardare nel brain per la cartella in cui parte la sessione.
#
# Il brain tiene una pagina per progetto in progetti/, con lo stesso percorso della cartella sotto
# ~ (~/work/acme/site → progetti/work/acme/site). L'hook non va in rete e non ha token: dice a
# Claude quale cartella del brain guardare e lo fa leggere a lui, con i suoi strumenti. La regola
# completa è shared/rules/memory-brain.md.
#
# Robustezza: exit 0 SEMPRE; senza jq o fuori da ~ non dice niente.

set -uo pipefail
trap 'exit 0' EXIT
command -v jq >/dev/null || exit 0

dir="${CLAUDE_PROJECT_DIR:-$PWD}"
case "$dir" in
  "$HOME"/*) rel="${dir#"$HOME"/}" ;;
  *) exit 0 ;;
esac
# le cartelle di sistema e di configurazione non sono progetti
case "$rel" in
  .*|downloads*|Downloads*|vault*|brains*) exit 0 ;;
esac
rel=$(printf '%s' "$rel" | tr '[:upper:]' '[:lower:]')

ctx="Brain: questa cartella è ~/${rel}. La pagina del progetto sta in progetti/ con lo stesso percorso, o un livello sopra se questa è la repo dentro la cartella del cliente: guarda con brain_list (folder progetti/${rel%/*}) e leggila con brain_read prima di lavorare; le sue task con tasks_list (project). Se la pagina non c'è, proponi /brain-init a Samuel. Mentre lavori scrivi il giusto (shared/rules/memory-brain.md): una riga di diario per ciò che conta, la pagina quando cambia lo stato, le task per ciò che resta aperto."

jq -n --arg ctx "$ctx" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'

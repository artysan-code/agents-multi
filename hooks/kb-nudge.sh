#!/usr/bin/env bash
# SessionStart hook: nudge verso la Knowledge Base operativa (R7).
# Ricorda che ~/brains/claude/ esiste e come interrogarla; nomina il brief del
# progetto corrente se presente. No-op se il vault non esiste (safe pre-seed).
# Convive con serena-bootstrap.sh (entrambi SessionStart, emit indipendenti).

set -uo pipefail

VAULT="$HOME/brains/claude"
[ -d "$VAULT" ] || exit 0   # no-op finché il vault non è seminato

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
project_name=$(basename "$PROJECT_DIR")

ctx='Knowledge base operativa in ~/brains/claude/ (livello R7). Per domande su Samuel, brief dei progetti, playbook, o "quando usare quale agente/skill NON caricato", interroga la KB (skill wiki-query con vault ~/brains/claude, oppure leggi index.md) invece di indovinare o pre-caricare. Catalogo lean: references/ecc-agents-catalog, references/ecc-skills-catalog, references/anthropic-plugins-catalog.'

# Brief del progetto corrente? match esatto o per primo segmento del nome.
brief=$(ls "$VAULT"/projects/*/"$project_name".md 2>/dev/null | head -1 || true)
if [ -z "$brief" ]; then
  seg=${project_name%%-*}
  brief=$(find "$VAULT/projects" -maxdepth 2 -name '*.md' 2>/dev/null | grep -iE "/${seg}[^/]*\.md$" | head -1 || true)
fi
if [ -n "$brief" ] && [ -f "$brief" ]; then
  rel=${brief#"$VAULT/"}
  ctx="$ctx Brief del progetto corrente in KB: [[${rel%.md}]]."
fi

jq -n --arg ctx "$ctx" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'

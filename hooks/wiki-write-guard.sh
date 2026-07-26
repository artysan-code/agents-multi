#!/usr/bin/env bash
# PreToolUse guard per l'MCP della memoria-wiki (wiki-claude / obsidian-brain).
#
# obsidian-brain espone tool di scrittura SENZA ACL nativo né conferma → questo
# hook è la rete di sicurezza che onora il governance loop della LLM-Wiki
# ("la memoria-wiki NON auto-promuove né auto-cancella"):
#   - READ + manutenzione index   -> allow  (retrieval senza attriti)
#   - delete_note                  -> deny   (perdita irreversibile: si fa a mano in Obsidian)
#   - altre mutazioni / sconosciuti -> ask   (conferma umana esplicita)
#
# Il matcher in settings.json (mcp__wiki.claude__.*) fa sì che questo hook scatti
# SOLO sui tool di wiki-claude → inerte in profili senza quell'MCP (es. work).
#
# Robustezza: exit 0 SEMPRE; su qualsiasi errore di parsing non emette decisione
# (fall-through al flusso permessi normale) invece di bloccare la sessione.

set -uo pipefail
trap 'exit 0' EXIT

INPUT=$(cat 2>/dev/null) || exit 0
TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
[ -z "$TOOL" ] && exit 0

# Nome bare del tool: tutto ciò che segue l'ultimo "__"
# (es. mcp__wiki_claude__delete_note -> delete_note)
BARE=${TOOL##*__}

emit() { # $1=allow|deny|ask  $2=reason
  jq -n --arg d "$1" --arg r "$2" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}' 2>/dev/null
  exit 0
}

case "$BARE" in
  search|list_notes|read_note|find_connections|find_path_between|detect_themes|\
  rank_notes|active_note|dataview_query|base_query|index_status|reindex)
    emit allow "read/index op sulla memoria-wiki (non modifica le note)"
    ;;
  delete_note)
    emit deny "delete_note bloccato: la memoria-wiki non si auto-cancella. Se serve davvero, cancella la nota a mano in Obsidian."
    ;;
  create_note|edit_note|apply_edit_preview|link_notes|move_note)
    emit ask "Mutazione della memoria-wiki ($BARE): conferma esplicita richiesta (governance: niente write non sorvegliati)."
    ;;
  *)
    emit ask "Tool wiki-claude non riconosciuto ($BARE): conferma cautelativa."
    ;;
esac

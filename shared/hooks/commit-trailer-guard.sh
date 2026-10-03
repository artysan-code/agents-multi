#!/usr/bin/env bash
# PreToolUse(Bash) — commit-trailer-guard: BLOCCA i `git commit` il cui messaggio
# contiene una firma/attribuzione dell'assistente.
#
# Per chi la sceglie: nessun trailer di attribuzione dell'assistente nei commit, in nessuna repo.
# Il default di fabbrica dell'harness è di aggiungerli: questo hook è la garanzia
# che non dipenda dal ricordarselo.
#
# BLOCCA (exit 2): lo stderr torna all'agente, che deve riscrivere il messaggio.
# Copre `commit`, `commit --amend`, `merge -m`, `tag -m`, `revert`.
# Policy-neutral (entrambi i profili). Parte dello standard repository
# (wiki: skills/repo-standard).
set -uo pipefail

# Opt-in: a preference of the person, not of the setup. Their config/settings.json turns it on with
#   "env": { "CLAUDE_MULTI_NO_ASSISTANT_TRAILER": "1" }
[ "${CLAUDE_MULTI_NO_ASSISTANT_TRAILER:-}" = "1" ] || exit 0

INPUT=$(cat 2>/dev/null) || exit 0
[ "$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)" = "Bash" ] || exit 0
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0

# interessa solo ciò che scrive un messaggio di commit
printf '%s' "$CMD" | grep -qiE 'git[[:space:]]+([a-z-]+[[:space:]]+)*(commit|merge|revert|tag)\b' || exit 0

# Firme note. `-i` perché la capitalizzazione del trailer varia.
PATTERN='co-authored-by:[[:space:]]*claude|generated[[:space:]]+with[[:space:]]+\[?claude[[:space:]]+code|noreply@anthropic\.com|🤖[[:space:]]*generated'

if printf '%s' "$CMD" | grep -qiE "$PATTERN"; then
  cat >&2 <<'EOF'
BLOCCATO — commit-trailer-guard.

Il messaggio di commit contiene una firma dell'assistente (Co-Authored-By: Claude,
"Generated with Claude Code", noreply@anthropic.com o simili).

Regola esplicita del proprietario: quelle righe non entrano MAI nei commit, in nessuna repo.

Riscrivi il messaggio senza il trailer e ripeti il comando. Non aggirare l'hook
(niente file temporanei con -F, niente git -c core.hooksPath): la regola vale
comunque, non è il meccanismo a essere in discussione.
EOF
  exit 2
fi

exit 0

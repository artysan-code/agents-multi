#!/usr/bin/env bash
# PreToolUse(Bash) — destructive-blocker: rete di sicurezza sui comandi shell distruttivi.
# Default ALLOW (exit 0). Solo pattern chiaramente pericolosi -> ask; catastrofici -> deny.
# Policy-neutral: attivo su ENTRAMBI i profili (la sicurezza vale ovunque).
# Conservativo di proposito: meglio pochi falsi positivi che un hook che disabiliti.
set -uo pipefail
trap 'exit 0' EXIT

INPUT=$(cat 2>/dev/null) || exit 0
[ "$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)" = "Bash" ] || exit 0
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -z "$CMD" ] && exit 0

emit() { jq -n --arg d "$1" --arg r "$2" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}' 2>/dev/null; exit 0; }
has()  { printf '%s' "$CMD" | grep -qiE "$1"; }
hasF() { printf '%s' "$CMD" | grep -qF "$1"; }

# ---- CATASTROFICI -> deny ----
if has '\bmkfs(\.|[[:space:]])' || has '(>|of=)[[:space:]]*/dev/(sd|nvme|vd|mmcblk)' || hasF ':(){'; then
  emit deny "Comando catastrofico (format disco / scrittura raw su block device / fork bomb): BLOCCATO. Se è davvero intenzionale, eseguilo a mano fuori dall'agente."
fi

# ---- rm ricorsivo su radice/path di sistema/wildcard -> ask (i subpath nominati passano) ----
if has 'rm[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*(~|/\*|\$HOME|\.\.|~|\.|\*|/)([[:space:]]|$)' \
   || has 'rm[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*/(etc|usr|bin|sbin|var|boot|lib|lib64|opt|sys|proc|root|dev|home)([[:space:]/]|$)'; then
  emit ask "rm su radice / path di sistema / wildcard / '.' / '~' / '\$HOME'. Verifica BENE il percorso: è una cancellazione potenzialmente irreversibile e ampia."
fi

# ---- altri pericolosi -> ask ----
has 'git[[:space:]]+push[[:space:]].*(--force([[:space:]]|=|$)|[[:space:]]-f([[:space:]]|$))' && \
  emit ask "git push --force: riscrive la history remota. Conferma e verifica il branch di destinazione."
has 'git[[:space:]]+reset[[:space:]]+--hard' && \
  emit ask "git reset --hard: perdi modifiche/commit non salvati altrove. Conferma."
has 'git[[:space:]]+clean[[:space:]]+-[a-z]*[fdx]' && \
  emit ask "git clean -f/-d/-x: rimuove file untracked in modo irreversibile. Conferma."
has '\bdd[[:space:]].*[[:space:]]of=' && \
  emit ask "dd con of=: scrittura raw potenzialmente distruttiva. Verifica la destinazione."
has '(chmod|chown)[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*(-R|--recursive)' && \
  emit ask "chmod/chown ricorsivo: cambia permessi/owner di un intero albero. Verifica il path."
has '(curl|wget)[[:space:]].*\|[[:space:]]*(sudo[[:space:]]+)?(sh|bash|zsh)([[:space:]]|$)' && \
  emit ask "pipe-to-shell (curl/wget | sh): esegue codice remoto non verificato. Conferma la fonte (governance: solo fonti fidate)."

exit 0

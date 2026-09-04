#!/usr/bin/env bash
# PreToolUse(Bash) — branch-guard: chiede conferma se stai per PUSHARE dal branch
# di DEFAULT (main/master/...). Allineato alla regola "se sei sul default, fai prima
# un branch". Default ALLOW. Policy-neutral (entrambi i profili).
#
# Il commit non è più gancio: è locale e si annulla con un reset. Il push è l'atto
# che esce dalla macchina, ed è lì che la conferma serve davvero.
set -uo pipefail
trap 'exit 0' EXIT

INPUT=$(cat 2>/dev/null) || exit 0
[ "$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)" = "Bash" ] || exit 0
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null); CWD="${CWD:-$PWD}"

# interessa solo: git push
printf '%s' "$CMD" | grep -qiE 'git[[:space:]]+push' || exit 0

# branch corrente (se non è un repo git -> allow silenzioso)
BR=$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0

# default branch REALE del repo: prima il remoto (origin/HEAD), poi init.defaultBranch
DEF=$(git -C "$CWD" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null); DEF=${DEF#origin/}
[ -z "$DEF" ] && DEF=$(git -C "$CWD" config init.defaultBranch 2>/dev/null)

# protetto se: è il default rilevato, oppure un nome-di-default comune (incl. 'release', tua convenzione)
protected=0
[ -n "$DEF" ] && [ "$BR" = "$DEF" ] && protected=1
case "$BR" in main|master|develop|production|prod|trunk|release) protected=1 ;; esac
[ "$protected" -eq 1 ] || exit 0

jq -n --arg b "$BR" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",
    permissionDecisionReason:("BRANCH-GUARD — push dal branch di default \"" + $b + "\". Policy: se sei sul default, fai prima un branch dedicato. Conferma solo se è davvero voluto (es. hotfix concordato).")}}' 2>/dev/null
exit 0

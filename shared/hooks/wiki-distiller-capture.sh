#!/usr/bin/env bash
# Stop hook — APPROCCIO A, parte "cattura". Zero GPU, zero rete.
# Estrae il transcript della sessione, scrubba i segreti, e lo ACCODA in una
# coda XDG NON sincronizzata (~/.local/share/claude-distill-queue/).
# La distillazione LLM (GPU) avviene DOPO e a parte: wiki-distiller-run.py.
#
# Invarianti rispetto agli altri hook:
#   - exit 0 SEMPRE (mai bloccare il turno).
#   - gating cwd DEFAULT-DENY: gira solo su domini personal/meta noti;
#     qualunque altro path (incluso ~/work/**) => no-op immediato.
#   - opt-out: file .claude-no-distill nella cwd => no-op.
#   - il raw NON entra mai nel vault sincronizzato (resta in coda XDG).
set -uo pipefail

# defer a override repo-local se presente (convenzione degli altri hook)
if [ -f "${CLAUDE_PROJECT_DIR:-$PWD}/.claude/hooks/wiki-distiller-capture.sh" ]; then
  exec bash "${CLAUDE_PROJECT_DIR:-$PWD}/.claude/hooks/wiki-distiller-capture.sh"
fi

INPUT=$(cat)

# un solo parse: estrai i 3 campi che servono
fields=$(printf '%s' "$INPUT" | python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: d={}
print('\t'.join([str(d.get('cwd','')), str(d.get('transcript_path','')), str(d.get('session_id',''))]))" 2>/dev/null) || exit 0
IFS=$'\t' read -r CWD TRANSCRIPT SESSION_ID <<<"$fields"
CWD="${CWD:-$PWD}"

# sovranità: MAI catturare sotto il profilo work (il client non entra nel vault personale)
case "${CLAUDE_CONFIG_DIR:-}" in
  */work|*/work/*) exit 0 ;;
esac

# opt-out
[ -f "$CWD/.claude-no-distill" ] && exit 0

# gating DEFAULT-DENY: allowlist personal/meta
case "$CWD" in
  "$HOME"|"$HOME/brains"|"$HOME/brains/"*|"$HOME/personal"|"$HOME/personal/"*|"$HOME/.claude-multi"|"$HOME/.claude-multi/"*) : ;;
  *) exit 0 ;;
esac

[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || exit 0

QUEUE="$HOME/.local/share/claude-distill-queue"
mkdir -p "$QUEUE" && chmod 700 "$QUEUE"

python3 "$(dirname "$0")/wiki-distiller-extract.py" "$TRANSCRIPT" "$CWD" "$SESSION_ID" "$QUEUE" >/dev/null 2>&1 || true
exit 0

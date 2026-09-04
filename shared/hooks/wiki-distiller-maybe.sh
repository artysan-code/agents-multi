#!/usr/bin/env bash
# SessionStart hook — drena la coda di distillazione (APPROCCIO A, hands-off).
# DETACHED: non blocca l'avvio sessione. GPU-guarded dentro run.py (rinvia se
# stai giocando). Solo profilo personal: la memoria personale si scrive solo
# da sessioni personali.
set -uo pipefail

# solo profilo personal
case "${CLAUDE_CONFIG_DIR:-}" in
  */personal|*/personal/*) : ;;
  *) exit 0 ;;
esac

Q="$HOME/.local/share/claude-distill-queue"
# niente da fare se la coda è vuota (check rapido, no GPU)
ls "$Q"/*.raw.md >/dev/null 2>&1 || exit 0

RUN="$HOME/.claude-multi/shared/hooks/wiki-distiller-run.py"
[ -f "$RUN" ] || exit 0

# lancia in background, sessione staccata: sopravvive al ritorno dell'hook,
# non ritarda l'avvio. La guard GPU + lock sono dentro run.py.
setsid bash -c "python3 '$RUN' >>'$Q/distill.log' 2>&1" </dev/null >/dev/null 2>&1 &
exit 0

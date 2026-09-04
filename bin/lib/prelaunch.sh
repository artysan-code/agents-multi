#!/usr/bin/env bash
# prelaunch.sh — allinea il repo claude-multi PRIMA che parta Claude, così la config
# nuova è già caricata e non serve mai riavviare. Chiamato dai wrapper `claude`,
# `claude-work` e da `claude-launch`. Non fallisce mai il lancio: ogni errore → exit 0.
#
# Regole:
#   - la rete si tocca solo se l'ultimo fetch è più vecchio di TTL (default 12h),
#     con timeout di 3s; offline → si va avanti con ciò che c'è
#   - pull SOLO fast-forward e SOLO a working tree pulito; altrimenti non tocca nulla
#   - push mai automatico
#   - stato in ~/.cache/claude-multi/sync.json → letto dalla statusline (segmento cfg)
#   - lock: due profili possono partire insieme
set -uo pipefail

REPO="${CLAUDE_MULTI_REPO:-$HOME/.local/src/claude-multi}"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/claude-multi"
STATE="$CACHE/sync.json"
STAMP="$CACHE/fetch.stamp"
LOCK="$CACHE/sync.lock"
TTL="${CLAUDE_MULTI_FETCH_TTL:-43200}"
FETCH_TIMEOUT="${CLAUDE_MULTI_FETCH_TIMEOUT:-3}"

g() { git -C "$REPO" "$@"; }

write_state() {
  # $1 behind $2 ahead $3 dirty $4 pulled $5 fetch_ok $6 upstream(0/1)
  local now; now=$(date +%s)
  local fetched_at=0
  [[ -f "$STAMP" ]] && fetched_at=$(stat -c %Y "$STAMP" 2>/dev/null || echo 0)
  printf '{"behind":%s,"ahead":%s,"dirty":%s,"pulled":%s,"fetch_ok":%s,"upstream":%s,"fetched_at":%s,"checked_at":%s,"repo":"%s"}\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$fetched_at" "$now" "$REPO" > "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"
}

main() {
  [[ -d "$REPO/.git" ]] || return 0
  mkdir -p "$CACHE"
  exec 9>"$LOCK"
  flock -n 9 || return 0

  if ! g rev-parse --abbrev-ref '@{u}' >/dev/null 2>&1; then
    write_state 0 0 0 0 true false
    return 0
  fi

  local fetch_ok=true age=$((TTL + 1))
  [[ -f "$STAMP" ]] && age=$(( $(date +%s) - $(stat -c %Y "$STAMP" 2>/dev/null || echo 0) ))
  if (( age > TTL )); then
    if timeout "$FETCH_TIMEOUT" git -C "$REPO" fetch -q origin 2>/dev/null; then
      touch "$STAMP"
    else
      fetch_ok=false
    fi
  fi

  local behind=0 ahead=0 dirty pulled=0
  # rev-list separa con un TAB: `read` splitta su qualsiasi whitespace
  read -r behind ahead <<< "$(g rev-list --left-right --count '@{u}...HEAD' 2>/dev/null || echo "0 0")"
  behind=${behind:-0}; ahead=${ahead:-0}
  dirty=$(g status --porcelain 2>/dev/null | wc -l)

  if (( behind > 0 && ahead == 0 && dirty == 0 )); then
    if g pull -q --ff-only 2>/dev/null; then
      pulled=$behind; behind=0
      echo "claude-multi: config aggiornata (+$pulled commit)" >&2
    fi
  fi

  write_state "$behind" "$ahead" "$dirty" "$pulled" "$fetch_ok" true
}

main 2>/dev/null || true
exit 0

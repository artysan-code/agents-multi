#!/usr/bin/env bash
# prelaunch.sh: aligns the agents-multi repo BEFORE Claude starts, so the new config is already
# loaded and no restart is ever needed. Called by the `claude` wrapper, the per-profile launchers
# and `claude-launch`. It never fails the launch: every error ends in exit 0.
#
# Rules:
#   - the network is touched only if the last fetch is older than TTL (default 12h), with a 3s
#     timeout; offline, it carries on with what is there
#   - pull is fast-forward ONLY and ONLY on a clean working tree; otherwise it touches nothing
#   - never pushes
#   - state goes to ~/.cache/claude-multi/sync.json, read by the statusline (cfg segment)
#   - locking: two profiles may start at the same time
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
  # $1 behind $2 ahead $3 dirty $4 pulled $5 fetch_ok $6 upstream (true/false)
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
  if (( age >= TTL )); then   # TTL=0 = "always fetch" (even within the same second as the stamp)
    if timeout "$FETCH_TIMEOUT" git -C "$REPO" fetch -q origin 2>/dev/null; then
      touch "$STAMP"
    else
      fetch_ok=false
    fi
  fi

  local behind=0 ahead=0 dirty pulled=0
  # rev-list separates with a TAB: `read` splits on any whitespace
  read -r behind ahead <<< "$(g rev-list --left-right --count '@{u}...HEAD' 2>/dev/null || echo "0 0")"
  behind=${behind:-0}; ahead=${ahead:-0}
  dirty=$(g status --porcelain 2>/dev/null | wc -l)

  if (( behind > 0 && ahead == 0 && dirty == 0 )); then
    if g pull -q --ff-only 2>/dev/null; then
      pulled=$behind; behind=0
      echo "agents-multi: config updated (+$pulled commits)" >&2
      # the console keeps in memory the code it started with: restart it if the pull changed that code
      if ! g diff --quiet ORIG_HEAD HEAD -- cli shared/mcp/lib 2>/dev/null; then
        systemctl --user try-restart claude-multi-console.service >/dev/null 2>&1 || true
      fi
    fi
  fi

  write_state "$behind" "$ahead" "$dirty" "$pulled" "$fetch_ok" true
}

# Every profile has a GENERATED settings.json (apps/cli/settings.ts): shared + profile patch + manifest.
# It is regenerated when a source is newer than the last generation: a pull, an edit in the repo,
# a plugin synced from the account, or Claude writing into the generated file (those writes are
# adopted into the profile patch). Requires Deno: without it, Claude starts with the file as last
# generated. Uses its own lock and never blocks.
regen_settings() {
  local runtime="${CLAUDE_MULTI_ROOT:-$HOME/.claude-multi}" stamp="$CACHE/settings.stamp"
  local config="${CLAUDE_MULTI_CONFIG:-$runtime/config}"
  [[ -x "$REPO/bin/claude-multi" ]] && command -v deno >/dev/null 2>&1 || return 0
  mkdir -p "$CACHE"
  exec 8>"$CACHE/settings.lock"
  flock -n 8 || return 0
  if [[ -f "$stamp" ]] && [[ -z "$(find "$REPO/shared/settings.json" "$REPO/shared/mcp/servers.json" "$config"/settings.json "$config"/profiles "$config"/servers.json "$config"/accounts.json \
        "$runtime"/*/settings.json "$runtime"/*/plugins/synced -newer "$stamp" -print -quit 2>/dev/null)" ]]; then
    return 0
  fi
  touch "$stamp.next"
  "$REPO/bin/claude-multi" settings --quiet && mv -f "$stamp.next" "$stamp"
}

# stderr stays open: the "config updated" line must reach the user; git calls already have their own 2>/dev/null
main || true
regen_settings || true
exit 0

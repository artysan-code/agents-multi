#!/usr/bin/env bash
# updates.sh — what the updaters share: the log every update result lands in, the one desktop
# notification they may raise, and the question "is any Claude Desktop running?".
#
# The log is JSON lines in $CM_UPDATE_LOG (~/.local/state/claude-multi/updates.jsonl): the console's
# Updates tab and the doctor read it. Events: installed (cli), staged / applied (desktop),
# rollback, waiting (desktop staged while an instance runs), failed, verify-failed.

CM_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/claude-multi"
CM_UPDATE_LOG="${CM_UPDATE_LOG:-$CM_STATE_DIR/updates.jsonl}"
CM_DESKTOP_ROOT="${CLAUDE_DESKTOP_ROOT:-$HOME/.local/lib/claude-desktop}"

# cm_json_str <text> → the text as a JSON string (quotes, backslashes, control characters escaped)
cm_json_str() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/ }"; s="${s//$'\r'/ }"; s="${s//$'\t'/ }"
  printf '"%s"' "$s"
}

# cm_update_log <component> <event> <from> <to> [detail]
cm_update_log() {
  mkdir -p "$(dirname "$CM_UPDATE_LOG")"
  printf '{"at":"%s","component":%s,"event":%s,"from":%s,"to":%s,"detail":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(cm_json_str "$1")" "$(cm_json_str "$2")" \
    "$(cm_json_str "$3")" "$(cm_json_str "$4")" "$(cm_json_str "${5:-}")" >> "$CM_UPDATE_LOG"
}

# cm_notify <title> <body> — never critical: on KDE a critical notification ignores its expiry.
cm_notify() {
  command -v notify-send >/dev/null 2>&1 || return 0
  notify-send -a claude-multi -i claude-desktop -u normal --expire-time=8000 "$1" "$2" 2>/dev/null || true
}

# cm_desktop_running → true when any Claude Desktop runs: the default build (user space or, before
# the migration, the system package) or a profile's variant. Installing under a running instance
# makes it crash at its next lazy load, so every switch waits for this to be false.
cm_desktop_running() {
  # tests pin the answer: they run next to a real session and must not depend on it
  if [[ -n "${CM_DESKTOP_RUNNING:-}" ]]; then [[ "$CM_DESKTOP_RUNNING" == 1 ]]; return; fi
  local exe
  for exe in /proc/[0-9]*/exe; do
    exe="$(readlink "$exe" 2>/dev/null)" || continue
    case "$exe" in
      "$CM_DESKTOP_ROOT"/versions/*/claude-desktop | /usr/lib/claude-desktop/claude-desktop | \
        "$HOME"/.local/lib/claude-desktop-*/claude-desktop-*) return 0 ;;
    esac
  done
  return 1
}

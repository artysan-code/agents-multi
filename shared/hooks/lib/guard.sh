# shellcheck shell=bash
# guard.sh — sourced by the PreToolUse guards in shared/hooks; not a hook itself.
#
#   source "$(dirname "$0")/lib/guard.sh"
#   guard_read                      # the payload, once, into GUARD_INPUT
#   guard_field .tool_name          # one field of the payload, empty when absent
#   guard_decide deny "<reason>"    # print the decision and exit 0
#
# jq parses the payload. Without jq a guard must not wave everything through: guard_field falls
# back to extracting the string field with sed, and guard_decide writes the JSON by hand.

GUARD_INPUT=""
if command -v jq >/dev/null 2>&1; then GUARD_JQ=1; else GUARD_JQ=0; fi

guard_read() { GUARD_INPUT=$(cat 2>/dev/null) || GUARD_INPUT=""; }

guard_field() {
  if [ "$GUARD_JQ" = 1 ]; then
    printf '%s' "$GUARD_INPUT" | jq -r "$1 // empty" 2>/dev/null
    return 0
  fi
  # The string value of the last "<key>" in the payload, unescaped. Precise enough for the
  # payload's flat fields; a number or an object comes back empty.
  printf '%s' "$GUARD_INPUT" | tr '\n' ' ' \
    | sed -nE "s/.*\"${1##*.}\"[[:space:]]*:[[:space:]]*\"(([^\"\\\\]|\\\\.)*)\".*/\1/p" \
    | head -n1 | sed -e 's/\\"/"/g' -e 's/\\n/ /g' -e 's/\\t/ /g' -e 's/\\\\/\\/g'
}

# guard_decide <allow|ask|deny> <reason>: the PreToolUse decision on stdout, then exit 0.
guard_decide() {
  if [ "$GUARD_JQ" = 1 ]; then
    jq -n --arg d "$1" --arg r "$2" \
      '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:$d,permissionDecisionReason:$r}}'
  else
    local r
    r=$(printf '%s' "$2" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\t' '  ')
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":"%s"}}\n' "$1" "$r"
  fi
  exit 0
}

#!/usr/bin/env bash
# PreToolUse(Read) — read-guard-global: denies a full Read of a large JS/TS file.
#
# Trigger: a .ts/.tsx/.js/... file of READ_GUARD_THRESHOLD lines or more (default 300), read
# without `offset`/`limit`, outside vendor and build directories. A whole large file costs tokens;
# grep finds the section and a partial Read takes only that. A repository's own read-guard.sh may
# run alongside: a repeated deny is harmless.
#
# A token saver, not a security guard: without jq it allows.
set -uo pipefail
trap 'exit 0' EXIT
# shellcheck source=lib/guard.sh
source "$(dirname "$0")/lib/guard.sh"
[ "$GUARD_JQ" = 1 ] || exit 0

THRESHOLD="${READ_GUARD_THRESHOLD:-300}"

guard_read
[ "$(guard_field .tool_name)" = "Read" ] || exit 0
file_path=$(guard_field .tool_input.file_path)
[ -n "$(guard_field .tool_input.limit)" ] || [ -n "$(guard_field .tool_input.offset)" ] && exit 0

case "$file_path" in
  *.ts | *.tsx | *.mts | *.cts | *.js | *.jsx | *.mjs | *.cjs) ;;
  *) exit 0 ;;
esac
case "$file_path" in
  */node_modules/* | */dist/* | */build/* | */.next/* | */out/* | */.git/* | */coverage/* | */.cache/* | */.turbo/*) exit 0 ;;
esac

[ -f "$file_path" ] || exit 0
lines=$(wc -l <"$file_path" 2>/dev/null || echo 0)
[ "$lines" -lt "$THRESHOLD" ] && exit 0

rel=${file_path#"${CLAUDE_PROJECT_DIR:-$PWD}/"}
guard_decide deny "READ GUARD: $rel has $lines lines (threshold $THRESHOLD). For a large file: (1) \`grep -n '<symbol|pattern>' $rel\` to find the section; (2) \`grep -rn '<symbol>(' <src>\` for its callers; (3) then Read with \`offset\` and \`limit\` on the lines you need."

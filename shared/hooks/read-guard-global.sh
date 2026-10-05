#!/usr/bin/env bash
# Global read-guard: blocks full reads of large TS/JS files.
#
# Trigger: Read tool on a .ts/.tsx file ≥ READ_GUARD_THRESHOLD lines (default 300),
# without `offset`/`limit` params, NOT in vendor/build directories.
#
# Rationale: Read full su file grandi brucia token; grep trova la sezione, Read
# con offset/limit legge solo quella.
#
# Coexists with repo-local read-guard.sh: deny è idempotente, il global cattura
# anche file fuori scope di un eventuale read-guard.sh repo-local (es. scripts/,
# packages/X/, root del repo, non solo apps/*/src/).
#
# Output: permissionDecision=deny + reason suggesting grep + partial Read.
# Files < threshold, non-TS, vendor dirs, partial reads → exit 0 (allow).

set -euo pipefail

THRESHOLD="${READ_GUARD_THRESHOLD:-300}"

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""')
[ "$tool" != "Read" ] && exit 0

file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')
limit=$(printf '%s' "$input" | jq -r '.tool_input.limit // empty')
offset=$(printf '%s' "$input" | jq -r '.tool_input.offset // empty')

# Already partial read → allow
[ -n "$limit" ] || [ -n "$offset" ] && exit 0

# Extension filter (TS/TSX/JS/JSX/MTS/CTS)
case "$file_path" in
  *.ts|*.tsx|*.mts|*.cts|*.js|*.jsx|*.mjs|*.cjs) ;;
  *) exit 0 ;;
esac

# Vendor/build/cache exclusion
case "$file_path" in
  */node_modules/*|*/dist/*|*/build/*|*/.next/*|*/out/*|*/.git/*|*/coverage/*|*/.cache/*|*/.turbo/*) exit 0 ;;
esac

# Must exist + count lines
[ -f "$file_path" ] || exit 0
lines=$(wc -l < "$file_path" 2>/dev/null || echo 0)
[ "$lines" -lt "$THRESHOLD" ] && exit 0

rel=${file_path#"${CLAUDE_PROJECT_DIR:-$PWD}/"}
reason="READ GUARD — $rel = $lines righe (≥$THRESHOLD). Per file grandi: \
(1) \`grep -n '<simbolo|pattern>' $rel\` per trovare la sezione; \
(2) \`grep -rn '<simbolo>(' <src>\` per chi lo chiama; \
(3) poi Read con \`offset\`+\`limit\` sulle sole righe che servono."

jq -n --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'

exit 0

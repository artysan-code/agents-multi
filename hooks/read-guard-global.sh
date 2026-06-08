#!/usr/bin/env bash
# Global read-guard: enforces Serena MCP for large TS/TSX files.
#
# Trigger: Read tool on a .ts/.tsx file ≥ READ_GUARD_THRESHOLD lines (default 300),
# without `offset`/`limit` params, NOT in vendor/build directories.
#
# Rationale: Read full su file grandi brucia token e ignora il LSP-based
# `find_symbol` / `get_symbols_overview` di Serena (~30× più efficienti per simboli TS).
#
# Coexists with repo-local read-guard.sh: deny è idempotente, il global cattura
# anche file fuori scope di un eventuale read-guard.sh repo-local (es. scripts/,
# packages/X/, root del repo, non solo apps/*/src/).
#
# Output: permissionDecision=deny + reason suggesting Serena alternative.
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
(1) \`mcp__serena__get_symbols_overview\` per scoprire i simboli del file; \
(2) \`mcp__serena__find_symbol\` con name_path per leggerne uno specifico; \
(3) \`mcp__serena__find_referencing_symbols\` per usage; \
(4) se DEVI leggere righe specifiche, riprova con Read + \`offset\`+\`limit\`. \
Bootstrap Serena: \`mcp__serena__activate_project\` se non già fatto in sessione."

jq -n --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'

exit 0

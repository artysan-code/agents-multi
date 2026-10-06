#!/usr/bin/env bash
# PostToolUse hook: typecheck after Edit on .ts/.tsx (R2)
# Non-blocking: always exits 0. Surfaces errors via stderr additionalContext.
# Repo-local override: if $CLAUDE_PROJECT_DIR/.claude/hooks/typecheck-after-edit.sh exists, exec it.

set -uo pipefail

# Defer to repo-local override
if [ -f "${CLAUDE_PROJECT_DIR:-$PWD}/.claude/hooks/typecheck-after-edit.sh" ]; then
  exec bash "${CLAUDE_PROJECT_DIR:-$PWD}/.claude/hooks/typecheck-after-edit.sh"
fi

# The global default is OPT-IN: it avoids 5-15s of lag after every Edit on a monorepo.
# Enable with: export CLAUDE_TYPECHECK=1
[ "${CLAUDE_TYPECHECK:-0}" = "1" ] || exit 0

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""')
[ "$tool" != "Edit" ] && exit 0

file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')
case "$file_path" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

[ -f "$file_path" ] || exit 0

# Walk up to find nearest package.json (max 8 levels)
pkg_dir=$(dirname "$file_path")
depth=0
while [ "$depth" -lt 8 ]; do
  [ -f "$pkg_dir/package.json" ] && break
  parent=$(dirname "$pkg_dir")
  [ "$parent" = "$pkg_dir" ] && break  # reached fs root
  pkg_dir="$parent"
  depth=$((depth + 1))
done

[ -f "$pkg_dir/package.json" ] || exit 0

# Check if pnpm is available (already in allowlist)
command -v pnpm >/dev/null 2>&1 || exit 0

# Try 'pnpm typecheck' first, fall back to 'pnpm tsc --noEmit'
typecheck_output=""
if pnpm -C "$pkg_dir" run typecheck --if-present 2>/dev/null | grep -q .; then
  typecheck_output=$(pnpm -C "$pkg_dir" run typecheck 2>&1 | grep -F "$file_path" | head -10 || true)
fi

if [ -z "$typecheck_output" ] && [ -f "$pkg_dir/tsconfig.json" ]; then
  typecheck_output=$(pnpm -C "$pkg_dir" tsc --noEmit 2>&1 | grep -F "$file_path" | head -10 || true)
fi

if [ -n "$typecheck_output" ]; then
  rel=${file_path#"${CLAUDE_PROJECT_DIR:-$PWD}/"}
  jq -n --arg ctx "TypeCheck errors in $rel:\n$typecheck_output" \
    '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}'
fi

exit 0

#!/usr/bin/env bash
# PreToolUse(Write|Edit) — memory-legacy-guard: Claude Code's auto-memory is frozen; memory is the
# brain (brain_* tools, shared/rules/memory-brain.md). Denies writes under projects/*/memory/ of a
# Claude configuration (.agents-multi/<profile>/, under its old name .claude-multi/<profile>/, or .claude/) and nowhere else, so a `memory/`
# folder in a user's repository is untouched. To maintain the legacy files, disable this hook's
# Write|Edit matcher in shared/settings.json for the time it takes.
set -uo pipefail
trap 'exit 0' EXIT
# shellcheck source=lib/guard.sh
source "$(dirname "$0")/lib/guard.sh"

guard_read
FP=$(guard_field .tool_input.file_path)
[ -z "$FP" ] && exit 0

if printf '%s' "$FP" | grep -Eq '(\.(agents|claude)-multi/[^/]+|\.claude)/projects/[^/]+/memory/'; then
  guard_decide deny "Auto-memory is frozen (shared/rules/memory-brain.md): write blocked. Memory is the brain: write the fact there with the brain_* tools (diary, the project's page, people, notes); a fact about one repository goes in its CLAUDE.md. To maintain the legacy files, disable this hook for the time it takes."
fi
exit 0

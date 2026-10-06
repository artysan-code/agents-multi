#!/usr/bin/env bash
# PreToolUse(Bash) — branch-guard: asks before a push from a default branch (main, master,
# release, ...), following the rule "on the default branch, make a branch first". Allows otherwise.
# Commits are not guarded: they stay local and a reset undoes them. The push is what leaves the
# machine, so that is where the confirmation belongs.
set -uo pipefail
trap 'exit 0' EXIT
# shellcheck source=lib/guard.sh
source "$(dirname "$0")/lib/guard.sh"

guard_read
[ "$(guard_field .tool_name)" = "Bash" ] || exit 0
CMD=$(guard_field .tool_input.command)
CWD=$(guard_field .cwd)
CWD="${CWD:-$PWD}"

printf '%s' "$CMD" | grep -qiE 'git[[:space:]]+push' || exit 0

# Not a git repository: nothing to guard.
BR=$(git -C "$CWD" rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0

# The repository's real default branch: the remote's HEAD first, then init.defaultBranch.
DEF=$(git -C "$CWD" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
DEF=${DEF#origin/}
[ -z "$DEF" ] && DEF=$(git -C "$CWD" config init.defaultBranch 2>/dev/null)

protected=0
[ -n "$DEF" ] && [ "$BR" = "$DEF" ] && protected=1
case "$BR" in main | master | develop | production | prod | trunk | release) protected=1 ;; esac
[ "$protected" -eq 1 ] || exit 0

guard_decide ask "BRANCH-GUARD: push from the default branch \"$BR\". The rule is to work on a dedicated branch; confirm only if this is intended (an agreed hotfix, a release)."

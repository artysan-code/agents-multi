#!/usr/bin/env bash
# PreToolUse(Bash) — destructive-blocker: a safety net under destructive shell commands.
# Allows by default. Clearly dangerous patterns ask; catastrophic ones are denied.
# Active on every profile. Deliberately narrow: a guard with many false positives gets disabled.
set -uo pipefail
trap 'exit 0' EXIT
# shellcheck source=lib/guard.sh
source "$(dirname "$0")/lib/guard.sh"

guard_read
[ "$(guard_field .tool_name)" = "Bash" ] || exit 0
CMD=$(guard_field .tool_input.command)
[ -z "$CMD" ] && exit 0

has() { printf '%s' "$CMD" | grep -qiE "$1"; }
hasF() { printf '%s' "$CMD" | grep -qF "$1"; }

# Catastrophic: deny.
if has '\bmkfs(\.|[[:space:]])' || has '(>|of=)[[:space:]]*/dev/(sd|nvme|vd|mmcblk)' || hasF ':(){'; then
  guard_decide deny "Catastrophic command (formatting a disk, raw write to a block device, fork bomb): blocked. If it is really intended, run it by hand outside the agent."
fi

# Recursive rm on a root, a system path, a wildcard, '.', '~' or the home folder: ask.
# Named subpaths pass. The home folder written out (whoever's it is) counts as ~ and $HOME.
HOME_RE=$(printf '%s' "$HOME" | sed 's/[][\.*^$()+?{}|]/\\&/g')
if has "rm[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*${HOME_RE}/?([[:space:]]|\$)" \
  || has 'rm[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*(/\*|\$HOME|\.\.|~|\.|\*|/)([[:space:]]|$)' \
  || has 'rm[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*/(etc|usr|bin|sbin|var|boot|lib|lib64|opt|sys|proc|root|dev|home)([[:space:]/]|$)'; then
  guard_decide ask "rm on a root, a system path, a wildcard, '.', '~' or \$HOME. Check the path carefully: this deletion is broad and possibly irreversible."
fi

# Other dangerous commands: ask.
has 'git[[:space:]]+push[[:space:]].*(--force([[:space:]]|=|$)|[[:space:]]-f([[:space:]]|$))' \
  && guard_decide ask "git push --force rewrites the remote history. Confirm, and check the target branch."
has 'git[[:space:]]+reset[[:space:]]+--hard' \
  && guard_decide ask "git reset --hard discards changes and commits not saved elsewhere. Confirm."
has 'git[[:space:]]+clean[[:space:]]+-[a-z]*[fdx]' \
  && guard_decide ask "git clean -f/-d/-x removes untracked files irreversibly. Confirm."
has '\bdd[[:space:]].*[[:space:]]of=' \
  && guard_decide ask "dd with of= is a raw write that can destroy data. Check the target."
has '(chmod|chown)[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*(-R|--recursive)' \
  && guard_decide ask "Recursive chmod/chown changes the mode or owner of a whole tree. Check the path."
has '(curl|wget)[[:space:]].*\|[[:space:]]*(sudo[[:space:]]+)?(sh|bash|zsh)([[:space:]]|$)' \
  && guard_decide ask "Piping curl/wget into a shell runs unverified remote code. Confirm the source is trusted."

exit 0

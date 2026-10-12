#!/usr/bin/env bash
# PreToolUse(Bash) — branch-guard: a push is free unless it reaches production. It asks when a push
#
#   - targets a protected branch: the remote's default (origin/HEAD), main, master, release, production,
#     prod, trunk, develop — named in a refspec (`origin release`, `HEAD:release`, `refs/heads/main`) or,
#     with no refspec, the branch checked out (`git push` on release)
#   - pushes a stable version tag (vX.Y.Z: the tag that cuts a release in CI; v1.2.0-beta.3 is free),
#     or tags in bulk (--tags, --follow-tags), or everything (--all, --mirror)
#   - deletes or rewrites a remote ref (--delete, -d, `:branch`, `+branch`, --force*)
#   - skips the repository's hooks (--no-verify), which hold the gate
#
# and when a command cuts a stable version (`deno task ship stable`, `scripts/ship.ts stable`) or a
# version by hand (`deno task release`, which only `ship` should run); --dry-run passes. Pushes to work branches (dev,
# beta, feature branches) and their pre-release tags pass without a question. `git -C <dir>` and a
# preceding `cd <dir>` are followed to find the checked-out branch. Commits are not guarded: they stay
# local and a reset undoes them.
set -uo pipefail
trap 'exit 0' EXIT
# shellcheck source=lib/guard.sh
source "$(dirname "$0")/lib/guard.sh"

guard_read
[ "$(guard_field .tool_name)" = "Bash" ] || exit 0
CMD=$(guard_field .tool_input.command)
CWD=$(guard_field .cwd)
CWD="${CWD:-$PWD}"

ask() { guard_decide ask "BRANCH-GUARD: $1 This reaches production: confirm only if it is intended (an agreed release or hotfix)."; }

# Releases cut outside git push: ship pushes from inside Deno, where no hook sees it. --dry-run passes.
if ! printf '%s' "$CMD" | grep -qE -- '--dry-run'; then
  printf '%s' "$CMD" | grep -qE '(deno[[:space:]]+task[[:space:]]+ship|scripts/ship\.ts)[[:space:]]+(.*[[:space:]])?stable' \
    && ask "a stable version (ship stable) moves release, tags and publishes it."
  printf '%s' "$CMD" | grep -qE 'deno[[:space:]]+task[[:space:]]+release([[:space:]]|$)' \
    && ask "a version cut by hand (deno task release); versions go out with deno task ship."
fi

printf '%s' "$CMD" | grep -qE '(^|[^[:alnum:]_-])git[[:space:]].*push' || exit 0

STATIC='main master release production prod trunk develop'
protected_branch() { # <name>
  local b=${1#refs/heads/} def
  for p in $STATIC; do [ "$b" = "$p" ] && return 0; done
  def=$(git -C "$DIR" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
  [ -n "$def" ] && [ "$b" = "${def#origin/}" ]
}
current_branch() { git -C "$DIR" rev-parse --abbrev-ref HEAD 2>/dev/null; }

# check_push <word>...: the words after `push`.
check_push() {
  local w refs=() remote="" dst src
  for w in "$@"; do
    case "$w" in
      --no-verify) ask "a push with --no-verify skips the gate in the pre-push hook." ;;
      --delete | -d) ask "a push that deletes a remote ref." ;;
      --force* | -f) ask "a forced push rewrites the remote history." ;;
      --tags | --follow-tags) ask "a push of every local tag can carry a stable version tag." ;;
      --all | --branches | --mirror) ask "a push of every branch includes the protected ones." ;;
      --repo=* | --push-option=* | -o | --receive-pack=* | --exec=*) ;;
      -*) ;;
      *) if [ -z "$remote" ]; then remote=$w; else refs+=("$w"); fi ;;
    esac
  done
  if [ ${#refs[@]} -eq 0 ]; then
    w=$(current_branch) || return 0
    protected_branch "$w" && ask "a push of the checked-out branch \"$w\", which is protected."
    return 0
  fi
  for w in "${refs[@]}"; do
    case "$w" in +*) ask "a forced refspec ($w) rewrites the remote history." ;; :*) ask "a refspec with no source ($w) deletes a remote ref." ;; esac
    src=${w%%:*}
    dst=${w#*:}
    [ "$src" = HEAD ] && [ "$dst" = HEAD ] && dst=$(current_branch)
    dst=${dst#refs/heads/}
    if printf '%s' "${dst#refs/tags/}" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
      ask "the stable version tag $dst starts a release in CI."
    fi
    protected_branch "$dst" && ask "a push to the protected branch \"$dst\"."
  done
}

# Each simple command of the line, in order; `cd <dir>` moves the directory for the ones after it.
DIR=$CWD
while IFS= read -r seg; do
  read -ra words <<<"$seg"
  [ ${#words[@]} -gt 0 ] || continue
  if [ "${words[0]}" = cd ] && [ -n "${words[1]:-}" ]; then
    case "${words[1]}" in /*) DIR=${words[1]} ;; "~"*) DIR=$HOME${words[1]#\~} ;; *) DIR=$DIR/${words[1]} ;; esac
    continue
  fi
  i=0
  while [ $i -lt ${#words[@]} ] && [ "${words[$i]}" != git ]; do i=$((i + 1)); done
  [ $i -lt ${#words[@]} ] || continue
  i=$((i + 1))
  segdir=$DIR
  while [ $i -lt ${#words[@]} ]; do # git's own options, before the subcommand
    case "${words[$i]}" in
      -C)
        case "${words[$((i + 1))]:-}" in /*) segdir=${words[$((i + 1))]} ;; *) segdir=$DIR/${words[$((i + 1))]:-} ;; esac
        i=$((i + 2))
        ;;
      -c | --git-dir | --work-tree | --namespace) i=$((i + 2)) ;;
      -*) i=$((i + 1)) ;;
      *) break ;;
    esac
  done
  [ "${words[$i]:-}" = push ] || continue
  DIR_SAVED=$DIR DIR=$segdir
  check_push "${words[@]:$((i + 1))}"
  DIR=$DIR_SAVED
done < <(printf '%s\n' "$CMD" | sed -E 's/(&&|\|\||[;|&])/\n/g' | tr -d "\"'")

exit 0

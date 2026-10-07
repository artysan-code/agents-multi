#!/usr/bin/env bash
# SessionStart hook: tells Claude where to look in the brain for the folder the session starts in.
#
# The brain keeps one page per project under progetti/, with the same path as the folder under ~
# (~/work/acme/site -> progetti/work/acme/site). The hook makes no network calls and holds no
# token: it only names the brain folder to check and lets Claude read it with its own tools.
# Output: hookSpecificOutput.additionalContext JSON on stdout. The full rule is in
# shared/rules/memory-brain.md.
#
# Robustness: always exit 0; without jq or outside ~ it says nothing.

set -uo pipefail
trap 'exit 0' EXIT
command -v jq >/dev/null || exit 0

# a work profile (brainScope in its manifest) has no brain memory, on purpose: nothing to point at
# the config dir is <runtime>/<profile>, and the person's profiles are in <runtime>/config/profiles
cfg="${CLAUDE_CONFIG_DIR:-x}"; cfg="${cfg%/}"
manifest="${cfg%/*}/config/profiles/${cfg##*/}/profile.json"
[ -f "$manifest" ] && grep -q '"brainScope"' "$manifest" && exit 0

dir="${CLAUDE_PROJECT_DIR:-$PWD}"
case "$dir" in
  "$HOME"/*) rel="${dir#"$HOME"/}" ;;
  *) exit 0 ;;
esac
# system and config folders are not projects
case "$rel" in
  .*|downloads*|Downloads*|vault*|brains*) exit 0 ;;
esac
rel=$(printf '%s' "$rel" | tr '[:upper:]' '[:lower:]')

ctx="Brain: this folder is ~/${rel}. The project page lives in progetti/ with the same path, or one level up if this is the repo inside the client folder: look with brain_list (folder progetti/${rel%/*}) and read it with brain_read before working; its tasks with tasks_list (project). If the page does not exist, suggest /brain-init. While you work, write the right amount (shared/rules/memory-brain.md): a diary line for what matters, the page when state changes, tasks for what stays open."

jq -n --arg ctx "$ctx" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'

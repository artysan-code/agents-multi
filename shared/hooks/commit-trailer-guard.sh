#!/usr/bin/env bash
# PreToolUse(Bash) — commit-trailer-guard: blocks a `git commit` (also --amend, merge -m, tag -m,
# revert) whose message carries an assistant attribution trailer.
#
# Opt-in, a preference of the person rather than of the setup. Their config/settings.json turns
# it on with  "env": { "AGENTS_MULTI_NO_ASSISTANT_TRAILER": "1" }. The harness adds those
# trailers by default; this hook makes the preference independent of remembering it.
#
# Blocks with exit 2: stderr goes back to the agent, which rewrites the message.
set -uo pipefail

[ "${AGENTS_MULTI_NO_ASSISTANT_TRAILER:-${CLAUDE_MULTI_NO_ASSISTANT_TRAILER:-}}" = "1" ] || exit 0

# shellcheck source=lib/guard.sh
source "$(dirname "$0")/lib/guard.sh"
guard_read
[ "$(guard_field .tool_name)" = "Bash" ] || exit 0
CMD=$(guard_field .tool_input.command)

printf '%s' "$CMD" | grep -qiE 'git[[:space:]]+([a-z-]+[[:space:]]+)*(commit|merge|revert|tag)\b' || exit 0

# Known signatures; -i because the trailer's capitalisation varies.
PATTERN='co-authored-by:[[:space:]]*claude|generated[[:space:]]+with[[:space:]]+\[?claude[[:space:]]+code|noreply@anthropic\.com|🤖[[:space:]]*generated'

if printf '%s' "$CMD" | grep -qiE "$PATTERN"; then
  cat >&2 <<'EOF'
Blocked by commit-trailer-guard.

The commit message carries an assistant signature (Co-Authored-By: Claude, "Generated with
Claude Code", noreply@anthropic.com or similar). The owner's rule: those lines never enter a
commit, in any repository.

Rewrite the message without the trailer and run the command again. Do not work around the hook
(a temporary file with -F, git -c core.hooksPath): the rule holds regardless of the mechanism.
EOF
  exit 2
fi
exit 0

#!/usr/bin/env bash
# PreToolUse(Bash) — vault-guard: a session never runs shared/mcp/lib/launch.ts itself.
# launch.ts is how a server gets its account's secret: `headers` prints it (Claude Code's
# headersHelper reads it), `run` starts a command with it in the environment. Claude Code runs both
# on its own, outside the Bash tool; a session that ran them would get a vault secret into the
# conversation. Reading or editing the file stays allowed: only running it in either mode is denied.
# The deny rules on secret-tool, kwallet-query and ~/vault/claude-multi cover the other ways in
# (cli/doctor.ts checks this hook is registered, like it checks those rules).
set -uo pipefail
trap 'exit 0' EXIT

INPUT=$(cat 2>/dev/null) || exit 0
[ "$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)" = "Bash" ] || exit 0
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -z "$CMD" ] && exit 0

if printf '%s' "$CMD" | grep -qE "launch\.ts[\"']?[[:space:]]+[\"']?(headers|run)([\"'[:space:]]|$)"; then
  jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",
    permissionDecisionReason:"launch.ts hands out a vault secret (headers prints it, run puts it in a command'"'"'s environment): Claude Code runs it for the MCP servers, a session does not. To use a service'"'"'s CLI on the vault'"'"'s token: claude-multi vault run <service> -- <tool> …"}}'
fi
exit 0

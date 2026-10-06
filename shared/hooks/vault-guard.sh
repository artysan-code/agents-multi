#!/usr/bin/env bash
# PreToolUse(Bash) — vault-guard: a session never runs shared/mcp/lib/launch.ts itself.
# launch.ts is how a server gets its account's secret: `headers` prints it (Claude Code's
# headersHelper reads it), `run` starts a command with it in the environment. Claude Code runs both
# on its own, outside the Bash tool; a session that ran them would get a vault secret into the
# conversation. Reading or editing the file stays allowed: only running it in either mode is denied.
# The deny rules on secret-tool, kwallet-query and ~/vault/claude-multi cover the other ways in
# (apps/cli/doctor/checks/vault.ts checks this hook is registered, like it checks those rules).
set -uo pipefail
trap 'exit 0' EXIT
# shellcheck source=lib/guard.sh
source "$(dirname "$0")/lib/guard.sh"

guard_read
[ "$(guard_field .tool_name)" = "Bash" ] || exit 0
CMD=$(guard_field .tool_input.command)
[ -z "$CMD" ] && exit 0

# The quote class also takes a backslash: without jq the command is matched inside its JSON
# string, where a quote is written \".
Q="[\\\\\"']*"
if printf '%s' "$CMD" | grep -qE "launch\.ts${Q}[[:space:]]+${Q}(headers|run)([\\\\\"'[:space:]]|$)"; then
  guard_decide deny "launch.ts hands out a vault secret (headers prints it, run puts it in a command's environment): Claude Code runs it for the MCP servers, a session does not. To use a service's CLI on the vault's token: claude-multi vault run <service> -- <tool> …"
fi
exit 0

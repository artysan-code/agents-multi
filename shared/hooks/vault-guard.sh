#!/usr/bin/env bash
# PreToolUse(Bash) — vault-guard: a session never runs shared/mcp/lib/launch.ts or launch.sh itself.
# launch.ts is how a server gets its account's secret: `headers` prints it (Claude Code's
# headersHelper reads it), `env` prints the variables its server starts with (launch.sh reads them and
# execs the server). Claude Code runs both
# on its own, outside the Bash tool; a session that ran them would get a vault secret into the
# conversation. Reading or editing the files stays allowed: only running them is denied.
# The deny rules on secret-tool, kwallet-query and the vault folder (~/agents-multi-vault, before 1.2.1
# ~/vault/claude-multi) cover the other ways in
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
if guard_match "launch\.ts${Q}[[:space:]]+${Q}(headers|env)([\\\\\"'[:space:]]|$)"; then
  guard_decide deny "launch.ts hands out a vault secret (headers prints it, env prints the variables a server starts with): Claude Code runs it for the MCP servers, a session does not. To use a service's CLI on the vault's token: agents vault run <service> -- <tool> …"
fi
# launch.sh runs launch.ts and execs the command it is given, with the secret in its environment:
# `launch.sh <deno…> -- env … -- printenv` would print it. Running it (a `--` after its name) is denied;
# cat, grep, bash -n and git on the file are not.
if guard_match "launch\.sh${Q}[[:space:]]+[^|;&]*[[:space:]]--[[:space:]]"; then
  guard_decide deny "launch.sh starts an MCP server with a vault secret in its environment: Claude Code runs it, a session does not. To use a service's CLI on the vault's token: agents vault run <service> -- <tool> …"
fi
exit 0

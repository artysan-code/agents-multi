# 0007 — Codex as a second provider

- Status: accepted (step 1 of phase C; completed by the provider interface and MCP for Codex children, below)
- Date: 2026-10-14

## Context

The hub's children were Claude Code sessions only. Phase C of the simplification audit makes a
**provider** the unit: five things — its CLI is installed and updated, an optional desktop app, isolated
accounts, headless execution for the hub, usage-limit reading. Codex (OpenAI) is the second.

## Decision

1. **CLI.** `@openai/codex` at the version pinned in `shared/providers/codex.version`, installed with
   `npm install --prefix ~/.agents-multi/providers/codex` (not global, no root). `agents update --codex`
   installs or moves it to the pin; a plain `agents update` and `--auto` only touch it where it is
   already installed. A newer Codex arrives by moving the pin (a commit, a release) — nothing floats.
2. **Accounts.** A profile declares `"codex": true`; its `CODEX_HOME` is `<runtime>/<profile>/codex`,
   beside Claude's config dir. `agents codex <profile> [args]` runs the CLI with it; the login is the
   owner's: `agents codex <profile> login` (that is `CODEX_HOME=~/.agents-multi/<profile>/codex
   ~/.agents-multi/providers/codex/node_modules/.bin/codex login`). The doctor checks the CLI's version and
   that each declared account has a login — the file's presence only, never its content.
3. **Hub.** `startChild` takes a `provider` (`claude` default, `codex`); `Provider` in
   `shared/mcp/lib/providers.ts` is what differs — the program and the `exec` line of the child's script,
   its capabilities, its accounts and their limits (see _The provider interface_). A workflow step takes
   `provider` too (and `profile`, as always).
   Sending, reading state and stopping stay one code: a Codex child's process is
   `shared/mcp/agents/codex-driver.ts`, which reads the child's `in`, runs `codex exec --json` for the
   first turn and `codex exec resume <thread>` for each next, and writes `out.jsonl` in Claude's
   stream-json (`codexLines`). `agent_start` has an optional `provider`; `agents agent start … --provider
   codex`.
4. **Limits.** `readCodexLimits(codexHome)` reads the latest `rate_limits` (`primary`, `secondary`:
   `window` in minutes, `used_percent`, `resets_at`) from the account's session logs; `agents codex limits
   <profile>` prints it. Nothing else of the account is read. A free plan reports one window of 30 days
   (43200 minutes), not the 5 h and 7 d of a paid one: windows are named by their length, never assumed.

## Permissions: what differs from Claude

`codex exec` never waits on an approval, so a Codex child **never asks the owner**: there is no
request/question flow for it. The profile's mode picks the sandbox instead, conservatively:

| Claude mode (profile's `defaultMode`) | Codex sandbox                                                            |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `default` (every write is asked)      | `read-only`                                                              |
| `acceptEdits`, `auto`                 | `workspace-write` (project folder and temp; no network for its commands) |

`approval_policy="never"`, never `danger-full-access`. Other differences: a message sent during a turn
waits for the turn's end (Claude reads it between two steps); no `AskUserQuestion`, no "yes for the
session"; a workflow's team channel (`team_send`, Claude's `--mcp-config`) is not given to a Codex child;
cost is not reported (`cost_usd` stays 0). The provider's `capabilities` say all this to a coordinator
(`nativeQuestions`, `permissionRequests`, `costReported`: false for Codex).

## The provider interface (phase C)

`shared/mcp/lib/providers.ts` is the one shape: `name`, `capabilities`, `command` and `exec` (how the child's
process starts), `accounts(profiles)` and `limits(account, places)`. Sending to a child, reading its state
and stopping it are **not** the provider's: every child speaks the same files (`in`, `out.jsonl`,
`child.pid`), a Codex one through its driver, so those stay one code in `agents.ts`. `child.pid` was
`claude.pid`; a child started before the rename is read all the same.

- **Accounts** are derived from the profiles' manifests: a Claude account per profile, a Codex one where
  `"codex": true`. `agents limits` and the hub's `limits` tool list them. A project's default account is
  phase D's: nothing says yet where it is kept.
- **Limits**: `limits(account)` gives windows `{window: "5h"|"7d"|"30d"…, usedPercent, resetsAt, source, at}`,
  read the passive way — Claude's from the status line's snapshots (`<state>/live`), Codex's from its
  logs. The Claude login is still read in `apps/cli/live.ts` only, on the owner's request (its answer is a
  snapshot like the status line's, source `endpoint`). A window whose reset has passed is left out: no
  reading is unknown, not zero. `agents limits [--json]` and the hub's read-only `limits` tool.
- **MCP servers for a Codex child.** Codex has no `--mcp-config`; each turn gets the profile's launch
  config (`<runtime>/<profile>/mcp.json`, ADR 0006) as `-c mcp_servers.<name>…` overrides — nothing is
  written to Codex's `config.toml`. Entries behind the gateway (ADR 0008) get `bearer_token_env_var`: the
  driver's script reads the profile's token file into `AGENTS_MULTI_MCP_TOKEN` (a name with TOKEN in it, which
  Codex keeps out of its commands' environment), so the token is never in a file of the child, an argument or
  the meta. Stdio entries keep their command, arguments and environment. Left out: the hub (`agents`), remote
  servers with their own login (the brain's `https://…/mcp`, Lovable, Zapier: they need `codex mcp login`),
  and every server with no `_allow` tool.
- **What a Codex child may call** is the registry's `_allow` list of each server (`mcp-codex.json`, written
  beside `mcp.json` by `agents mcp sync`; `enabled_tools` plus `default_tools_approval_mode = "approve"`,
  without which `approval_policy = "never"` refuses every MCP call). A Claude child's writes ask the owner; a
  Codex child cannot ask, so it gets only what Claude would run unasked. The `tasks` entry lists its reads
  (`tasks_brief`, `tasks_get`, `tasks_list`); a person widens a server in their own `servers.json`.

## Desktop app (research only, no code)

OpenAI's Codex app is official on macOS (Feb 2026) and Windows (Mar 2026), and since July 2026 Codex is
in the ChatGPT desktop app. There is **no official Linux build**; the ChatGPT desktop app on Linux that
once left `~/.codex` here was a community repackaging and not a supported route. So the provider's
optional desktop leg is: macOS and Windows install the vendor's app; Linux uses the CLI (and the
console). The app shares `~/.codex`, not a profile's `CODEX_HOME`, so per-profile isolation applies to
the CLI and the hub, not to the desktop app. Sources: openai.com/index/codex-for-almost-everything,
developers.openai.com changelog for the Codex app (not re-verified here).

## Verified, and not

With a real login (free plan, 0.162.1): a child started through the hub, given the `tasks` server through
the gateway, called `tasks_list` and answered with the task's title — `thread.started`, `agent_message`,
`turn.completed`, the MCP call and the token-by-environment path are confirmed. Still on the stand-in
(`apps/cli/tests/fixtures/fake-codex.sh`) and the CLI's documented shape: `command_execution` events,
`turn.failed` and the resume flow. Cost is not reported by `codex exec --json`: left as it is.

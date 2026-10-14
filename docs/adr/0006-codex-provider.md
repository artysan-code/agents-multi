# 0006 — Codex as a second provider

- Status: accepted (step 1 of phase C)
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
   `shared/mcp/lib/agents.ts` is what differs — the program and the `exec` line of the child's script.
   Sending, reading state and stopping stay one code: a Codex child's process is
   `shared/mcp/agents/codex-driver.ts`, which reads the child's `in`, runs `codex exec --json` for the
   first turn and `codex exec resume <thread>` for each next, and writes `out.jsonl` in Claude's
   stream-json (`codexLines`). `agent_start` has an optional `provider`; `agents agent start … --provider
   codex`.
4. **Limits.** `readCodexLimits(codexHome)` reads the latest `rate_limits` (`primary` 5 h, `secondary`
   7 d: `window`, `used_percent`, `resets_at`) from the account's session logs; `agents codex limits
   <profile>` prints it. Nothing else of the account is read.

## Permissions: what differs from Claude

`codex exec` never waits on an approval, so a Codex child **never asks the owner**: there is no
request/question flow for it. The profile's mode picks the sandbox instead, conservatively:

| Claude mode (profile's `defaultMode`) | Codex sandbox                                                            |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `default` (every write is asked)      | `read-only`                                                              |
| `acceptEdits`, `auto`                 | `workspace-write` (project folder and temp; no network for its commands) |

`approval_policy="never"`, never `danger-full-access`. Other differences: a message sent during a turn
waits for the turn's end (Claude reads it between two steps); no `AskUserQuestion`, no "yes for the
session"; a workflow's team channel and MCP servers (`--mcp-config`) are not given to a Codex child —
MCP for Codex is its own `config.toml`, which this step does not manage; cost is not reported
(`cost_usd` stays 0).

## Desktop app (research only, no code)

OpenAI's Codex app is official on macOS (Feb 2026) and Windows (Mar 2026), and since July 2026 Codex is
in the ChatGPT desktop app. There is **no official Linux build**; the ChatGPT desktop app on Linux that
once left `~/.codex` here was a community repackaging and not a supported route. So the provider's
optional desktop leg is: macOS and Windows install the vendor's app; Linux uses the CLI (and the
console). The app shares `~/.codex`, not a profile's `CODEX_HOME`, so per-profile isolation applies to
the CLI and the hub, not to the desktop app. Sources: openai.com/index/codex-for-almost-everything,
developers.openai.com changelog for the Codex app (not re-verified here).

## Not verified

The event shapes were checked against `codex exec --json` 0.162.1 without a login (`thread.started`,
`turn.started`, `error`, `item.completed` of type `error`). `agent_message`, `command_execution`,
`turn.completed`, `turn.failed` and the resume flow follow the CLI's documented shape and the stand-in in
`apps/cli/tests/fixtures/fake-codex.sh`, and need a real login to be confirmed.

# 0006 — MCP servers are handed to Claude at launch

- Status: accepted
- Date: 2026-10-14

## Context

The MCP registry was copied into files that are not ours: each profile's `.claude.json` (`mcpServers`)
and Desktop's `claude_desktop_config.json`. A comparison then said whether the copy matched, so every
change of the input (a pinned version, a tool list, an account, a path of Deno, an app update) made the
doctor warn "MCP registry out of sync" until someone ran `agents mcp sync` — which refused to write while
a Claude was open, because Claude rewrites `.claude.json` (`oauthAccount`, state, history).

## Spike (Claude Code 2.1.299, profile `funnel`, `claude -p … --output-format stream-json --verbose`, the

`init` message lists each server with its status)

- `--mcp-config <file>` takes the same JSON as `.mcp.json`; **repeated flags merge** (`--mcp-config a
  --mcp-config b` gives both), so a hub child's own `--mcp-config` adds to the launcher's.
- Without `--strict-mcp-config` it **merges** with the user's `.claude.json` servers and the project's
  `.mcp.json`; on a name clash **the `--mcp-config` entry wins** (`tasks` pointed at `sleep` came up
  `failed`).
- With `--strict-mcp-config` only the `--mcp-config` servers load: the project's `.mcp.json` is ignored
  (`projsrv` gone), and so would be hand-added servers. A plugin's own MCP servers could not be checked: a
  `--plugin-dir` plugin's `.mcp.json` did not show in `init` either way, and none of the installed plugins
  declares one.
- The generated entries (stdio through `launch.ts`, http with `headersHelper`) are the ones `wanted()`
  already produced for `.claude.json`: no change of shape.

## Decision

- **The CLI is not projected.** `apps/cli/mcp/config.ts` generates `<runtime>/<profile>/mcp.json` from the
  registry, accounts and manifest; `bin/claude` passes it with `--mcp-config`. No `--strict-mcp-config`:
  the project's `.mcp.json`, plugins and hand-added servers keep working.
- **Generated with the settings**, by the same stamp-gated run of `agents settings` that `prelaunch.sh`
  already makes (the inputs it watches are the registry's); also forced when a profile has no `mcp.json`.
  The launcher stays pure bash. Children of the hub start through the profile's launcher, so they get it.
- **Desktop stays a projection**, as it can only read its own file, but never blocks: written when that
  Desktop is closed, otherwise left, and `claude-launch` applies it just before opening the app (a marker
  in the cache makes prelaunch force the run). The doctor never warns for it.
- **A profile with Desktop keeps a projection into `.claude.json`** (owner's decision, 2026-10-14): the
  Claude Code embedded in Desktop (its Code tab) reads that file, not the launch config. Same rule as
  Desktop's file: managed servers only, merge with backup, `oauthAccount` and hand-added servers
  untouched, written at the forced run of `claude-launch` when no Claude of the profile is open, else
  marker and the next occasion. No doctor warning.
- **For a profile without Desktop the old projection is retired once**: the servers the per-machine state
  recorded (`cli:<profile>`) are taken out of `.claude.json`, with a backup, only when the launch config
  exists and no Claude of that profile is open.

## Consequences

- The class "registry out of sync" is gone for the CLI: no copy, no comparison, no "close Claude".
- Removed: the CLI target of the sync, its blockers for the MCP repair, the console's "close for MCP"
  purpose, the doctor's `mcp.sync` warning.
- The Desktop surfaces (chat file, and `.claude.json` for the Code tab) remain projections, but never
  block and never warn; a change reaches them at the next Desktop launch.

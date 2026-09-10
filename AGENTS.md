# AGENTS.md — claude-multi

## Repo profile
- visibility: agents           # me-only | agents | co-author | client | public
- stable branch: release
- language: English            # code, commits, docs, UI
- MCP layer: code

## What this is

A multi-profile setup for Claude Code and Claude Desktop: several accounts isolated on one machine.
**This repository is the source of truth**; `~/.claude-multi/` is runtime materialised by
`claude-multi install`. Operational detail lives in the [README](README.md).

## Rules for working here

- **Never edit `~/.claude-multi/shared` by hand**: it is a symlink to this repository's `shared/`.
  Change it here, commit, push. Other machines pick it up on the next Claude launch
  (`bin/lib/prelaunch.sh`).
- **Runtime never enters the repository**: credentials, `.claude.json`, sessions, plugin cache,
  marketplaces. A file containing `oauthAccount` or a token must never be committed. `.gitignore`
  covers the backups (`*.bak*`, `*.backup`).
- **Every new invariant goes in `cli/doctor.ts`**, not in the README. The README describes, the
  doctor verifies. Those two have already drifted apart once.
- **No per-profile constants.** Profiles are discovered from `profiles/*/profile.json`
  (`profileNames()`), and the Desktop directory comes from the manifest (`desktopDir()`). A check
  that names "work" or "personal" is a bug: derive it from the manifests instead.
- **The cost in `usage` is a list-price equivalent, not a charge.** Consumption sits on three planes
  (`cli/budget.ts`): `billed` (extra credits, real money, the only one that notifies), `plan`
  (subscription windows), `estimate` (list price). The plane belongs to the **metric**, not to the
  profile — do not reintroduce a per-profile billing class, and do not let anything but `billed`
  raise a notification.
- **The console serves itself** (`claude-multi-console.service`). UI updates arrive over SSE on
  `/api/events`: a new panel hangs off `refresh()` by topic, never off a new polling loop.
- **Launching stays pure bash** (`bin/claude`, `bin/claude-work`, `bin/lib/prelaunch.sh`): no Deno
  on the hot path, so a wrapper still works on a machine without it.
- **Verify before saying done**: `deno task check` and `deno task test`, then `claude-multi doctor`.
  If you touched `install`, run `claude-multi install --dry-run` first. A new pure function gets a
  new test in `cli/tests/`. Careful: `deno task check | grep` swallows the exit code — read the
  output, not just the filter.
- **Changing `~/.claude-multi` while a Claude session is open moves the ground under that session.**
  Run `install` and `claude-multi mcp sync` from a terminal with Claude closed.
- Commits carry no attribution trailer (`commit-trailer-guard` hook).

# AGENTS.md — claude-multi

## Repo profile
- visibility: agents           # me-only | agents | co-author | client | public
- stable branch: release
- language: English            # code, commits, docs; the console UI is English + Italian (cli/dashboard/i18n.js)
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
  (`profileNames()`), the Desktop directory comes from the manifest (`desktopDir()`), and the
  launcher name from `commandOf()` / `launchers()`. A check that names "work" or "personal" is a
  bug: derive it from the manifests instead. This holds for materialising a profile too, not just
  reading one — `install` links one launcher per manifest and builds the `~/.zshrc` block from
  them; there is a single launcher script (`bin/claude`) that identifies its profile from the name
  it was invoked as.
- **The cost in `usage` is a list-price equivalent, not a charge**, and nothing in this repository
  monitors billing: the budget module was removed on purpose (2026-09-30). Do not bring back
  thresholds or notifications on spending.
- **The console serves itself** (`claude-multi-console.service`). UI updates arrive over SSE on
  `/api/events`: a new panel hangs off `refresh()` by topic, never off a new polling loop.
  Every string on the page is a key in both dictionaries of `cli/dashboard/i18n.js` (`t()`,
  `data-i18n*`): a string added in one language only falls back to English, visibly.
- **Notifications go through `desktopNotify()`** (`cli/notify.ts`): normal urgency, eight seconds,
  once per event. Never `-u critical` — on KDE it ignores the expiry and stays on screen.
- **The desktop app is a view** (`lib/claude-multi-app/`, PySide6): what it shows comes from the
  console's API, what it does is a CLI command. A colour or a rule the tray applies is TypeScript
  (`summarize()` in `cli/status.ts`, with its test), not Python. Its name and identifiers derive
  from `NAME` in `common.py`. Qt aborts the whole process when a running `QThread` is destroyed:
  a window that owns a worker is not deleted before the worker finishes.
- **Launching stays pure bash** (`bin/claude`, `bin/claude-launch`, `bin/lib/`): no Deno on the hot
  path, so a wrapper still works on a machine without it. The manifests are read from bash through
  `bin/lib/profiles.sh` (`cm_command`, `cm_desktop_dir`, `cm_desktop_appid`) — one place, no jq.
  Careful there: `set -o pipefail` plus `grep -q` reports failure even on a match, because grep
  exits first and the producer dies of SIGPIPE. Use `cm_has_profile`, not a pipe into `grep -q`.
- **A profile with its own `desktopDir` gets its own Desktop build.** The official binary
  self-assigns its app_id, so a second icon needs a patched executable
  (`bin/claude-desktop-rebuild <profile>`), and `install` writes its `.desktop` from
  `desktop/entry.desktop.in`. Never add a per-profile `.desktop` or rebuild script by hand.
  Three things have to be set per profile or the instances are indistinguishable: the app_id
  (`setDesktopName`, taskbar icon and grouping), the tray tooltip (the argument of `setToolTip` is
  rewritten in the bundle), and the tray PNGs, which ship monochrome — the rebuild replaces those
  two symlinks with copies tinted from the profile's application icon.
  **Never call `app.setName()`**: Electron keys the system keyring on the application name, so
  renaming the app makes the stored token unreachable and the user is asked to sign in again. That
  happened once, to get a per-profile tooltip; the tooltip is now changed at its call site instead,
  leaving the app's identity alone.
- **Verify before saying done**: `deno task check` and `deno task test`, then `claude-multi doctor`.
  If you touched `install`, run `claude-multi install --dry-run` first. A new pure function gets a
  new test in `cli/tests/`. Careful: `deno task check | grep` swallows the exit code — read the
  output, not just the filter.
- **Changing `~/.claude-multi` while a Claude session is open moves the ground under that session.**
  Run `install` and `claude-multi mcp sync` from a terminal with Claude closed.
- Commits carry no attribution trailer (`commit-trailer-guard` hook).

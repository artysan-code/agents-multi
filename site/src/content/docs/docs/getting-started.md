---
title: Getting started
description: Install claude-multi, sign in to each profile, and check the result.
---

## Requirements

`deno` and `git`. For Claude Desktop also `gnupg`, `binutils` (`ar`), `libarchive` (`bsdtar`) and
`@electron/asar`, plus `base-devel` once. For the desktop app, `pyside6` **and** `qt6-webengine`.

## Install

```bash
git clone <the repository> ~/.local/src/claude-multi
~/.local/src/claude-multi/bin/claude-multi init ~/claude-multi-config --name Ann --language English
~/.local/src/claude-multi/bin/claude-multi install
```

`init` makes your configuration from `config.example/`; on a second machine, once the folder is
there, it only links it. `install` is idempotent and reversible: it never deletes real content, it
moves it aside to `*.pre-repo-<stamp>` and says so. Run `install --dry-run` first to read the plan.

## First run

1. Edit `owner.json` and `profiles/` in your configuration: one folder per Claude account.
2. `claude-multi vault init` — the secret vault. Keep the recovery code somewhere safe.
3. `claude` (and each profile's command) — sign in with `/login`.
4. Optionally your own brain: an instance on your server, then `claude-multi brain-login`.
5. `claude-multi mcp sync` with Claude closed, then:

```bash
claude-multi doctor
```

The doctor checks every invariant and prints the fix for whatever is off. The console is already
running at <http://127.0.0.1:7331>, and on a desktop the tray app opens it in a window of its own.

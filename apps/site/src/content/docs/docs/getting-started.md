---
title: Getting started
description: Download the Agents Multi desktop app, let the first-run wizard set it up, and keep it up to date.
---

## Download

Every machine runs the **Agents Multi** desktop app: it carries the console, its backend and the Deno
that runs them, and installs everything else itself. Linux x86_64 for now; macOS and Windows come
with 1.x.

Each version is on the [GitHub releases](https://github.com/artysan-code/agents-multi/releases)
(betas are marked as pre-releases). Pick the file for your system:

| System           | File                                  | Install                                                    |
| ---------------- | ------------------------------------- | ---------------------------------------------------------- |
| Debian, Ubuntu   | `agents-multi_<version>_amd64.deb`    | `sudo apt install ./agents-multi_<version>_amd64.deb`      |
| Arch             | the AUR package `agents-multi-bin`    | `paru -S agents-multi-bin` (stable versions only)          |
| Anywhere else (Fedora, openSUSE too) | `agents-multi_<version>_amd64.AppImage` | `chmod +x` it and run it |

The deb brings WebKitGTK as a dependency; the AppImage needs it on the system
(`webkit2gtk-4.1`).

## First run

Start the app. On a machine with no configuration its console opens on the **first-run wizard**,
one screen at a time:

1. Your name and language.
2. The configuration folder — what is yours (profiles, accounts, rules) lives there, outside the app.
   A folder that already holds one, synced from another machine, is only linked.
3. The profiles: one per Claude account.
4. Install, with its output: the commands in `~/.local/bin`, the profiles in `~/.agents-multi`, the MCP
   servers' runtime and the start at login.
5. Claude Code, when the machine has none: Anthropic's installer puts it in place, and Agents Multi
   keeps it up to date from then on.
6. The vault for secrets — keep its recovery code somewhere safe — or another machine's, opened with
   its code.
7. Each profile's sign-in.
8. Your brain, optionally.

It resumes where it stopped: each step is done when its result is on disk. Then check the result
from a terminal:

```bash
agents doctor
```

The doctor checks every invariant and prints the fix for whatever is off.

## Updates

The app updates itself: it looks for a new version every day and downloads it in the background,
and **System › Updates** installs it and restarts the app and everything it runs (a deb
asks for your password). The same screen updates Claude Code and Claude Desktop. A beta stays on the
beta channel; on the AUR, pacman updates the package and the app's own updater is off.

## From a checkout

A git checkout is for development (dev mode): `deno`, `git` and `pnpm` are needed, and

```bash
git clone https://github.com/artysan-code/agents-multi ~/.local/src/agents-multi
~/.local/src/agents-multi/bin/agents init ~/agents-multi-config --name Ann --language English
~/.local/src/agents-multi/bin/agents install
```

`install` is idempotent and reversible: it never deletes real content, it moves it aside to
`*.pre-repo-<stamp>` and says so; `install --dry-run` shows the plan. A machine installed this way
moves to the app with `agents migrate app`, with every Claude closed.

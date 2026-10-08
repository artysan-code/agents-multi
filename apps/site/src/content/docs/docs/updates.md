---
title: Updates
description: Claude Code, Claude Desktop and Agents Multi update themselves, verified and reversible.
---

Everything updates itself in the background, with no approval and no window: the app runs the round
ten minutes after it starts and every four hours, then the doctor.

- **Claude Code** — installed as soon as a new version is out; open sessions keep running on the
  version they started with.
- **Claude Desktop** — lives in user space, no root at any step. A new version is *staged* at any
  time and *applied* only when no Claude Desktop is running, then each profile's variant is rebuilt.
- **Agents Multi** — the desktop app: it checks for a new version every day and downloads it in the
  background, verified against the project's signing key; **System › Updates** installs it and
  restarts the app. Its code is installed when every Claude is closed. Betas are a channel of their
  own, and the Arch package is updated by pacman instead.
- **From a checkout** (dev mode) — a fast-forward pull on a clean tree in the same round; the
  console restarts if its code changed, and `install` runs only with every Claude closed.
- **Rollback** — `agents update --rollback` (`--desktop` for Claude Desktop), or one button in the console.
- **Supply chain** — the Anthropic apt repository key is pinned: the `InRelease` signature, the index
  hash and the package hash are all checked before a file is extracted.

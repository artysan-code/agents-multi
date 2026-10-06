---
title: Updates
description: Claude Code, Claude Desktop and claude-multi update themselves, verified and reversible.
---

Everything updates itself in the background, with no approval and no window: a timer runs the round
ten minutes after login and every four hours, then the doctor.

- **Claude Code** — installed as soon as a new version is out; open sessions keep running on the
  version they started with.
- **Claude Desktop** — lives in user space, no root at any step. A new version is *staged* at any
  time and *applied* only when no Claude Desktop is running, then each profile's variant is rebuilt.
- **claude-multi** — a fast-forward pull on a clean tree; the console and the tray restart if their
  code changed, and `install` runs only with every Claude closed.
- **Rollback** — `claude-multi update --rollback`, or one button in the console.
- **Supply chain** — the Anthropic apt repository key is pinned: the `InRelease` signature, the index
  hash and the package hash are all checked before a file is extracted.

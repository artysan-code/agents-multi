---
title: Setup with Claude
description: Let a Claude Code session guide you through the setup, with you typing every secret yourself.
---

The [first-run wizard](/docs/getting-started/) is the usual way in. If you would rather talk it
through, or you are setting up from a checkout, a Claude Code session can do the work with you: it
reads the project's guide for exactly this, asks you what it needs, runs the commands and stops where
you have to act.

## How

Open Claude Code in a terminal (any folder) and paste:

```text
Set up Agents Multi on this machine with me. Follow
https://github.com/artysan-code/agents-multi/blob/release/ONBOARDING.md step by step,
one question at a time, and stop whenever I have to do something myself.
```

The guide, [ONBOARDING.md](https://github.com/artysan-code/agents-multi/blob/release/ONBOARDING.md),
is written for the session: what to ask you first, the requirements, your configuration, the
install, Claude Desktop, the brain and the final checks.

## What it will and will not do

- **It asks before anything hard to undo**, and shows the plan first (`agents install --dry-run`).
- **It never sees your secrets.** Passphrases, tokens, TOTP secrets and the vault's recovery code are
  typed by you, in your own terminal; the session never asks for them in chat.
- **It stops when Claude has to be closed.** `install` and `agents mcp sync` run with every Claude
  closed, that session included: it gives you the commands and you run them. A new session picks up
  from `agents doctor`.
- **It backs up first.** Your existing Claude Code settings move aside, never deleted.

When it is done, `agents doctor` should show no failures; the
[everyday commands](/docs/commands/) are what you will use from then on.

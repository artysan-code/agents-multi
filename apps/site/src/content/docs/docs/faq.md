---
title: FAQ
description: Short answers to what people ask first.
---

## Is it official?

No. Agents Multi is an independent, unofficial project, not affiliated with or endorsed by Anthropic.
Claude, Claude Code and Claude Desktop are trademarks of Anthropic, PBC.

## Does it cost anything?

Agents Multi is free to use. It does not bill you for anything, and the cost figures in `agents usage`
and the console are an estimate at list prices of what the tokens would cost, not a charge. What you
pay for Claude is between you and Anthropic.

## Which systems does it run on?

Linux x86_64 for now. macOS and Windows come with 1.x. See [Getting started](/docs/getting-started/).

## Do I need the brain?

No. It is optional: memory and tasks on a server of yours, shared by every Claude. Profiles, the
console, MCP and the vault work without it. See [The brain](/docs/brain/) and
[Self-hosting the brain](/docs/self-hosting/).

## Does it send telemetry?

No.

## Where are my credentials?

On your machine: each profile's login is in its own folder under `~/.agents-multi/`, and the secrets
your tools use are in the encrypted vault, with the key in your keyring. They are never in your
configuration folder or in the repository. See [Security](/docs/security/).

## Can I use it with just one account?

Yes. One profile is enough; you still get the console, the vault, the updates and the brain if you
want it. Adding a second profile later is a new folder. See [Profiles](/docs/profiles/).

## How do updates work?

Claude Code, Claude Desktop and Agents Multi update themselves in the background, verified, and can
be rolled back. See [Updates](/docs/updates/).

## What is the licence?

The GNU AGPL-3.0 with the Commons Clause: source-available. You may use it, modify it, fork it and
share it, for yourself or inside a company; you may not sell it, or a product or service whose value
comes substantially from it. It is not open source in the OSI's sense. See the
[LICENSE](https://github.com/artysan-code/agents-multi/blob/release/LICENSE) and the
[README](https://github.com/artysan-code/agents-multi/blob/release/README.md#license).

## Does it work with other AI providers?

Not yet. Today it is built around Claude Code and Claude Desktop; other providers are something we
want to support, but there is no date.

## Something is wrong. Where do I start?

`agents doctor`, then [Troubleshooting](/docs/troubleshooting/).

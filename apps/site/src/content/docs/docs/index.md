---
title: Introduction
description: What Agents Multi is, and what it brings together.
---

Agents Multi runs several **Claude Code** (Anthropic's command-line agent) and **Claude Desktop**
accounts on one Linux machine, without them seeing each other, and gives every Claude the same memory,
the same tasks and the same tools.

It grew out of daily use: a personal account and a couple of work accounts, each with its own login,
its own settings and its own Claude Desktop, all sharing one memory and one task list, and none of
them allowed to touch the secrets.

## What is in it

- **Profiles** — one folder per account: its login, settings, skills, agents and commands, and its
  own Claude Desktop with its own icon. See [Profiles](/docs/profiles/).
- **The console** — a local web app on `127.0.0.1:7331` that shows what every profile is doing.
  See [The console](/docs/console/).
- **The brain** (optional) — memory and tasks on a server of yours, reached by every Claude over MCP.
  See [The brain](/docs/brain/).
- **MCP and the vault** — MCP is how Claude calls tools: one registry of tool servers, one account
  per tool, every credential encrypted in the vault. See [MCP and the vault](/docs/mcp-and-vault/).
- **Updates** — Claude Code, Claude Desktop and Agents Multi update themselves, verified and
  reversible. See [Updates](/docs/updates/).

## How it is built

The desktop app carries the code and installs it into `~/.agents-multi/`, the runtime: profiles,
logins, sessions. What is yours — profiles, accounts, rules, preferences — lives in a folder of
yours, apart from the code, which you keep in step between machines with git or Syncthing. The code
travels with the app; the runtime directory never goes into a synced folder, because it holds credentials.

:::note
Agents Multi is young: versions before 1.0 can still change how things are laid out. Each release
says what changed in the [changelog](/docs/changelog/).
:::

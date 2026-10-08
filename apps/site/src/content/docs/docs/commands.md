---
title: Everyday commands
description: The commands of Agents Multi you will use day to day, and where the rest are.
---

Most of Agents Multi happens in the desktop app and its console: the first-run wizard, updates
(**System › Updates**), connections, tasks and the brain. These are the commands for a terminal.

## Claude, on a profile

| Command | What it does |
| --- | --- |
| `claude` | Claude Code on the default profile |
| `claude-<profile>` | Claude Code on another profile: each profile declares its own command in its `profile.json` |

Claude Desktop starts from each profile's entry in your application menu, or from the app's
profile picker («Which Claude?», in the tray).

## Checking and fixing

| Command | What it does |
| --- | --- |
| `agents doctor` | checks every invariant of the setup and prints the fix for whatever is off |
| `agents status` | versions, available updates, what each profile has mounted, what is running |
| `agents install --dry-run` | shows what an install would change; without `--dry-run` it does it (idempotent, never deletes real content) |
| `agents mcp sync` | applies the MCP servers to every profile, with Claude closed |

## Updates

| Command | What it does |
| --- | --- |
| `agents update` | updates Claude Code, Claude Desktop and Agents Multi (the console's **System › Updates** does the same) |
| `agents update --check` | only says what is new |
| `agents update --rollback` | goes back to the previous Claude Code |

## Secrets, tasks and usage

| Command | What it does |
| --- | --- |
| `agents vault status` | the secret vault the MCP servers read their credentials from |
| `agents vault set <service> <account>` | stores an account's secret (or use the console's Connections) |
| `agents tasks brief` | today's tasks from the terminal |
| `agents usage --since 7d` | tokens and a list-price estimate by profile, model, project, skill… (not a bill) |

The full list, with every option, is in the repository's
[README](https://github.com/artysan-code/agents-multi#commands).

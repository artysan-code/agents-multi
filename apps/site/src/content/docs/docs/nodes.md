---
title: Nodes
description: Work that moves between your machines, started only with your signature.
---

Every machine's console can be a **node** of the service — the brain, which also keeps your machines and the
jobs placed on them. A job can run on the machine that is free, and continue on another one if a machine goes
off. Nothing moves without your yes.

## Turning a machine into a node

```bash
agents node login
agents node enable
agents node
agents nodes
```

`agents node enable` turns on this machine only (its own file, never synced); `agents node` shows what this machine announces; `agents nodes`
shows every machine and job the service sees.

- **Outbound only.** Every 30 seconds the node tells the service its load, how many sessions it may run (from
  its memory, or `maxSessions`), which accounts are logged in and whether you are at it. It uses its own machine
  token (`agents node login`, kept on that machine only). Nothing listens beyond `127.0.0.1`.
- **Your yes is checked on the node.** A job placed on a node runs only with your signature, made on one of your
  machines with a key derived from the vault, which the service never has: a stolen token or a broken service
  cannot start an agent.

## Accepting a job

```bash
agents nodes accept <job>
agents nodes decline <job>
agents nodes propose <routine> --node <name>
```

`accept` shows the whole job first, then signs it on this machine; the node may run it for 24 hours. A job
taken runs as a one-shot routine, under the same run policy, limits and reviewer as any other.

## Resuming elsewhere

While a run works, its node pushes the branch `agent/<id>` and its handoffs (`refs/agents/<id>`). A node
silent for ten minutes loses its running jobs, and a proposal to resume each one on another node — a clone of the
same remote — waits for you.

## A server node

A server runs `agents serve --headless`: no page, every child in Claude Code's Bash sandbox, failing closed
(`agents node probe`), and only the node pushes. It gets your configuration and the vault read only, as two
Syncthing folders of their own (`agents config move` puts the configuration in `~/agents-multi-config`), and one
command in its terminal sets it up:

```bash
agents node setup
```

Nobody signs in to Claude on the server. On your desktop, once a year per account:

```bash
agents node token <profile>
```

puts a long-lived token of that account in the vault (Claude Code's `setup-token`); the node gives it only to that
account's children, and checks before it takes work that what they run cannot see it. Such a token makes model
requests only: the claude.ai connectors are not there, your own MCP servers are. The server image is in
`apps/node/` of the repository, with its steps.

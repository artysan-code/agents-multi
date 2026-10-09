---
title: Troubleshooting
description: Start with the doctor, then the usual situations and what to do about them.
---

## Start with the doctor

```bash
agents doctor
```

It checks every invariant of the setup and prints the fix for whatever is off. `agents doctor --probe`
also sends one tiny request per profile to see that its Claude Code login works. `agents status`
shows versions, what each profile has mounted and what is running. The console's **System** section
shows the same checks with their fixes.

## The install or update waits for Claude to close

An install that would change what an open Claude reads (its settings, its links) waits until no
Claude is running; one that changes none of it goes on at once. The rail's update button then says
**Close Claude to finish**: it opens the update screen at its last step, which lists the sessions to
close and closes them when you say so, or leaves the install for later — it finishes on its own once
every Claude is closed. A new Claude Desktop already downloaded takes its version the next time it
opens. Claude Desktop stays in the system tray when you close its window: quit it from there.

## `agents` is not found

The install puts `agents` and `claude` in `~/.local/bin`. Make sure it is on your `PATH` and open a new
terminal. Most distributions add it when the folder exists.

## The vault cannot be opened

The vault's key is in your keyring, so it needs a running Secret Service (KWallet, GNOME Keyring)
that is unlocked. Check with `agents vault status`.

- Keyring locked: unlock it (it usually unlocks at login).
- No Secret Service on this machine: install and start one.
- Keyring lost or a new machine: `agents vault pair` with the vault's recovery code. If you have
  another machine that still has the vault, `agents vault recovery-code` run in a terminal there
  shows it. Do not restore the vault folder from a backup onto a reinstalled machine: pair it and
  let the entries sync.

## A profile's sign-in expired

Open a terminal and start that profile's command, `claude-<profile>` (plain `claude` for the default),
then type `/login`. `agents doctor --probe` tells you which profiles need it.

## An MCP server does not show up

With every Claude closed:

```bash
agents mcp sync
agents mcp health --probe
```

`sync` applies the registry to every profile; `health --probe` starts each server and waits for it to
answer. Then start Claude again: running instances do not pick up changes. A server that needs an
account appears only once the account exists in `accounts.json`.

## The brain does not answer

Check the address in console › Connections. If the machine's token is gone or stale, sign in again:

```bash
agents brain-login
```

If it still fails, check that `https://<your brain>/ready` answers; on your server, the service's log
says why (see [Self-hosting the brain](/docs/self-hosting/)).

## Syncthing conflict copies

When two machines change the same file, Syncthing leaves a file with `.sync-conflict-` in its name next
to the original, and the doctor reports it. Compare the two, keep the right content in the original
and delete the copy.

## Rolling back an update

```bash
agents update --rollback            # the previous Claude Code
agents update --rollback --desktop  # the previous Claude Desktop
```

The same buttons are in **System › Updates**.

## Where the logs are

- Updates: `~/.local/state/agents-multi/updates.jsonl`, one line per result, shown in
  **System › Updates**.
- The desktop app: `~/.local/share/me.artysan.agents/logs/`, with `backend.log` (the console's
  backend and its scheduled jobs) and `install.log` (the install of the code).

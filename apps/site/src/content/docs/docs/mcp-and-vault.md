---
title: MCP and the vault
description: One registry of MCP servers, one account per tool, every credential encrypted.
---

## The registry

One registry of MCP servers: a catalogue of templates, **all off** until you turn one on — by adding
an account of that service, or by naming the profiles that should see it. Servers of your own go in
your configuration, never in the repository. Servers that are not ours (Cloudflare, Supabase,
Railway…) run one per account, so each one only ever sees its own.

A profile can see several accounts of one service; each tool then takes `account`, required as soon
as there is more than one — never a silent default.

## The vault

- Accounts are listed without secrets; the **secrets are in the vault**: one file per secret,
  AES-GCM with a fresh IV per write, named by an HMAC so the names say nothing.
- The key is in each machine's keyring, so nothing is typed at login. A new machine pairs with a
  recovery code.
- A secret is never a command-line argument and never a tool result. Servers mask what they return,
  and the shared permissions deny a Claude session the ways to the key.
- A service's own command-line tool gets the same token: `agents vault run cloudflare --
  wrangler deploy`. What deletes or rolls back asks for a typed "yes" on a terminal — a Claude session
  has none, so there it is refused with the command to run.

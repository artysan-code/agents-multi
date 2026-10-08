---
title: Security
description: What Agents Multi does to keep your credentials, your sessions and your memory safe.
---

This page lists what the project does, as the code and the docs say it. It is not a promise about
anything they do not say.

## Secrets and the vault

- Credentials live in the **vault**, not in configuration: one encrypted file per secret, AES-GCM with
  a fresh IV per write and the entry's id as associated data, so an entry cannot be swapped for
  another unnoticed. File names are an HMAC, so they say nothing about what is inside.
- The vault's key is **in each machine's keyring** (Secret Service: KWallet, GNOME Keyring), never on
  disk next to the entries. A new machine gets it once from the **recovery code** shown when the
  vault is made; keep that code outside the machine.
- Deleting a secret writes a tombstone instead of removing the file, so a synced removal cannot lose
  against a concurrent edit and come back.
- A secret is **never** a command-line argument, never in a configuration file and never a tool
  result. `accounts.json` lists accounts with no secret in it.
- Servers **mask** what they return: values under names that look secret (passwords, tokens, keys,
  cookies…) and the user and password in an address are replaced before they reach a conversation.
  Tools that write whole objects back refuse a payload carrying the mask, so a masked read cannot
  overwrite the real secret.

## Keeping sessions away from the vault

The shared permissions deny a Claude session the ways to the key: `secret-tool`, `kwallet-query`,
`agents vault recovery-code`, and reading or editing the vault folder. Reading `.env` files asks first.
Hooks in the shared settings also guard the vault and block destructive shell commands.

A service's own command-line tool gets its token through `agents vault run`; what deletes or rolls
back asks for a typed "yes" on a terminal. A Claude session has none, so there it is refused with the
command for you to run.

## What the tools can do on external services

- The tool servers have **no deletion tools** on external services. The one exception is deleting a
  calendar event (`calendar_delete`), which asks first.
- Sending mail asks first.

## The brain

- Accounts exist only by invitation. Signing in takes the account, a passphrase (stored as a PBKDF2
  hash) and a TOTP code; repeated wrong attempts close the account to that address for a while.
- Claude connects through **OAuth 2.1 with PKCE**; machines get a personal token by signing in.
- Tokens are stored as hashes. TOTP secrets and backup keys are encrypted with a key that exists only
  in the server's environment.
- Every copy of the brain is **encrypted** with your own backup key before it leaves the server.
- Forms act only from the brain's own pages, request bodies are capped, and errors answer with an id,
  never their message.

More in [The brain](/docs/brain/) and the brain's
[README](https://github.com/artysan-code/agents-multi/tree/release/apps/brain#readme).

## Updates

- The desktop app updates through Tauri's **signed updater**: a new version is verified against the
  project's signing key, and the signature carries the version, so a tampered manifest cannot pair a
  version with another release's file. See
  [ADR 0004](https://github.com/artysan-code/agents-multi/blob/release/docs/adr/0004-desktop-app-releases.md).
- Claude Desktop comes from Anthropic's apt repository, whose key is **pinned**: the `InRelease`
  signature, the index hash and the package hash are all checked before a file is extracted.

## Telemetry

None. Agents Multi sends nothing about you or your use to the project. The only requests it makes
are the ones you can see: updates, and your own brain and services.

## Reporting a vulnerability

Report it privately through GitHub:
[Report a vulnerability](https://github.com/artysan-code/agents-multi/security/advisories/new). Please
do not open a public issue. More in
[SECURITY.md](https://github.com/artysan-code/agents-multi/blob/release/SECURITY.md).

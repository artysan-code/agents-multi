---
title: The brain
description: Memory and tasks on your own server, reached by every Claude you use.
---

The brain is a small service on your server. Each person has an account and a database of their own;
every Claude they use connects to it — the Claude apps and claude.ai as a custom connector, Claude Code
and Claude Desktop as a remote MCP server — and their machines with a personal token.

## What it keeps

- **Documents** — Markdown with a path, linked with `[[target]]` as Obsidian writes them, in seven
  areas: who you are, projects, clients, people, notes, a diary, an inbox.
- **History** — every write keeps the version it replaces, with who made it and when. Anything can
  be read as it was and put back.
- **Tasks** — one document per task, one list for every chat, the console and the web board.
- **Search** — full text and by meaning, fused; the embeddings are computed by a model on the same server.

Claude writes without asking, so the rules are enforced by the service and a write that breaks one
is refused with the reasons: one subject per page, a title and a sentence saying what it is, at least
one link, no near copies, no secrets.

## Who gets in

Accounts exist only by invitation. On a brain you run yourself you are its administrator, and you
invite the others: how to deploy one and manage its accounts is in the brain's
[README](https://github.com/artysan-code/agents-multi/tree/release/apps/brain#readme). Signing in takes the account, a passphrase and a TOTP code. Claude
connects through OAuth 2.1 with PKCE; machines get a personal token by signing in. Tokens are stored
as hashes; TOTP secrets and backup keys are encrypted with a key that exists only on the server.

## Backups

Your machines check every half hour whether the brain changed and fetch a copy only when it did,
sealed with your own backup key. No third party holds the brain.

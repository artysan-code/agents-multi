---
title: Self-hosting the brain
description: Run your own brain on a server with Docker, create the first account, and connect your machines and Claude.
---

The [brain](/docs/brain/) is optional. If you want memory and tasks shared by every Claude you use,
you run it on a server of yours; nobody else holds your data.

:::note
A prebuilt image is planned on GHCR (`ghcr.io/artysan-code/agents-multi-brain`) starting with an
upcoming release. It is not available yet: today you build the image from the repository.
:::

## What you need

- A server with **Docker** and Docker Compose.
- A **domain with TLS** in front of port 8080 (a reverse proxy, Coolify, Cloudflare…). OAuth names the
  address exactly, so it must be the public `https://` one.
- About **2 GB of memory** free for the embedding model (`bge-m3`, about 1.2 GB on disk), which runs in
  an Ollama container next to the brain.

## Start it

Get the repository, go to the brain's folder and put the settings in a `.env` next to the compose file:

```bash
git clone https://github.com/artysan-code/agents-multi
cd agents-multi/apps/brain
```

```bash
# .env
BRAIN_URL=https://brain.example.com
BRAIN_MASTER_KEY=<head -c32 /dev/urandom | base64>
BRAIN_ADMIN_ID=me
AGENTS_MULTI_OWNER_ID=me
AGENTS_MULTI_OWNER_NAME=Your name
AGENTS_MULTI_LANGUAGE=English
BRAIN_BACKUP_KEY=<head -c32 /dev/urandom | base64>
```

```bash
docker compose up -d
```

The first start builds the image and pulls the embedding model into its own volume, so it takes a
while. `/ready` answers when the service is up. The secrets are made and typed by you, never kept in
the repository.

## The variables

From [`compose.yaml`](https://github.com/artysan-code/agents-multi/blob/release/apps/brain/compose.yaml):

| Variable | What it does |
| --- | --- |
| `BRAIN_URL` | the public address, `https://brain.example.com` |
| `BRAIN_MASTER_KEY` | 32 random bytes, base64. Encrypts every account's TOTP secret and backup key. **Lose it and they are lost** |
| `BRAIN_ADMIN_ID` | the id of the first (administrator) account |
| `AGENTS_MULTI_OWNER_ID`, `AGENTS_MULTI_OWNER_NAME`, `AGENTS_MULTI_LANGUAGE` | whose brain this is: the default owner of a task, the name and the language |
| `BRAIN_BACKUP_KEY` | 32 random bytes, base64. Seals the server's own daily copies; none are made without it |
| `BRAIN_BACKUP_KEEP` | how many daily copies stay (default `7`) |
| `BRAIN_EMBED_URL`, `BRAIN_EMBED_MODEL` | the embedding service and model (`http://ollama:11434`, `bge-m3`) |
| `BRAIN_TIMEZONE` | the zone for the days of an account that has not chosen its own (`Europe/Rome` by default) |
| `BRAIN_CLIENT_IP_HEADER` | the header your proxy puts the client's address in, for the rate limits (`cf-connecting-ip` behind Cloudflare) |
| `BRAIN_LOG_LEVEL` | `debug`, `info`, `warn` or `error` (default `info`) |
| `BRAIN_OPERATOR`, `BRAIN_CONTACT`, `BRAIN_HOSTING` | what the public pages say about who runs the instance |
| `BRAIN_SITE_URL` | an address of its own for the site, when you want one |

The data lives in the `brain-data` volume. Put the TLS proxy in front of port 8080 and, if it is
Cloudflare, set `BRAIN_CLIENT_IP_HEADER` and let only Cloudflare reach the server.

## The first administrator and invitations

On the first start, when there are no accounts, the service creates the administrator with the id
`BRAIN_ADMIN_ID` as an **invitation**: its link is written to the service's log (a new one at every
start until it is accepted). Open it, add the TOTP secret to your authenticator, choose a passphrase
and confirm with a code. Nothing secret sits in the environment.

Accounts exist only by invitation. From a shell on the server:

```bash
docker compose exec brain brain-admin list
docker compose exec brain brain-admin create <id> <name> --language English
```

`create` prints a one-time link, valid seven days. `reset <id>` is the way back after losing an
authenticator; `disable`, `enable`, `unlock`, `stats` and `delete` are in the
[brain's README](https://github.com/artysan-code/agents-multi/tree/release/apps/brain#readme).

## Backups

With `BRAIN_BACKUP_KEY` set, the service seals a copy of every database each day into
`/data/backups` and keeps the last `BRAIN_BACKUP_KEEP`. They sit on the same volume as the brain, so
they cover a bad write or a deleted account, not losing the server. Your own machines also fetch a
sealed copy every time the brain changes (`agents brain-backup`), keyed by your account's backup key,
which sits in the vault. `brain-admin backup` makes a copy now; `brain-admin restore` puts one back
with the server stopped.

## Connect a machine

On each machine of yours, either:

- the console › **Connections** › Sign in, or
- `agents brain-login`.

The token and the backup key go straight into the vault. In `accounts.json` the brain is an account
named `brain`:

```json
{ "accounts": [{ "service": "brain", "name": "brain", "url": "https://brain.example.com" }] }
```

Profiles other than the default one reach the brain as an MCP server: name them in `servers.json`
(`{ "servers": { "brain": { "_profiles": ["work"] } } }`). See
[Configuration](/docs/configuration/).

## Connect Claude

In the Claude apps and claude.ai, in the account you use as default: Settings › Connectors › Add
custom connector, named exactly **Brain** (the console and Hey Claude look for that name), with the
URL `https://brain.example.com/mcp`. Sign in on the page that opens. It then shows up in Claude
Desktop and the phone app too.

# brain

The brains of several people as one service: each one's memory and tasks in one place on a server,
reached by every Claude they use — the Claude apps and claude.ai as a custom connector, Claude Code
and Claude Desktop as a remote MCP server — and by their machines with a personal token. There is
no copy on the machines: the brain is here. Each person has an account and a database of their
own; every request runs as the account its token or session belongs to.

## What it keeps

- **Documents**: Markdown with a path (`area/name.md`), linked with `[[target]]` as Obsidian
  writes them, in seven areas and by the rules below.
- **History**: every write keeps the version it replaces, with who made it (`claude:<client>`,
  `token:<machine>`) and when. A deletion is a revision too; anything can be read as it was and put
  back (`brain_history`, `brain_restore`).
- **Tasks**: one document per task under `tasks/`, with the same rules as the local tasks tools
  (`shared/mcp/lib/tasks.ts`, `shared/mcp/tasks/tools.ts`, shared code). Memory lists and searches
  leave them out unless asked. The owner's machines read and write them as files on `/api/tasks`
  (`shared/mcp/lib/brain-tasks.ts`): the console, the reminders and the local `tasks` tools all use
  this one list. A change says which version it was made from (`If-Match`, the task's `updated`);
  when the task has changed since, the brain answers 409 with it as it is now, and the change is
  applied again on top of that.
- **Search**: full text (SQLite FTS5) and by meaning (chunks embedded by `bge-m3` behind Ollama),
  fused by reciprocal rank. The embeddings fill in the background after each write; when the model
  is down or slow (four seconds), search answers with words alone and says so. The indexers of all
  accounts take turns at the model, one document at a time; searches do not queue behind them.

Each person's brain is one SQLite file, `BRAIN_DATA/users/<account>/brain.db`, opened only from
`tenants.ts` with the account a token or session gave. The accounts, their tokens and sessions are
in `BRAIN_DATA/accounts.db`.

## How it is written

Seven areas, named the way the owner thinks: `io/` (who he is, how he works — of each page, what stands
above its first `##` goes into the instructions every connected Claude receives), `progetti/` (one page
per project, the same path as his folder: `progetti/work/acme/portal.md`), `clienti/` (who he works for, directly or through another
client: the relationship and the people, linking the projects), `persone/` (people only), `note/` (how
things are done), `diario/` (one page a day, added to a line at a time and only ever tidied) and `inbox/` (said in passing, to sort).

Claude writes without asking, so the rules are enforced by the service (`rules.ts`, tested) and a
write that breaks one is refused with the reasons: pages in the seven areas, `io`/`clienti`/`persone`/`note`
flat; one subject per page, at most 400 words (1000 for the inbox; a diary page has no limit, but each line says what changed in at most 40 words and a page is tidied only keeping every timed line); `# Title` and one
sentence saying what the page is; at least one link to an existing page; no near copy of a title
in the same area (unless `distinct`); no secrets; at most 15 lines of code. Paths are normalised
(lower case, no accents). The diary and the inbox are added to (`brain_append`), never rewritten;
moving a page (`brain_move`) updates the links to it; `brain_check` lists orphans, broken links,
pages too long and an inbox left alone for a week. The numbers are meant to be tuned in use.

## Who gets in

- **Accounts** (`users.ts`): an id, a name and a language (what the instructions and the tasks use),
  a passphrase (stored as a PBKDF2 hash) and a TOTP secret. Only the administrator makes them, as an
  invitation on `/account`: a one-time link, valid seven days, where the person adds the TOTP secret
  to their authenticator, chooses a passphrase and proves it with a code. A new invitation for an
  account clears its passphrase and TOTP (a lost phone) and cuts every token it had; its data stays.
  The administrator can disable an account, which cuts it off at once. The administrator can read
  every database on the server, as the owner of any server can, and the invitation says so.
- **Claude, through OAuth 2.1**: the MCP endpoint (`/mcp`) answers 401 with a pointer to its
  metadata; Claude registers itself (only Claude's callback or a loopback address are accepted),
  sends the person to `/authorize`, and gets a code bound to a PKCE S256 challenge and to the
  account that signed in. Access tokens last an hour; refresh tokens rotate, and one used twice
  revokes its whole family. Since anyone may register, a client that got nothing after a day, or has
  had no live token for ninety days, is removed; past a thousand clients in use, registration waits.
- **Signing in** takes the account, its passphrase and the current TOTP code. Five wrong attempts
  from one address close that account to that address for fifteen minutes, so nobody can lock its
  owner out from elsewhere; an id that does not exist answers the same way. Each address has a rate
  limit on the sign-in forms and the OAuth endpoints (429), and the passphrase hashing runs two at a
  time with a short line (503 past it). Behind a proxy, `BRAIN_CLIENT_IP_HEADER` names the header
  that carries the client's address (`cf-connecting-ip` behind Cloudflare); trust it only when the
  service cannot be reached around that proxy.
- **Every request body is capped** by its path (64 KB for the sign-in and OAuth endpoints, 1 MB for
  the rest: 413), and an error answers 500 with an id to find it in the log, never its message.
- **The forms act only from the brain's own pages**: a POST to the account page, the board, the
  sign-in or an invitation is refused (403) when the browser says it came from elsewhere
  (`Sec-Fetch-Site`, or the `Origin`) — the session cookie is `SameSite=Lax`, which a sibling
  subdomain would still get. Every answer carries `nosniff`, and HSTS on https.
- **Machines** use personal tokens. Agents Multi gets one by signing in (console › Connections ›
  Sign in, or `agents brain-login`): the brain's OAuth with scope `machine`, only to a loopback
  redirect, answers with a token named after the machine and the account's backup key, and both go
  straight into the vault. `/account` lists them, makes one by hand when needed, and revokes them;
  it also lists Claude's connections and can cut them all.
- **The web pages** (`/account`, `/tasks`) keep a session cookie: an hour from its last use, twelve
  hours at most, `SameSite=Lax` (a link from elsewhere arrives signed in, a form from elsewhere does not).
- Tokens are stored as their SHA-256, never as themselves. The TOTP secrets and backup keys are
  encrypted with `BRAIN_MASTER_KEY`, which exists only in the server's environment.

## Backups

`GET /backup/state` says what the brain is at (a version that changes with every write), and
`GET /backup` with a personal token returns the whole brain as one file: a consistent copy of the
database (the WAL folded in and the file read in one go), sealed with AES-256-GCM under the
account's own backup key (it reaches the vault, `brain/<account>` field `backup-key`, when a machine
signs in; `/account` shows it too): one person's copies never open with another's key. The owner's machines check the state every half hour while they are on and fetch a copy only when
it changed (`agents brain-backup`, `claude-brain-backup.timer`), keeping the last ones; without the key from the vault a copy cannot be read. No third party
holds the brain.

### The server's own copies

With `BRAIN_BACKUP_KEY` set, the service seals a copy of every database (`accounts.db` and each
account's `brain.db`) once a day into `BRAIN_DATA/backups/<UTC time>/` (`accounts.db.brn`,
`<account>.brn`), 30 seconds after a start when the last one is over a day old, and keeps the last
`BRAIN_BACKUP_KEEP` runs. A run is written whole or not at all, and the timer stops on SIGTERM. The
copies use SQLite's online backup, so writers are not held up. They sit on the same volume as the
brain: they cover a bad write or a deleted account, not losing the server, so copy them off it too
(`GET /backup` and `agents brain-backup` do that for the owner's brain).

### Administration from a shell

`brain-admin <command>` in the container (Coolify: the application's terminal; elsewhere
`docker exec -it <container> brain-admin …`; from a checkout, `deno run -A apps/brain/admin.ts …` with
the service's environment) does what the administrator's page does, with the same code, on the files
the server has open (same WAL settings; every statement is short, so they take turns):

| Command                              |                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`                               | accounts: id, name, role, state (active, invited, disabled)                                                                                             |
| `create <id> <name…> [--language L]` | a new account; prints its invitation link once (7 days, one use)                                                                                        |
| `disable <id>` / `enable <id>`       | an account shut out (its tokens and sessions cut) or let back in                                                                                        |
| `reset <id>`                         | lockout lifted, passphrase, TOTP and tokens cleared, a new invitation link (the administrator too: this is the way back after losing the authenticator) |
| `unlock <id>`                        | only the lockout lifted                                                                                                                                 |
| `delete <id> --yes`                  | the account, its tokens and its whole brain, for good (not the administrator); restart the server after, so it lets go of the open file                 |
| `stats`                              | per account: pages, tasks, database size on disk                                                                                                        |
| `backup`                             | a sealed copy of every database now, as the daily job does (needs `BRAIN_BACKUP_KEY`)                                                                   |
| `restore <file> [--yes]`             | a copy back in place of its database                                                                                                                    |

Restoring replaces a database, so the server must not hold it: **stop, restore, start**. In Coolify
stop the application, then run the restore from a one-off container on the same volume
(`docker run --rm -v <volume>:/data -e BRAIN_MASTER_KEY=… -e BRAIN_BACKUP_KEY=… <image> brain-admin restore /data/backups/<run>/alice.brn`;
the entrypoint is `deno`, so pass `--entrypoint brain-admin`), then start it. `restore` refuses while a
server answers on this machine's `PORT` or the database's shared-memory file is there; `--yes` skips
that check when you know it is stale. The file's name picks the database (`accounts.db.brn` or
`<account>.brn`), the replaced file stays beside it as `.pre-restore`, and a copy that does not open
with `BRAIN_BACKUP_KEY` is refused.

## Running it

| Variable                                           |                                                                                                                                                                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BRAIN_URL`                                        | the public address, `https://brain.example.com` (OAuth names it exactly); on Coolify it comes from the domain                                                                                                  |
| `BRAIN_MASTER_KEY`                                 | 32 random bytes, base64 (`head -c32 /dev/urandom \| base64`): encrypts every account's TOTP secret and backup key; lose it and they are lost                                                                   |
| `BRAIN_EMBED_URL`, `BRAIN_EMBED_MODEL`             | an Ollama-compatible API and model (`http://ollama:11434`, `bge-m3`)                                                                                                                                           |
| `BRAIN_TIMEZONE`                                   | the zone of the days of an account that has not chosen its own on `/account` (the process's `TZ`; the compose file sets `TZ` from it, `Europe/Rome`)                                                           |
| `BRAIN_CLIENT_IP_HEADER`                           | the header a proxy in front puts the client's address in, for the rate limits (`cf-connecting-ip` behind Cloudflare; none: the connection's)                                                                   |
| `BRAIN_LOG_LEVEL`                                  | how much the log says: `debug`, `info`, `warn` or `error` (`info`): one JSON line per event on stdout, and one per request (method, path without query, status, ms, id), never a token, cookie, header or body |
| `BRAIN_DATA`                                       | where `accounts.db` and `users/` live (`/data`)                                                                                                                                                                |
| `BRAIN_BACKUP_KEY`                                 | 32 random bytes, base64: seals the server's own daily copies in `BRAIN_DATA/backups` (none without it; also the administrator's backup key when the service first starts)                                      |
| `BRAIN_BACKUP_KEEP`                                | how many daily copies stay (`7`)                                                                                                                                                                               |
| `BRAIN_OPERATOR`, `BRAIN_CONTACT`, `BRAIN_HOSTING` | the public pages (`public.ts`): who runs the instance (default: the owner's name), an address that reaches them, and where the server is ("un server a Francoforte, in Germania")                              |
| `BRAIN_SITE_URL`                                   | the site's own address, another origin than the brain's (both domains on the `brain` service in Coolify); unset, the site is served on the brain's address                                                     |
| `BRAIN_DEV=1`                                      | local only: signing in without TOTP                                                                                                                                                                            |

**The first account** is made on the first start, when there is none: the administrator, with the
id `BRAIN_ADMIN_ID` (or `AGENTS_MULTI_OWNER_ID`) and the name and language of `AGENTS_MULTI_OWNER_NAME`
and `AGENTS_MULTI_LANGUAGE`, as an invitation like everyone else's: its link is written to the log (on
Coolify, the application's logs), and a new one on every start until it is accepted. No passphrase or
TOTP secret sits in the environment. (`BRAIN_PASSPHRASE` and `BRAIN_TOTP_SECRET`, where given, make a
ready account at once instead: a local run, the end-to-end test.) A service that kept one person's
brain (`/data/brain.db`) gives it to that first account: the file moves under `users/`, and the tokens
of its Claude connections and machines are carried over.

On Coolify: a Docker Compose application from this repository, base directory `/apps/brain`, compose file
`/compose.yaml` (the service and Ollama, which pulls `bge-m3` into its own volume on first start),
the domain on `brain`, `BRAIN_MASTER_KEY` and `BRAIN_ADMIN_ID` in Coolify. The repository is cloned over SSH
straight from the server's address (`git@<ip>:2222/…`): your Git host (`git.example.com`) may be behind Cloudflare,
which does not carry SSH. The secrets are made and typed in by the owner, never passed
through a chat. Behind Cloudflare, set `BRAIN_CLIENT_IP_HEADER=cf-connecting-ip` too, and let only
Cloudflare reach the server.

Or as three resources, so that redeploying one never restarts the others (the files in `coolify/`,
same base directory): `ollama.yaml` (the model, on Coolify's network as `agents-multi-ollama`, no
domain), `brain.yaml` (the service alone: the same service and volume names as `compose.yaml`, so the
application that ran the whole stack keeps its data when it switches to it) and `site.yaml` (the site
from `site.ts`, the brain's image with another command, with the site's domain and `BRAIN_URL`). A
release then redeploys the site for its update manifests and the brain for its code; the model only
when its version changes.

`/health` says the process answers; `/ready` that its accounts database does too (the container's
healthcheck, checked every two seconds while it starts, so the proxy sends traffic to a new
container seconds after it boots). Neither says more, to anyone. On SIGTERM the service stops taking
requests, lets the ones in flight finish, stops the indexers and closes every database.

Locally, with any Ollama-compatible API:

```sh
BRAIN_URL=http://127.0.0.1:8787 BRAIN_PASSPHRASE=… BRAIN_DEV=1 BRAIN_DATA=$(mktemp -d) \
  BRAIN_EMBED_URL=http://localhost:11434 PORT=8787 HOST=127.0.0.1 deno run -A apps/brain/main.ts
BRAIN_URL=http://127.0.0.1:8787 BRAIN_PASSPHRASE=… deno run -A apps/brain/tests/e2e.ts   # on an empty database
```

## Another person's brain

An account on this service: the administrator invites them from `/account` and sends the link. Their
brain is a file of its own next to the others, with its own backup key; they connect Claude to the
same address and sign in with their account. A brain that already exists elsewhere comes in as its
file: copied to `users/<id>/brain.db` before the invitation is accepted, it is what the account opens.

## Connecting

- **Claude apps and claude.ai**: Customize → Connectors → Add custom connector named **Brain**
  (the console and Hey Claude address its tools as `mcp__claude_ai_Brain__*`), URL `https://<the brain>/mcp`; sign in on the page that opens. It is then in the Android app too.
- **Claude Code**: `claude mcp add --transport http brain https://brain.example.com/mcp`, then `/mcp`
  to sign in.
- **A person's machines** (the console, backups): `agents brain-login`, or Sign in in the
  console's Connections; the token and the backup key land in the vault.
- **A browser**, a phone included: `https://<the brain>/tasks`, the board (below).

## The board

`/tasks` (`board.ts`): the person's tasks in four columns (to do, in progress, waiting, done in the
last week), late ones first and in red, with their project, ref, stage, day, progress and labels; a
filter by project and words, a line to add a task, buttons to start or finish one. `/tasks/<id>`
shows one task: its description, steps to tick, decisions and log to add to, its links to other
tasks, its attachments, and every field to change. Plain forms, no script; every change goes through
the task rules of `shared/mcp/lib/tasks.ts`, as the chats' do (a repeating task done here makes the
next one), and an edit made on a task someone changed meanwhile is refused rather than overwriting it.

## The public pages

What anyone can open without an account (`public.ts`): Agents Multi's site, the landing (`/`, `/it/`)
and the docs (`/docs/`), built from `apps/site/` (Astro and Starlight) into `apps/site/dist` by the image's first
stage; and `/privacy`, the privacy notice, for this service and for Agents Multi's Google integration
(its OAuth client points here).

With `BRAIN_SITE_URL` the site lives on an address of its own, **another origin**: nothing it runs
(its libraries, Pagefind, a compromised dependency) can act with a brain session. That address answers
with the site and the notice only; on the brain's, a page of the site is a 301 to the same path there,
`robots.txt` disallows everything and every page of the brain says `noindex`. The paths that are the
brain's (`/mcp`, `/api`, `/tasks`, `/account`…) are never looked up in the site.

The site is built with no instance in it: its address is `https://site.invalid`, and `__APP__` (the
brain's address), `__CONTACT__` and `__OPERATOR__` are placeholders the brain fills when it serves a
page, from `BRAIN_SITE_URL`, `BRAIN_URL`, `BRAIN_CONTACT` and `BRAIN_OPERATOR`. A change of substance
to the notice bumps `PRIVACY_UPDATED`. Locally, `pnpm build` in `apps/site/` before starting the brain;
`BRAIN_SITE` points elsewhere if needed.

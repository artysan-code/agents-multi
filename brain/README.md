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
  leave them out unless asked. Samuel's machines read and write them as files on `/api/tasks`
  (`shared/mcp/lib/brain-tasks.ts`): the console, the reminders and the local `tasks` tools all use
  this one list.
- **Search**: full text (SQLite FTS5) and by meaning (chunks embedded by `bge-m3` behind Ollama),
  fused by reciprocal rank. The embeddings fill in the background after each write; when the model
  is down, search answers with words alone and says so.

Each person's brain is one SQLite file, `BRAIN_DATA/users/<account>/brain.db`, opened only from
`tenants.ts` with the account a token or session gave. The accounts, their tokens and sessions are
in `BRAIN_DATA/accounts.db`.

## How it is written

Seven areas, named the way Samuel thinks: `io/` (who he is, how he works — of each page, what stands
above its first `## ` goes into the instructions every connected Claude receives), `progetti/` (one page
per project, the same path as his folder: `progetti/work/acme/site.md`), `clienti/` (who he works for, directly or through another
client: the relationship and the people, linking the projects), `persone/` (people only), `note/` (how
things are done), `diario/` (one page a day, only added to) and `inbox/` (said in passing, to sort).

Claude writes without asking, so the rules are enforced by the service (`rules.ts`, tested) and a
write that breaks one is refused with the reasons: pages in the seven areas, `io`/`clienti`/`persone`/`note`
flat; one subject per page, at most 400 words (1000 for the diary and the inbox); `# Title` and one
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
  revokes its whole family.
- **Signing in** takes the account, its passphrase and the current TOTP code. Five wrong attempts
  close that account for fifteen minutes; an id that does not exist answers the same way.
- **Machines** use personal tokens, created on `/account` (shown once, to be put in the vault) and
  revoked there. The same page lists Claude's connections and can cut them all.
- Tokens are stored as their SHA-256, never as themselves. The TOTP secrets and backup keys are
  encrypted with `BRAIN_MASTER_KEY`, which exists only in the server's environment.

## Backups

`GET /backup/state` says what the brain is at (a version that changes with every write), and
`GET /backup` with a personal token returns the whole brain as one file: a consistent copy of the
database (the WAL folded in and the file read in one go), sealed with AES-256-GCM under the
account's own backup key (shown on `/account`, to be put in the vault of each machine as
`brain/<account>` field `backup-key`): one person's copies never open with another's key. Samuel's machines check the state every half hour while they are on and fetch a copy only when
it changed (`claude-multi brain-backup`, `claude-brain-backup.timer`), keeping the last ones; without the key from the vault a copy cannot be read. No third party
holds the brain.

## Running it

| Variable | |
|---|---|
| `BRAIN_URL` | the public address, `https://brain.example.com` (OAuth names it exactly); on Coolify it comes from the domain |
| `BRAIN_MASTER_KEY` | 32 random bytes, base64 (`head -c32 /dev/urandom \| base64`): encrypts every account's TOTP secret and backup key; lose it and they are lost |
| `BRAIN_EMBED_URL`, `BRAIN_EMBED_MODEL` | an Ollama-compatible API and model (`http://ollama:11434`, `bge-m3`) |
| `BRAIN_DATA` | where `accounts.db` and `users/` live (`/data`) |
| `BRAIN_DEV=1` | local only: signing in without TOTP |

**The first account** is made on the first start, when there is none: the administrator, from
`BRAIN_ADMIN_ID` (or `CLAUDE_MULTI_OWNER_ID`), `CLAUDE_MULTI_OWNER_NAME`, `CLAUDE_MULTI_LANGUAGE`,
`BRAIN_PASSPHRASE`, `BRAIN_TOTP_SECRET` and `BRAIN_BACKUP_KEY` (made when absent). A service that kept
one person's brain (`/data/brain.db`) becomes that account: the file moves under `users/`, and the
tokens of its Claude connections and machines are carried over, so nothing has to be connected
again. After that start those variables are no longer read and can be removed.

On Coolify: a Docker Compose application from this repository, base directory `/brain`, compose file
`/compose.yaml` (the service and Ollama, which pulls `bge-m3` into its own volume on first start),
the domain on `brain`, `BRAIN_MASTER_KEY` and the first account's variables in Coolify. The repository is cloned over SSH
straight from the server's address (`git@<ip>:2222/…`): `git.example.com` is behind Cloudflare,
which does not carry SSH. The secrets are made and typed in by Samuel, never passed
through a chat.

Locally, with any Ollama-compatible API:

```sh
BRAIN_URL=http://127.0.0.1:8787 BRAIN_PASSPHRASE=… BRAIN_DEV=1 BRAIN_DATA=$(mktemp -d) \
  BRAIN_EMBED_URL=http://localhost:11434 PORT=8787 HOST=127.0.0.1 deno run -A brain/main.ts
BRAIN_URL=http://127.0.0.1:8787 BRAIN_PASSPHRASE=… deno run -A brain/tests/e2e.ts   # on an empty database
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
- **A person's machines** (the console, backups): a personal token from `/account`, kept in the vault
  with the backup key.

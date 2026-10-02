# brain

Samuel's brain as a service: his memory and his tasks in one place on his server, reached by
every Claude he uses — the Claude apps and claude.ai as a custom connector, Claude Code and Claude
Desktop as a remote MCP server — and by his machines with a personal token. There is no copy on
the machines: the brain is here.

## What it keeps

- **Documents**: Markdown with a path (`area/name.md`), linked with `[[target]]` as Obsidian
  writes them, in seven areas and by the rules below.
- **History**: every write keeps the version it replaces, with who made it (`claude:<client>`,
  `token:<machine>`) and when. A deletion is a revision too; anything can be read as it was and put
  back (`brain_history`, `brain_restore`).
- **Tasks**: one document per task under `tasks/`, with the same rules as the local tasks tools
  (`shared/mcp/lib/tasks.ts`, `shared/mcp/tasks/tools.ts`, shared code). Memory lists and searches
  leave them out unless asked.
- **Search**: full text (SQLite FTS5) and by meaning (chunks embedded by `bge-m3` behind Ollama),
  fused by reciprocal rank. The embeddings fill in the background after each write; when the model
  is down, search answers with words alone and says so.

All of it is one SQLite file in `BRAIN_DATA` (`brain.db`).

## How it is written

Seven areas, named the way Samuel thinks: `io/` (who he is, how he works — of each page, what stands
above its first `## ` goes into the instructions every connected Claude receives), `progetti/` (one page
per project, the same path as his folder: `progetti/work/acme/site.md`), `clienti/` (who he works for, directly or through another
client: the relationship and the people, linking the projects), `persone/` (people only), `note/` (how
things are done), `diario/` (one page a day, only added to) and `inbox/` (said in passing, to sort).

Claude writes without asking, so the rules are enforced by the service (`rules.ts`, tested) and a
write that breaks one is refused with the reasons: pages in the seven areas, `io`/`clienti`/`persone`/`note`
flat; one subject per page, at most 400 words (1000 for the diary and the inbox); `# Title` and one
sentence saying what the page is; at least one link to an existing page; no near copy of an
existing title (unless `distinct`); no secrets; at most 15 lines of code. Paths are normalised
(lower case, no accents). The diary and the inbox are added to (`brain_append`), never rewritten;
moving a page (`brain_move`) updates the links to it; `brain_check` lists orphans, broken links,
pages too long and an inbox left alone for a week. The numbers are meant to be tuned in use.

## Who gets in

- **Claude, through OAuth 2.1**: the MCP endpoint (`/mcp`) answers 401 with a pointer to its
  metadata; Claude registers itself (only Claude's callback or a loopback address are accepted),
  sends Samuel to `/authorize`, and gets a code bound to a PKCE S256 challenge. Access tokens last
  an hour; refresh tokens rotate, and one used twice revokes its whole family.
- **Signing in** takes the passphrase and the current TOTP code. Five wrong attempts close the door
  for fifteen minutes.
- **Machines** use personal tokens, created on `/account` (shown once, to be put in the vault) and
  revoked there. The same page lists Claude's connections and can cut them all.
- Tokens are stored as their SHA-256, never as themselves.

## Backups

`GET /backup` with a personal token returns the whole brain as one file: a consistent copy of the
database (`VACUUM INTO`), sealed with AES-256-GCM under `BRAIN_BACKUP_KEY`. Samuel's machines fetch
it and keep the last ones; without the key from the vault a copy cannot be read. No third party
holds the brain.

## Running it

| Variable | |
|---|---|
| `BRAIN_URL` | the public address, `https://brain.example.com` (OAuth names it exactly); on Coolify it comes from the domain |
| `BRAIN_PASSPHRASE` | 12 characters or more |
| `BRAIN_TOTP_SECRET` | base32; `deno run brain/main.ts totp` makes one and the line for the authenticator app |
| `BRAIN_BACKUP_KEY` | 32 random bytes, base64 (`head -c32 /dev/urandom \| base64`); without it `/backup` is off |
| `BRAIN_EMBED_URL`, `BRAIN_EMBED_MODEL` | an Ollama-compatible API and model (`http://ollama:11434`, `bge-m3`) |
| `BRAIN_DATA` | where `brain.db` lives (`/data`) |
| `BRAIN_DEV=1` | local only: signing in without TOTP |

On Coolify: a Docker Compose application from this repository, base directory `/brain`, compose file
`/compose.yaml` (the service and Ollama, which pulls `bge-m3` into its own volume on first start),
the domain on `brain`, the three secrets as Coolify variables. The repository is cloned over SSH
straight from the server's address (`git@<ip>:2222/…`): `git.example.com` is behind Cloudflare,
which does not carry SSH. The secrets are made and typed in by Samuel, never passed
through a chat.

Locally, with any Ollama-compatible API:

```sh
BRAIN_URL=http://127.0.0.1:8787 BRAIN_PASSPHRASE=… BRAIN_DEV=1 BRAIN_DATA=$(mktemp -d) \
  BRAIN_EMBED_URL=http://localhost:11434 PORT=8787 HOST=127.0.0.1 deno run -A brain/main.ts
BRAIN_URL=http://127.0.0.1:8787 BRAIN_PASSPHRASE=… deno run -A brain/tests/e2e.ts   # on an empty database
```

## Connecting

- **Claude apps and claude.ai**: Customize → Connectors → Add custom connector, URL
  `https://brain.example.com/mcp`; sign in on the page that opens. It is then in the Android app too.
- **Claude Code**: `claude mcp add --transport http brain https://brain.example.com/mcp`, then `/mcp`
  to sign in.
- **Samuel's machines** (the console, backups): a personal token from `/account`, kept in the vault.

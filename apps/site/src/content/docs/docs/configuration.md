---
title: Configuration
description: The folder that holds what is yours (profiles, accounts, rules, preferences), apart from the code.
---

Everything that is yours lives in one folder, apart from the code. `agents init <folder>` (or the
first-run wizard) makes it from the repository's
[`config.example/`](https://github.com/artysan-code/agents-multi/tree/release/config.example) and
links `~/.agents-multi/config` to it. The code stays the same for everyone; this folder is the part
that is different for you.

```
~/.agents-multi/config → your folder
  owner.json           id, name, language
  profiles/<name>/     profile.json, CLAUDE.md, settings.json, skills/ agents/ commands/
  settings.json        what every profile gets
  servers.json         your choices over the MCP servers
  accounts.json        the accounts those servers use (no secrets)
  rules/               your rules, imported by each profile's CLAUDE.md
  icons/<size>/        claude-desktop-<profile>.png
```

## owner.json

Who you are: `id` (the owner written in your tasks: choose it once and keep it), `name`, and
`language` (the one Claude answers in).

```json
{ "id": "me", "name": "Your name", "language": "English" }
```

## Profiles

Each folder under `profiles/` with a `profile.json` is a profile ([Profiles](/docs/profiles/)).
The manifest's fields:

| Field | Meaning |
| --- | --- |
| `description` | a line for you |
| `command` | the launcher name; omitted, it is `claude-<name>` |
| `alias` | a shell alias for the launcher |
| `skills`, `agents`, `commands` | `"all"` mounts the shared directory, a list only those entries (plus what the profile owns) |
| `desktopDir` | the profile's own Claude Desktop data directory |
| `disableAccountMcp` | switches off the connectors and plugins the account's organisation brings in |
| `brainScope` | for a work profile on an account others administer: of your brain it sees only the tasks of these projects (comma-separated folder prefixes), and no memory pages |

Next to the manifest, a profile can have:

- `CLAUDE.md` — its instructions, which can import files from `rules/`.
- `settings.json` — that profile's differences from everyone else's.
- `skills/`, `agents/`, `commands/` — what only this profile has.

## Settings and servers

`settings.json` and `servers.json` are **merge patches** over the repository's own
`shared/settings.json` and `shared/mcp/servers.json` (RFC 7386): objects merge, anything else
replaces, and `null` removes.

- `settings.json` — what every profile gets. A profile's own `settings.json` is patched on top. The
  result is generated into each profile's runtime folder; what Claude Code writes there at run time
  is adopted back into the profile's file on the next regeneration. See [Profiles](/docs/profiles/).
- `servers.json` — which MCP servers are on, and for whom. The registry's servers are templates, all
  off: one tied to an account turns on with an account in `accounts.json`, any other with
  `"<server>": { "_profiles": null }` (every profile) or a list of profile names. Servers of your own
  go here too, `"<name>": { "command": …, "args": … }`.
- `accounts.json` — the accounts those servers use: service, a short name, the address, and the
  profiles that see it (none means every profile). **No secrets**: they go in the vault
  (`agents vault set <service> <account>` or console › Connections). See
  [MCP and the vault](/docs/mcp-and-vault/).

## Rules and icons

`rules/` holds your rules as Markdown files; each profile's `CLAUDE.md` imports the ones it wants.
`icons/<size>/claude-desktop-<profile>.png` is the icon of a profile that has its own Claude Desktop.

## Keeping it in step between machines

Keep the folder the same on every machine of yours, with Syncthing or a private git repository. Two
edits that collide in Syncthing leave a `.sync-conflict-` copy, and `agents doctor` reports it. The
wizard links a folder that already holds a configuration instead of making a new one.

Do not put `~/.agents-multi` itself in a synced folder: it is the runtime, and it holds logins.

## Environment variables

The variables are `AGENTS_MULTI_<NAME>`. The ones you may set:

| Variable | What it does |
| --- | --- |
| `AGENTS_MULTI_ROOT` | where the runtime lives (`~/.agents-multi`) |
| `AGENTS_MULTI_CONFIG` | your configuration folder |
| `AGENTS_MULTI_PORT` | the console's port |
| `AGENTS_MULTI_VAULT` | the vault's directory |
| `AGENTS_MULTI_OWNER_ID`, `AGENTS_MULTI_OWNER_NAME`, `AGENTS_MULTI_LANGUAGE` | the owner, when not read from `owner.json` |
| `AGENTS_MULTI_FETCH_TTL`, `AGENTS_MULTI_FETCH_TIMEOUT` | how often and how long a checkout fetches (dev mode) |

The full list, which also has `TASKS`, `BRAIN`, `ACCOUNTS`, `PROFILE`, `BRAIN_SCOPE`, `REPO` and
`NO_ASSISTANT_TRAILER`, is in the repository's
[README](https://github.com/artysan-code/agents-multi/blob/release/README.md#environment-variables).
The old `CLAUDE_MULTI_<NAME>` names are still read when the new one is not set.

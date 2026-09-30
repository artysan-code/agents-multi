# claude-multi

Run several **Claude Code** and **Claude Desktop** accounts on one Linux machine, without them
seeing each other. Shared configuration is versioned in git, updates need explicit approval, and a
local console shows what every profile is doing.

**This repository is the source of truth.** `~/.claude-multi/` is runtime materialised by
`claude-multi install`; `~/.local/bin/claude*` are symlinks into `bin/`. Configuration travels
between machines over **git** — never over a file-sync tool, because the runtime directories hold
credentials.

---

## Getting started

```bash
git clone <your fork> ~/.local/src/claude-multi
~/.local/src/claude-multi/bin/claude-multi install
```

`install` is idempotent and reversible: it never deletes real content, it moves it aside to
`*.pre-repo-<stamp>` and says so. Run `install --dry-run` first if you want to read the plan.

Then sign in to each profile and check the result:

```bash
claude              # the default profile → /login
claude-multi doctor # every invariant, each with a fix
```

The console is enabled as a systemd user unit by `install`, so it is already running on
<http://127.0.0.1:7331>. On a desktop, the **claude-multi** app starts in the tray at login and
opens it in a window of its own.

Requirements: `deno`, `git`. For Claude Desktop also `gnupg`, `binutils` (`ar`), `libarchive`
(`bsdtar`) and `@electron/asar` (the profile variants), plus `base-devel` once, for the shims
package. For the desktop app `pyside6` **and** `qt6-webengine` —
the second is only an optional dependency of the first on Arch, so install it explicitly. OAuth credentials are per-machine and never leave it.

### Making it yours

A fork starts with the profiles and servers of whoever you forked. Three directories are *content*,
not code, and are meant to be replaced:

| Directory | What it holds |
|---|---|
| `profiles/<name>/` | one directory per profile: `profile.json` (the manifest), `CLAUDE.md`, any skills the profile owns, and optionally `settings.json` — its differences from the shared settings |
| `shared/` | what every profile gets: rules, skills, agents, commands, hooks, `settings.json`, the MCP registry |
| `shared/mcp/servers.json` | the MCP registry — the servers, and which profiles and surfaces see them |

Everything under `cli/`, `bin/`, `systemd/` and `lib/` is the machinery, and reads those three.

---

## Profiles

A profile is a directory under `profiles/` containing a `profile.json`. That is the whole
definition — there is no list of profile names anywhere in the code, so adding a third one is a
matter of adding a directory.

```json
{
  "description": "Research profile.",
  "command": "claude-research",
  "alias": "cr",
  "desktopDir": "~/.config/Claude-Research",
  "skills": ["graphify"],
  "agents": "all",
  "commands": "all"
}
```

`command` is the launcher name, and `install` creates it: there is one launcher script,
`bin/claude`, linked into `~/.local/bin` once per profile. It works out which profile to start
from the name it was invoked as, so a profile adds no file to `bin/`. Omit `command` and it
answers to `claude-<name>`; the profile whose command is plain `claude` is the machine default.
`alias` is optional and lands in the managed `~/.zshrc` block.

`"all"` mounts the whole shared directory as one symlink; a list mounts only those entries, plus
whatever the profile owns in `profiles/<name>/<kind>/`. Owning a skill is how work that must not
leak into another profile stays put: `install` materialises it, and `doctor` reports it as a
failure if it shows up somewhere else.

`"disableAccountMcp": true` switches off what the account brings in: the claude.ai connectors
and the plugins the organisation syncs (`<name>@synced`). It goes into the profile's generated
`settings.json` (below), so it holds in the CLI and in Desktop's Code tab alike. `bin/claude` also
passes it as a `--settings` overlay rebuilt at each launch from the sync manifests, which catches
a plugin the organisation adds between two regenerations; `claude-launch` passes
`ENABLE_CLAUDEAI_MCP_SERVERS=false` to Desktop. The Desktop chat takes its connectors from the
claude.ai account and is not affected. It is the **Account MCP** checkbox in the console.

### Settings: generated per profile

Each profile's `settings.json` is a generated file, not a link:

```
shared/settings.json          what every profile gets
profiles/<p>/settings.json    that profile's differences, as a JSON Merge Patch (RFC 7386:
                              objects merge, anything else replaces, null deletes the key)
profiles/<p>/profile.json     what the manifest implies (disableAccountMcp)
  → ~/.claude-multi/<p>/settings.json
```

It has to be per profile because of plugins: Claude Code installs every plugin `enabledPlugins`
marks true when a session starts, so a plugin is off for one profile only if that profile's own
file says so. Claude Code also writes into this file (`/plugin`, `/config`): before regenerating,
the difference from the last generated copy (kept in `~/.local/state/claude-multi/settings/`) is
**adopted** into `profiles/<p>/settings.json`, so nothing is lost and the change stays with the
profile it was made in. To give it to every profile, move it into `shared/settings.json`.

`claude-multi settings` regenerates (and adopts); `install` does the same, and so does every launch
when Deno is there and a source is newer than the last run (`bin/lib/prelaunch.sh`). The doctor
reports a file Claude wrote into and that is not adopted yet, and one that is behind its sources.

### Plugins

The console's **Plugins** view is the plugin manager. The repository decides which plugin is on
where: `enabledPlugins` in `shared/settings.json` for every profile (the **All** column), in
`profiles/<p>/settings.json` for one (a profile's column; each cell cycles inherit → on → off). The
marketplaces are the shared `extraKnownMarketplaces`. Claude Code owns the runtime — plugin cache,
marketplace clones — and every change there goes through its CLI (`claude plugin … --json`),
never by editing its files.

- **Install** from the catalog (every marketplace the profiles know, searchable) on every profile
  or on one; **Update**, **Remove** (from every profile), **Details** (components and token cost).
- Turning a plugin on installs it right away where the change reaches; otherwise Claude installs
  it at the next session start. Off means `false` in that profile's file, so it is not reinstalled.
- A declared marketplace a profile has never registered (a profile not opened since) is
  registered before installing from it.
- A marketplace-declared command (a command-source install or update) is shown on the page and
  runs only if you accept it there: the server never accepts one on its own.
- The organisation's synced plugins and the claude.ai skills synced into each profile are listed
  read-only: the plugins follow **Account MCP**.

The doctor fails on an installed plugin whose files are gone (records hold absolute paths, so a
moved profile directory breaks them). A project or local record whose project directory is gone
is only a warning: it loads nowhere, and the CLI can remove it only from inside that project.

`desktopDir` is where Claude Desktop keeps that profile's data. Omit it and the convention applies:
`~/.config/Claude-<Name>` when it exists, otherwise Desktop's own `~/.config/Claude`.

The easiest way to add one is the console: **Profiles → Add profile** writes the manifest, updates
the MCP registry, and runs `install`. Then open the new launcher once and sign in — credentials are
the one thing no manifest can carry.

Renaming a profile is not a console operation, because it moves things `install` does not own: the
runtime directory `~/.claude-multi/<name>` with its credentials and transcripts, the Desktop data
dir, and the profile column already recorded in `usage.db`. Do it from a terminal with Claude
closed, then run `claude-multi install` and `claude-multi doctor`.

---

## Commands

| Command | What it does |
|---|---|
| `claude` | Claude Code on the default profile |
| `claude-work` | Claude Code on the `work` profile (each profile can declare its own `command`) |
| `claude-multi install [--dry-run]` | materialise runtime, wrappers, systemd units and desktop entries from the manifests. Idempotent |
| `claude-multi settings [--dry-run]` | regenerate each profile's `settings.json`, adopting into `profiles/<p>/settings.json` what Claude wrote into it |
| `claude-multi doctor [--json\|--notify]` | verify every invariant and say how to fix it; `--notify` raises a desktop notification only when a *new* failure appears, or when everything clears |
| `claude-multi status [--json]` | versions, available updates, repository sync, what is mounted per profile, running instances. The JSON contract for the statusline, the tray and the console |
| `claude-multi sync [--fetch]` | align the repository from the remote (fetch when stale, ff-only pull on a clean tree) |
| `claude-multi mcp check\|sync\|health` | apply the MCP registry to every profile and surface; `health` verifies binaries, files and dependencies, `--probe` really starts each server |
| `claude-multi update [--cli\|--desktop\|--check\|--rollback]` | update Claude Code and/or Claude Desktop |
| `claude-multi usage [--by …] [--since …]` | tokens and list-price estimate by profile, model, project, agent, day, **skill**, **command** (SQLite) |
| `claude-multi serve [--no-open]` | the console on `http://127.0.0.1:7331` (normally already running as a unit) |
| `claude-launch <profile>` | the entry point desktop launchers use: repository sync, a staged Desktop version switched in, then the app |
| `claude-multi-app [--tray]` | the desktop app: console window and tray icon (below) |

`claude update` inside a wrapper is redirected to `claude-multi update --cli`: the native updater
would rewrite `~/.local/bin/claude` and leave `claude-bin` behind.

---

## The console

`claude-multi install` enables `claude-multi-console.service`, so the console is always at
<http://127.0.0.1:7331>. It is not tied to a graphical session — over an ssh tunnel it works
exactly the same, which is the point on a headless box.

Updates are **pushed, not polled**: the server watches the transcript tree and the shared config,
and the page redraws the view you are actually looking at. The page itself is HTML, CSS and
vanilla JS with no dependencies and no external assets, so it renders on a machine that has never
been online.

Four sections, in English or Italian. The language follows the machine's locale — the regional
format (`LC_TIME`) outranks `LANG`, so English messages with Italian formats open in Italian — and
the globe button in the rail overrides it per browser.

- **Today** (`#today`) — the tray's verdict in words (what needs you, if anything), the sessions
  running now, and the last sessions per directory with the command that reopens each one.
- **Brain** (`#brain`) — the wiki (`~/brains/claude`, `CLAUDE_MULTI_BRAIN`) as a graph of its pages
  and their links, searchable, each page readable in place or opened in Obsidian. A view, not an
  editor: what you add (a document, a link, a note) waits in `_raw/`, and Claude distils it with
  `/wiki-ingest` when asked, confirming before it writes.
- **Connections** (`#connections`) — every MCP server in the registry, which profiles see it and
  where, and whether each profile actually mounted it at its last sync.
- **System** (`#system/<tab>`) — **Profiles** (what each one mounts and is signed in as; edit or
  add), **Permissions** (the shared allow / ask / deny rules and default mode, what each profile
  adds or leaves out — "always allow" answers land there — and a button to move a profile's own
  rules to every profile), **Plugins & skills**, **Updates** (versions, and what is pending), **Health** (every doctor
  check, with a button for the fixes that map to a known action).

Consumption is not on the page: `claude-multi usage` reports it in the terminal.

`⌘K` / `Ctrl-K` opens a command palette with every view and every action. Actions run against the
local CLI through `POST /api/action` behind an allowlist and an anti-CSRF header. Updating and
rolling back are actions like the others: nothing in them needs root.

---

## The desktop app

`claude-multi-app` (`lib/claude-multi-app/`, PySide6) makes the console an application. It is a
**view**, like everything that is not the CLI: its state is the console's, its actions are the
commands a terminal would run. The console server stays its own unit, so a browser or an ssh
tunnel still reaches it.

- **Window** — the console in a window with its own icon and menu entry (`claude-multi`). Links
  that leave it open in the system browser. With the server down it says so and offers to start
  it. Closing the window destroys it: the web engine is the heavy part, and the tray alone stays
  light.
- **Tray** — the state at a glance, from `/api/summary` (a pure function of `status`, tested):
  no dot when all is well, **red** for a failing doctor check,
  **grey** when the console does not answer. Warnings are listed, not coloured: some are standing
  conditions of a machine, and an icon that is always yellow says nothing. It refreshes on the
  console's `state` events and when the menu opens, never on a timer. The menu opens the console,
  a profile's Claude Desktop, the Updates tab and the Health view. A Claude Desktop version waiting
  to switch is listed there, not coloured: it needs nothing from you.
- **At login** — `claude-multi-app.service` (graphical session only, enabled by `install`) runs
  `--tray`. One instance per session: a second start hands its request to the first over
  `$XDG_RUNTIME_DIR/claude-multi-app.sock` and exits.

Without a system tray (GNOME needs the AppIndicator extension) the windows still work and the app
quits with the last one; `--tray` waits a minute for a tray to appear, then exits cleanly and the
doctor says why. After pulling new app code: `systemctl --user restart claude-multi-app`.

---

## Consumption

`claude-multi usage` reports tokens by profile, model, project, agent, day, skill or command, with
what they would cost at list price. On a subscription tokens are not billed one by one, so that
figure is for comparing, not accounting. Nothing here watches billing or raises alerts on spending.

---

## Skills and commands in `usage`

A skill consumes no tokens by itself: it makes the turn that uses it consume them. The **turn**
(from one human prompt to the next, subagents included) is the well-defined unit available, so the
turn's cost is split evenly across the skills and slash commands appearing in it. `uses` counts
invocations, `estimate` is the share. It is an approximation and it is declared as one, in the CLI
and in the console. Messages outside any turn are excluded and counted separately.

```bash
claude-multi usage --by skill --since 30d
claude-multi usage --by command --since all
```

---

## MCP

One registry, `shared/mcp/servers.json`. Per server, `_profiles` (default: all) and `_surfaces`:

- `cli` → the profile's `.claude.json`, read by Claude Code and by the copy embedded in Desktop
- `desktop` → that profile's `claude_desktop_config.json`, read by the Desktop chat

`claude-multi mcp sync` applies the registry to every surface with a non-destructive merge: only
registry-managed servers are touched, hand-added ones survive. It refuses to run while an instance
that would rewrite the file is open (`--force` overrides), backs up into
`~/.local/state/claude-multi/`, and keeps its per-machine state out of the repository.

`mcp health` checks binaries, files, lock files and dependencies. `mcp health --probe` actually
starts each server and waits for its `initialize` reply, which catches what static checks cannot —
native modules built for the wrong Node ABI, missing environment, cold-start crashes.

Servers written in-house live in `shared/mcp/<name>/` (Deno, least privilege). The ones that work on
an external service share `shared/mcp/lib/`: `coolify` and `n8n` today.

### Accounts and the secret vault

- **Accounts** are listed in `shared/mcp/accounts.json`, with no secret in it: service, a short
  name, the address, and the profiles that see it (none = every profile). A profile can see several
  accounts of one service; each tool then takes `account`, required as soon as there is more than
  one — never a silent default. A registry entry with `_service` goes only to the profiles that see
  one of that service's accounts, with `CLAUDE_MULTI_PROFILE` in its environment and `{hosts}` in
  its arguments replaced by those accounts' hosts (its `--allow-net`).
- **Secrets** are in the vault, `~/vault/claude-multi` (a Syncthing folder: they travel between
  machines already encrypted, ark relays them without reading them). One file per secret,
  AES-GCM with a fresh IV per write, named by an HMAC so the names say nothing. The key is in each
  machine's keyring (Secret Service: KWallet here), so nothing is typed at login.
- **Deleting** a secret rewrites it as a tombstone instead of removing the file: through an encrypted
  relay a removal can lose against a concurrent modification and come back, a write cannot.
- **Machines**: `claude-multi vault init` on the first one prints a recovery code — keep it outside the
  machine. Every other machine runs `claude-multi vault pair` with it. Never restore the vault
  directory from a backup onto a reinstalled machine: pair it and let Syncthing bring the entries.
- **Adding an account**: console › Connections (the secret is checked against the service before it
  is stored, and never comes back to the page), or `claude-multi vault set <service> <account>`
  with the secret on stdin. A secret is never a command-line argument and never a tool result.

### Local inference (the wiki's semantic search)

`wiki-claude` embeds through `llama-embed-shim` (the Ollama API on `:11434`) in front of
`llama-server` (`llama-embed.service`, `:8090`), built from source with Vulkan into
`~/.local/opt/llama-vulkan`; `install` enables both units once that binary exists. The search index
is per machine (`~/.local/share/obsidian-brain`), so machines may embed with different models — as
long as the vectors stay 1024-wide, the size `shared/mcp/servers.json` declares.

The unit's defaults are the desktop's (bge-m3 on the discrete GPU). A machine overrides them in
`~/.config/claude-multi/llama.env`, which stays on that machine:

```
EMBED_HF=Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0   # model (Hugging Face repo:quant)
EMBED_POOLING=last                             # what that model expects
EMBED_CTX=8192
EMBED_BATCH=8192
EMBED_UBATCH=1024                               # a causal model can take a chunk in pieces: the compute buffer shrinks
EMBED_PARALLEL=1
GGML_VK_VISIBLE_DEVICES=1                       # which Vulkan device (llama-server --list-devices)
GEN_UNIT=                                       # empty: no generation model here, the distiller waits
```

With `GEN_UNIT` empty the shim answers 503 to `/api/generate` instead of starting
`llama-generate.service`, whose 8B model does not fit a small machine.

---

## Repository layout

```
bin/            wrappers and scripts: claude, claude-work, claude-multi, claude-launch, claude-update, …
bin/lib/        prelaunch.sh — repository sync before every launch (pure bash, never blocking)
cli/            the claude-multi CLI (Deno, zero dependencies)
cli/dashboard/  the console page (HTML/CSS/JS, no build step)
shared/         config shared across profiles: agents, commands, hooks, skills, rules, mcp, settings.json
profiles/       one directory per profile: manifest, CLAUDE.md, owned entries
lib/            the desktop app: tray and console window (PySide6)
systemd/user/   console unit, update-check timer, optional local inference units
desktop/        .desktop entries and icons
pkg/            the pinned Anthropic apt key, and claude-desktop-shims (the system half of Claude Desktop)
```

Runtime, generated by `install`:

```
~/.claude-multi/
  shared         → <repo>/shared
  marketplaces/  plugin marketplace clones (per-machine, re-clonable)
  <profile>/     CLAUDE.md, hooks, skills, agents, commands → shared or the repo
                 settings.json — generated: shared ⊕ profiles/<p>/settings.json ⊕ the manifest
                 .claude.json, .credentials.json (600), projects/  — per-machine, never committed
```

---

## How it travels between machines

- One machine is where you work and commit. **Pushing is never automatic.**
- On every launch, `bin/lib/prelaunch.sh` fetches if the last fetch is over 12 h old (3 s timeout),
  and pulls `--ff-only` when the tree is clean and behind. Claude then starts with the new config —
  no restart needed. Offline, or with diverged history, it starts anyway and touches nothing.
- The result lands in `~/.cache/claude-multi/sync.json` and in the statusline: `cfg ↓3` behind,
  `cfg ↑1` unpushed, `cfg ✎2` uncommitted, `cfg ≠` diverged, `cfg offline`.
- `claude-multi sync --fetch` forces a fetch — useful on a laptop before starting.

---

## Updates

Everything updates itself, in the background, with no approval and no window. `DISABLE_AUTOUPDATER=1`
stays set everywhere: the updates are driven from here, not by each binary on its own.

- **Timer**: `claude-update-check.timer` (10 min after login, then every 4 h) runs
  `claude-update --auto`, then `doctor --notify`. Nice and idle I/O: it should not be felt.
- **Claude Code** is installed as soon as a new version is out. The native updater downloads into
  `~/.local/share/claude/versions/X.Y.Z`; `claude-update` re-points `claude-bin`, restores the
  wrapper, prunes old versions (keeping N-1) and fixes the `claude-cli://` handler. Open sessions
  keep running on the version they started with.
- **Claude Desktop** lives in user space, `~/.local/lib/claude-desktop/versions/<ver>` with
  `current` pointing at the one in use — no root at any step. `claude-desktop-update` *stages* a
  new version (download, verify, extract) at any time, and *applies* it (flip `current`, rebuild
  each profile's variant, install the icons) only when no Claude Desktop runs: replacing files
  under a running Electron app crashes it. `claude-launch` applies a staged version right before it
  starts the app, so in practice an update lands at the next launch. The previous version is kept.
- **Rollback**: `claude-multi update --rollback [--desktop]`, or the button in System › Updates.
- **Log**: every result is a line in `~/.local/state/claude-multi/updates.jsonl`, shown in
  System › Updates. The doctor turns a failed last attempt into a warning, a failed verification
  into a failure.
- **Supply chain**: the apt repository key is pinned in `pkg/claude-desktop/anthropic-apt.asc`.
  The `InRelease` signature is checked against it with `gpgv`, then the `Packages` index hash, then
  the `.deb` hash from that index. Anything missing or different stops the update before a file is
  extracted, and raises the only notification the updater ever sends.
- **System half**: `pkg/claude-desktop-shims` holds the runtime dependencies and the links the app
  expects at Debian paths (virtiofsd, OVMF). It is installed once and never changes.
  `claude-desktop-migrate` moves a machine that still has the old system package: run it once, in
  a terminal, with every Claude Desktop closed.

---

## Development

```bash
deno task check   # type-check the CLI and tests, bash -n every script, py_compile the app
deno task test    # usage (rates, dedupe, turns), notifications,
                  # mcp, manifests, changelog, prelaunch against real git repositories
```

- **Pre-commit** (`.githooks/pre-commit`, wired up by `install`): blocks staged state or credential
  files and added lines that look like tokens, then runs `deno task check` when scripts or
  TypeScript changed. Deliberate bypass: `git commit --no-verify`.
- **CI** (`.forgejo/workflows/ci.yml`): check, test and a secret scan of the whole tree on every
  push. Needs a runner with the `docker` label.
- Every new invariant goes in `cli/doctor.ts` — the README describes, the doctor verifies. Every new
  pure function gets a test in `cli/tests/`.

---

## Don't

- Write into `~/.claude/` (it is a read-only stub) or change its permissions.
- Edit `~/.claude-multi/shared` outside the repository — it is a symlink into it.
- Run `claude update` or `claude-bin update` by hand; use `claude-multi update`.
- Put `~/.claude-multi` into a file-sync folder: it holds credentials, and backups containing
  tokens have leaked that way before.
- Update Claude Desktop with the app open.

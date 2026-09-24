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
<http://127.0.0.1:7331>.

Requirements: `deno`, `git`. For Claude Desktop packaging also `base-devel`, `libarchive`,
`pyside6`, `@electron/asar`. OAuth credentials are per-machine and never leave it.

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
moved profile directory breaks them).

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
| `claude-multi status [--json]` | versions, available updates, repository sync, what is mounted per profile, running instances. The JSON contract for the statusline, the gate and the console |
| `claude-multi sync [--fetch]` | align the repository from the remote (fetch when stale, ff-only pull on a clean tree) |
| `claude-multi mcp check\|sync\|health` | apply the MCP registry to every profile and surface; `health` verifies binaries, files and dependencies, `--probe` really starts each server |
| `claude-multi update [--cli\|--desktop\|--check\|--rollback]` | update Claude Code and/or Claude Desktop |
| `claude-multi usage [--by …] [--since …]` | tokens and list-price estimate by profile, model, project, agent, day, **skill**, **command** (SQLite) |
| `claude-multi budget [--notify]` | consumption thresholds. Only billed extra usage raises an alert |
| `claude-multi serve [--no-open]` | the console on `http://127.0.0.1:7331` (normally already running as a unit) |
| `claude-launch <profile>` | the entry point desktop launchers use: repository sync, update gate, then the app |

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

- **Overview** — three separate readings, deliberately not side by side as if they were the same
  kind of number: **Extra usage** (what you are charged), **Plan windows** (your subscription
  allowance, and when it resets), **Tokens used** (consumption, and what it would have cost at list
  price). Each says how old its reading is, because the billing cache is often stale.
- **Profiles** — what each profile mounts and is signed in as; edit a profile, or add one.
- **Usage** — by project, model, skill, command or agent, over any window.
- **Sessions** — recent sessions; select one to read its transcript, with the tools each turn used
  and what that turn cost.
- **Health** — every doctor check, with a button for the fixes that map to a known action.

`⌘K` / `Ctrl-K` opens a command palette with every view and every action. Actions run against the
local CLI through `POST /api/action` behind an allowlist and an anti-CSRF header. Updating is
deliberately *not* an action: it goes through the polkit gate.

---

## What you actually pay for

This is the part most usage tooling gets wrong, this one included until recently. Consumption lives
on three planes and they are not interchangeable:

| Plane | What it is | Alerts? |
|---|---|---|
| **billed** | extra-usage credits, in real currency | yes — the only plane that can |
| **plan** | how full a subscription window is | no: it says when you will be throttled, not what you will pay |
| **estimate** | what the same tokens would cost at list price | never |

On a subscription, tokens are not billed per token. The "cost" `usage` reports is a list-price
equivalent — useful to compare profiles, models and days, worthless as accounting. Alerting on it
means an alert every single day for money nobody is charged.

So the plane belongs to the **metric**, not to the profile. Every profile is a subscription that
may also spend credits; nothing is hardwired per profile. Rules live in
[`shared/budget.json`](shared/budget.json):

```json
{ "id": "billed-month", "metric": "billed.month.percent", "warn": 60, "crit": 85 }
```

Metrics are `billed.today`, `billed.month`, `billed.month.percent`, `plan.<kind>.percent` and
`estimate.day|week|month`. Billed metrics notify by default; the other two stay silent unless a
rule sets `"notify": true`. A per-profile `"cap"` overrides the reported monthly ceiling, so you
can hear about it well before the real limit.

Two details that matter:

- Claude Code refreshes the billing cache when it feels like it — here it has been weeks stale. A
  stale reading **never** fires an alert, and the doctor says so.
- Every reading is sampled into `credit_samples` (usage.db). Today's billed spend is the delta
  between two samples, and it is the only figure in real currency in the whole system.

`--notify` (from the timer, every 4 h) alerts only on a threshold rising or clearing, with a
cooldown and a quiet window. `--dry-run` does not consume the state.

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

Servers written in-house live in `shared/mcp/<name>/` (Deno, least privilege, secrets read from
`~/.config/secrets/`).

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
lib/            the update GUI (PySide6)
systemd/user/   console unit, update-check timer, optional local inference units
desktop/        .desktop entries and icons
pkg/            PKGBUILD repackaging Anthropic's official .deb of Claude Desktop for Arch
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

Nothing updates without approval; `DISABLE_AUTOUPDATER=1` is set everywhere.

- **Claude Code**: the native updater downloads into `~/.local/share/claude/versions/X.Y.Z` and
  rewrites `~/.local/bin/claude`. `claude-update --cli` drives it, re-points `claude-bin`, restores
  the wrapper, prunes old versions (keeping N-1 for `--rollback`) and fixes the `claude-cli://`
  handler.
- **Claude Desktop**: `claude-desktop-update` rebuilds the Arch package from Anthropic's official
  `.deb`, then regenerates each profile's variant (a separate `app.setDesktopName` so icons and
  app ids stay distinct on Wayland; everything else symlinks to the system install).
- **Graphical gate**: `claude-launch` checks versions (6 h cache) and opens the update GUI before
  the app when needed, with the release notes and install through `pkexec`. Desktop must be updated
  with the app closed.
- **Timer**: `claude-update-check.timer` (10 min after login, then every 4 h) raises a notification
  and never updates anything by itself. The same timer runs `doctor --notify` and `budget --notify`.
- **Supply chain**: the apt repository key is pinned in `pkg/claude-desktop/anthropic-apt.asc`.
  `claude-desktop-update` verifies the `InRelease` signature against it with `gpgv`, then the
  `Packages` index hash, then the `.deb` hash from that index. The chain is complete down to the
  package.

---

## Development

```bash
deno task check   # type-check the CLI and tests, bash -n every script, py_compile the GUI
deno task test    # usage (rates, dedupe, turns), budget (planes, thresholds, notifications),
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

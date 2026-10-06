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

The repository is code; what is yours — profiles, accounts, rules, preferences — lives in a folder
of yours that `~/.claude-multi/config` links to (see [Your configuration](#your-configuration)).

```bash
git clone <the repository> ~/.local/src/claude-multi
~/.local/src/claude-multi/bin/claude-multi init ~/claude-multi-config --name Ann --language Italian
~/.local/src/claude-multi/bin/claude-multi install
```

On a second machine of yours, `init` the same folder once it is there (Syncthing, a private git
repository): it only links it. `install` is idempotent and reversible: it never deletes real content, it moves it aside to
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

### First run

Someone new is best guided by a Claude Code session following [ONBOARDING.md](ONBOARDING.md).

1. `claude-multi init <folder>` — your configuration, from `config.example/`; edit `owner.json` and
   `profiles/` (one folder per Claude account).
2. `claude-multi install` — the runtime, the launchers, the console and the tray app.
3. `claude-multi vault init` — the secret vault; keep the recovery code somewhere safe. Then each
   account's secret: `claude-multi vault set <service> <account>`, or the console's Connections.
4. `claude` (and each profile's command) — sign in with `/login`.
5. Optionally your own brain: an instance of `apps/brain/` on your server (`apps/brain/README.md`), its address
   as a `brain` account in `accounts.json`, then `claude-multi brain-login` (or Sign in, console ›
   Connections) puts its token and backup key in the vault.
6. `claude-multi mcp sync` with Claude closed, then `claude-multi doctor`.

### Your configuration

```
~/.claude-multi/config → your folder
  owner.json           id (the owner written in your tasks), name, language
  profiles/<name>/     profile.json (the manifest), CLAUDE.md, settings.json, skills/ agents/ commands/
  settings.json        what every profile gets, over shared/settings.json (a JSON Merge Patch)
  servers.json         your choices over shared/mcp/servers.json: which templates are on, for whom; your own servers
  accounts.json        the accounts the servers use (no secrets: those are in the vault)
  rules/               your rules, imported by each profile's CLAUDE.md
  icons/<size>/        claude-desktop-<profile>.png, for a profile with its own Desktop
```

Keep it in step between your machines; Syncthing leaves a `.sync-conflict-` copy when two edits
collide, and the doctor reports it. Everything under `apps/cli/`, `bin/`, `systemd/`, `lib/` and
`shared/` is the machinery, the same for everyone who uses the repository.

---

## Profiles

A profile is a directory under your configuration's `profiles/` containing a `profile.json`. That is the whole
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
shared/settings.json                 the setup's own: hooks, statusline, the safety rules
config/settings.json                 yours: what every profile gets, as a JSON Merge Patch over it
                                     (RFC 7386: objects merge, anything else replaces, null deletes)
config/profiles/<p>/settings.json    that profile's differences, the same kind of patch
config/profiles/<p>/profile.json     what the manifest implies (disableAccountMcp)
  → ~/.claude-multi/<p>/settings.json
```

It has to be per profile because of plugins: Claude Code installs every plugin `enabledPlugins`
marks true when a session starts, so a plugin is off for one profile only if that profile's own
file says so. Claude Code also writes into this file (`/plugin`, `/config`): before regenerating,
the difference from the last generated copy (kept in `~/.local/state/claude-multi/settings/`) is
**adopted** into `config/profiles/<p>/settings.json`, so nothing is lost and the change stays with
the profile it was made in. To give it to every profile, move it into `config/settings.json`.

`claude-multi settings` regenerates (and adopts); `install` does the same, and so does every launch
when Deno is there and a source is newer than the last run (`bin/lib/prelaunch.sh`). The doctor
reports a file Claude wrote into and that is not adopted yet, and one that is behind its sources.

### Plugins

The console's **Plugins** view is the plugin manager. The repository decides which plugin is on
where: `enabledPlugins` in `config/settings.json` for every profile (the **All** column), in
`config/profiles/<p>/settings.json` for one (a profile's column; each cell cycles inherit → on → off). The
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

| Command                                                               | What it does                                                                                                                                                 |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude`                                                              | Claude Code on the default profile                                                                                                                           |
| `claude-work`, `claude-client`                                        | Claude Code on that profile (each profile declares its own `command`)                                                                                        |
| `claude-multi install [--dry-run]`                                    | materialise runtime, wrappers, systemd units and desktop entries from the manifests. Idempotent                                                              |
| `claude-multi settings [--dry-run]`                                   | regenerate each profile's `settings.json`, adopting into `config/profiles/<p>/settings.json` what Claude wrote into it                                       |
| `claude-multi doctor [--json\|--notify]`                              | verify every invariant and say how to fix it; `--notify` raises a desktop notification only when a _new_ failure appears, or when everything clears          |
| `claude-multi status [--json]`                                        | versions, available updates, repository sync, what is mounted per profile, running instances. The JSON contract for the statusline, the tray and the console |
| `claude-multi sync [--fetch]`                                         | align the repository from the remote (fetch when stale, ff-only pull on a clean tree)                                                                        |
| `claude-multi mcp check\|sync\|health`                                | apply the MCP registry to every profile and surface; `health` verifies binaries, files and dependencies, `--probe` really starts each server                 |
| `claude-multi update [--cli\|--desktop\|--self\|--check\|--rollback]` | update Claude Code, Claude Desktop and claude-multi itself                                                                                                   |
| `claude-multi usage [--by …] [--since …]`                             | tokens and list-price estimate by profile, model, project, agent, day, **skill**, **command** (SQLite)                                                       |
| `claude-multi serve [--no-open]`                                      | the console on `http://127.0.0.1:7331` (normally already running as a unit)                                                                                  |
| `claude-multi vault status\|init\|pair\|set\|delete\|run`             | the secret vault the MCP servers read their credentials from (below)                                                                                         |
| `claude-multi tasks brief\|add\|done\|remind\|migrate`                | the task list from the terminal; `remind` is what the timer runs, `migrate` moves the old files into the brain                                               |
| `claude-multi google client <file.json>\|connect <account>`           | the Google OAuth client, and connecting an account                                                                                                           |
| `claude-launch <profile>`                                             | the entry point desktop launchers use: repository sync, a staged Desktop version switched in, then the app                                                   |
| `claude-multi-app [--tray\|--hey\|--pick]`                            | the desktop app: console window, tray icon, Hey Claude, the profile picker (below)                                                                           |

`claude update` inside a wrapper is redirected to `claude-multi update --cli`: the native updater
would rewrite `~/.local/bin/claude` and leave `claude-bin` behind.

---

## The console

`claude-multi install` enables `claude-multi-console.service`, so the console is always at
<http://127.0.0.1:7331>. It is not tied to a graphical session — over an ssh tunnel it works
exactly the same, which is the point on a headless box.

Updates are **pushed, not polled**: the server watches the transcript tree and the shared config,
asks the brain every half minute whether its tasks or pages moved, and the page redraws the view you
are actually looking at. The page itself is HTML, CSS and vanilla JS with no build step; the libraries
it uses are vendored in `apps/cli/dashboard/vendor/` (d3-force, for the brain's graph) and nothing is
loaded from elsewhere, so it renders on a machine that has never been online.

Five sections, in English or Italian. The language follows the machine's locale — the regional
format (`LC_TIME`) outranks `LANG`, so English messages with Italian formats open in Italian — and
the globe button in the rail overrides it per browser.

- **Today** (`#today`) — the sessions running now first, then the day's tasks and appointments and
  the last sessions per directory with the command that reopens each one. A status card appears
  only when something needs you; the rail's dot says the rest.
- **Tasks** (`#tasks`) — the board (columns by status, drag a card to move it), a sortable list, a
  month calendar with the Google events, and one small board per project folder. The folder tree
  on the left filters every view. A task opens as a page: its fields, its steps and their
  progress, a Markdown description that saves as you type, and its attachments. See [Tasks](#tasks).
- **Brain** (`#brain`) — the brain service, read through the console with this machine's token
  (`apps/cli/memory.ts`; the browser never sees it). **Pages**: the seven areas as a tree, search by
  words at once and by meaning on Enter, a reader with who wrote the page and when, the links both
  ways (broken ones struck through), every version and what changed since, and the page's
  neighbourhood as a live graph. **Graph**: the whole brain, laid out by d3-force with each area in
  its own region (drag, pan, zoom, filter by area). **Diary**: the days as a timeline. **Health**:
  what `brain_check` finds, with "Fix with Claude". **Archive**: the old wiki (`~/brains/claude`,
  `CLAUDE_MULTI_BRAIN`), read only since 2026-10-02, with "Bring into the brain". The page does not
  edit: the field at the bottom asks Claude for a change (ask kind `brain`), with the brain's tools
  and nothing else, never deletion, running inside the old wiki so the only files it can read are
  there.
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

`claude-multi-app` (`apps/tray/`, PySide6) makes the console an application. It is a
**view**, like everything that is not the CLI: its state is the console's, its actions are the
commands a terminal would run. The console server stays its own unit, so a browser or an ssh
tunnel still reaches it.

- **Window** — the console in a window with its own icon and menu entry (`claude-multi`). Links
  that leave it open in the system browser. With the server down it says so and offers to start
  it. It opens on Today. Closing it hides it for twenty minutes, so reopening is instant; after that
  it is destroyed, because the web engine is the heavy part and the tray alone should stay light.
- **Tray** — the state at a glance, from `/api/summary` (a pure function of `status`, tested):
  no dot when all is well, **red** for a failing doctor check,
  **grey** when the console does not answer. Warnings are listed, not coloured: some are standing
  conditions of a machine, and an icon that is always yellow says nothing. It refreshes on the
  console's `state` events and when the menu opens, never on a timer. The menu opens the console,
  Hey Claude, a profile's Claude Desktop, the Updates tab and the Health view. A Claude Desktop version waiting
  to switch is listed there, not coloured: it needs nothing from you.
- **At login** — `claude-multi-app.service` (graphical session only, enabled by `install`) runs
  `--tray`. One instance per session: a second start hands its request to the first over
  `$XDG_RUNTIME_DIR/claude-multi-app.sock` and exits.

- **Claude in the menu** — one entry, _Claude_, for every profile: it runs `claude-multi-app --pick`,
  a small window that lists the profiles (with the account each is signed in to, and which Desktop
  is already open) and opens the chosen one through `claude-launch` — or brings it forward when it
  is open. ↑ ↓ or 1–9, Enter, Esc. The per-profile entries are still installed, hidden from the menu
  (`NoDisplay`): the taskbar groups each Desktop under its own, and the default one owns `claude://`.

- **Hey Claude** — `claude-multi-app --hey` (also in the tray menu, and the bar on Today) opens one
  floating field. What you write goes to `claude -p` in the default profile and the answer streams
  under it: the tasks can be changed from there, calendar, mail, Drive and the brain only read
  (sending mail or inviting stays a conversation's job). A follow-up continues the same
  conversation, which can move to a terminal; a request that needs work inside a project's files
  becomes one button that opens Claude Code in that folder with the request. Bind it to a global
  shortcut in KDE: System Settings › Keyboard › Shortcuts › Add New › Command, with the **absolute**
  path (`~/.local/bin/claude-multi-app --hey`): the Plasma session's `PATH` does not include
  `~/.local/bin`.

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

One registry, `shared/mcp/servers.json`: a **catalogue of templates, all off** until the person
turns one on — an entry with `_service` by an account of that service in their `accounts.json`,
any other by `_profiles` in their `servers.json` (the catalogue writes `"_profiles": []`; `null` there
means every profile). Servers of one's own go in one's `servers.json`, never in the repository. A
template nobody uses is not checked by the doctor or `mcp health`, so a missing binary of a service
someone does not use is not their problem. A test keeps the catalogue off for a fresh configuration.
Per server, `_profiles` (default: all) and `_surfaces`:

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
an external service share `shared/mcp/lib/`: `coolify` and `google` today. n8n is not ours any more: it runs n8n-mcp, one server per account (below).

### Servers that are not ours: one per account

An official MCP server (or a good community one) works on one account at a time. An entry with
`_service` and `_perAccount` becomes **one server per account the profile sees**, named
`<entry>-<account>`: which profile sees which account is `profiles` in `accounts.json`, as for every
account-backed server. `{url}`, `{host}` and `{name}` anywhere in the entry are that account's.

```json
"n8n": {
  "_service": "n8n", "type": "stdio", "command": "npx", "args": ["-y", "n8n-mcp@2"],
  "_perAccount": { "env": { "N8N_API_URL": "{url}", "N8N_API_KEY": "{secret}" } },
  "_deny": ["n8n_delete_workflow"], "_ask": ["n8n_test_workflow"]
},
"supabase": {
  "_service": "supabase", "type": "stdio", "command": "npx", "args": ["-y", "@supabase/mcp-server-supabase@0.13.0"],
  "_perAccount": { "env": { "SUPABASE_ACCESS_TOKEN": "{secret}" } },
  "_bind": { "project": "--project-ref={value}", "readOnly": "--read-only" }
},
"lovable": { "_service": "lovable", "type": "http", "url": "https://mcp.lovable.dev", "_perAccount": {} }
```

- **The secret never enters a config.** `{secret}` stays a placeholder; `shared/mcp/lib/launch.ts`
  fills it in from the vault when the server starts: as the wrapper of a stdio command (`env`), or
  as Claude Code's `headersHelper` for an http server (`headers`). It refuses an account the profile
  does not see.
- `"_perAccount": {}` is a server that signs in by itself (OAuth): one per account, each logged in
  once with `/mcp`. Mark those accounts `"auth": "oauth"`: they have nothing in the vault.
- **`_deny` / `_ask`**: tool names that become `mcp__<server>__<tool>` rules in each profile's
  generated `settings.json`, for every server the entry expands to (any entry may use them). This is
  how "no deletion tools" holds on a server that has some: deny them here, or switch them off in the
  server itself when it can.
- **`_guard: { tool, hook }`**: a PreToolUse hook of `shared/hooks` that decides on each call of
  that tool, wired by the same generated settings on exactly the entry's servers. For a server whose
  one tool does everything: `cloudflare-guard.ts` reads the code `execute` would run, lets reads
  through, denies any deletion and asks for writes.
- **`_bind: { key: argument }`**: a project ties a stdio server to itself. `launch.ts` looks for
  `.claude/claude-multi.json` from the folder Claude started in up to the home folder, and each key
  the project sets under the service's name adds that argument (`{value}` filled in, `true` as it
  is). `{"supabase": {"project": "<ref>", "readOnly": false}}` starts that folder's `supabase-<account>`
  on that project only, under the same name (its tools stay `mcp__supabase-<account>__*`). No file:
  the server is as it always was. `install` keeps the file in git's global ignore, the doctor checks
  it, and the server writes what it is tied to on its stderr, the client's log of it.
- http servers stay off Desktop, whose config holds commands only. The doctor checks the entries
  (`{secret}` outside `_perAccount`, a template of the wrong kind); `mcp health --probe` starts each
  expanded server through `launch.ts`, with its real secret.

### Google (Gmail, Calendar, Drive)

The `google` server works on every Google account in `accounts.json` (service `google`: personal,
client…), each profile seeing its own. One OAuth client serves them all: create it once in a Google
Cloud project (APIs: Gmail, Calendar, Drive; consent screen _External_ and **published** — in
_Testing_ refresh tokens expire after seven days; client type _Desktop app_), download its JSON and
import it (console › Connections, or `claude-multi google client <file.json>`). Then each account:
add it, press **Connect**, grant access in the browser (loopback redirect with PKCE); the refresh
token goes to the vault and the address next to the account's name.

- **Scopes**: Gmail modify (read, drafts and sending them, labels and archiving — never permanent
  deletion), Calendar events read/write and the calendar list, Drive read-only (shared files
  included; it also reads Sheets through the Sheets API), and the account's address. An account
  connected before a scope was added answers 403 on what needs it: connect it again.
- **Mail goes out in two steps**: `gmail_draft` writes a draft, `gmail_send` sends an existing one —
  and `mcp__google__gmail_send` is in the shared `ask` permissions, so it always asks.
- **Mail is tidied, not removed**: `gmail_modify` marks read or unread, archives, adds and removes
  labels by name (an unknown one is refused, never created); `gmail_attachment` saves an attachment
  into the downloads folder, under a safe name that never overwrites a file — the only place the
  server may write.
- **Calendar writes** send no invitation unless asked (`sendUpdates` defaults to `none`);
  `calendar_respond` answers an invitation.
- **One deletion, and it asks**: `calendar_delete`, in the shared `ask` permissions like
  `gmail_send`. A deleted event stays thirty days in the calendar's bin. No mail or file removal.
- **Drive** reads Docs and Slides as text, every sheet of a Sheet, a PDF's text (unpdf), text files.

### Tasks

The owner's tasks live in their brain (`apps/brain/`), one Markdown file per task, so the phone sees the same
list: every process here reads and writes them on the brain's `/api/tasks` with a personal token
from the vault (`shared/mcp/lib/brain-tasks.ts`, the `brain` account). Without a brain account they
are files in `~/brains/tasks/items` (`CLAUDE_MULTI_TASKS`), as they were until 2026-10-02;
`claude-multi tasks migrate` moves those files into the brain once. `~/brains/tasks` still keeps
`settings.json` and the files attached from the console. A task has a day and optionally a time,
a warning in minutes before it, a project, a priority, a repeat (daily, weekdays, weekly, monthly:
completing one creates the next) and an owner — who has to move: `alice`, `claude`, or someone else,
and then it is waiting on them. Nothing is deleted: a task that no longer matters is `dropped`.

- **The body is plain Markdown**: a description, a checklist of steps (`- [ ]` / `- [x]`, whose
  ticks give the progress on the board) and an `## Attachments` section — links, paths on this
  computer (opened with the desktop's default program), files dropped on the task in the console
  (copied to `files/<id>/` on this machine) and brain pages (`[[…]]`).
  `## Log` and `## Decisions` keep dated lines, added one at a time (`tasks_note`, or the page).
- **A project's tasks keep the project's names**: `ref` (its id there, TASK-495: one open task per
  ref in a project, and every tool takes it in place of the id), a free `stage` (spec, release
  pending…; the column stays `status`), `parent` (a phase of a larger task), `blocked_by`,
  `labels`, and `detail`: where the full story lives when the project keeps it (a file of the
  repository, relative to the project's folder, a URL, a brain page). The brain holds the card of
  every task; how much detail goes in it is the project's choice.
- **Projects are folders**: a task's project is its folder under `~` (`work/acme/portal`), or a bare
  name that resolves to the shallowest folder with that name (`apps/cli/projects.ts`; the roots are
  `projectRoots` in the settings, by default `personal`, `work`, `university`).
- The **`tasks` MCP server** is in every profile, on the CLI and in Desktop (the brain connector
  has the same tools on the same list): `tasks_brief` (the
  debrief), `tasks_list` (with `full` for the whole notes, `status: all` for the archive),
  `tasks_get`, `tasks_add`, `tasks_update`, `tasks_done` (it says what it unblocked), `tasks_steps`,
  `tasks_note`, `tasks_edit` (one passage of the notes), `tasks_attach`. Changes run one at a time per process, and the console refuses to overwrite a
  task that changed since it was opened. The tasks rule (in your `rules/`) tells every session to keep the
  list current from the conversation.
- **Reminders**: `claude-tasks.timer` runs `claude-multi tasks remind` every five minutes: the
  briefs at the times in `~/brains/tasks/settings.json` (default 08:30, 13:30, 19:00; an empty brief
  is not sent) and a warning before each timed task. Never more than an hour late, never twice.
- **In the console**: the Tasks tab, and on Today the day's list with a checkbox to complete and a
  quick add.
- **Appointments count too**: today's and tomorrow's events of every connected Google account join
  the briefs, the warnings and Today (marked as events, not completable; declined and cancelled
  ones left out). The `tasks` server itself stays local: in a chat, the debrief combines
  `tasks_brief` with the google server's `calendar_events`.

### Accounts and the secret vault

- **Accounts** are listed in your configuration's `accounts.json`, with no secret in it: service, a short
  name, the address, and the profiles that see it (none = every profile). A profile can see several
  accounts of one service; each tool then takes `account`, required as soon as there is more than
  one — never a silent default. A registry entry with `_service` goes only to the profiles that see
  one of that service's accounts, with `CLAUDE_MULTI_PROFILE` in its environment and `{hosts}` in
  its arguments replaced by those accounts' hosts (its `--allow-net`). A server that is not ours is
  one per account instead ([above](#servers-that-are-not-ours-one-per-account)).
- **Secrets** are in the vault, `~/vault/claude-multi` (a Syncthing folder: they travel between
  machines already encrypted, a relay machine carries them without reading them). One file per secret,
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
- **A service's own command-line tool** gets the same token: `claude-multi vault run cloudflare
  [account] -- wrangler deploy` (`apps/cli/toolrun.ts`). Only that tool runs (the project's
  `node_modules/.bin`, else PATH; `pnpm add -D wrangler` in the project), the token is in its
  environment and hidden if it ever reaches the output, and its own login is refused. What deletes,
  rolls back, applies remote migrations or runs DROP/DELETE/TRUNCATE/ALTER on a remote D1 asks for a
  typed "yes" on a terminal: a Claude session has none, so there it is refused with the command to
  run. The doctor warns when wrangler is logged in on its own, outside the vault.

---

## Repository layout

```
bin/            wrappers and scripts: claude, claude-multi, claude-multi-app, claude-launch, claude-update, …
bin/lib/        prelaunch.sh — repository sync before every launch (pure bash, never blocking)
apps/cli/            the claude-multi CLI (Deno, zero dependencies)
apps/cli/dashboard/  the console page (HTML/CSS/JS, no build step)
shared/         what every profile gets: agents, commands, hooks, skills, the MCP catalogue, base settings.json
config.example/ the configuration `claude-multi init` starts from
lib/            the desktop app: tray and console window (PySide6)
systemd/user/   console and app units, update-check and tasks timers, optional local inference units
desktop/        .desktop entries and icons
pkg/            the pinned Anthropic apt key, and claude-desktop-shims (the system half of Claude Desktop)
```

Runtime, generated by `install`:

```
~/.claude-multi/
  shared         → <repo>/shared
  config         → your configuration folder
  marketplaces/  plugin marketplace clones (per-machine, re-clonable)
  <profile>/     CLAUDE.md, hooks, skills, agents, commands → shared or your configuration
                 settings.json — generated: shared ⊕ config ⊕ config/profiles/<p> ⊕ the manifest
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
  `claude-update --auto` (Code, Desktop, then claude-multi), then `doctor --notify`. Nice and idle I/O: it should not be felt.
- **Claude Code** is installed as soon as a new version is out. The native updater downloads into
  `~/.local/share/claude/versions/X.Y.Z`; `claude-update` re-points `claude-bin`, restores the
  wrapper, prunes old versions (keeping N-1) and fixes the `claude-cli://` handler. Open sessions
  keep running on the version they started with.
- **Claude Desktop** lives in user space, `~/.local/lib/claude-desktop/versions/<ver>` with
  `current` pointing at the one in use — no root at any step. `claude-desktop-update` _stages_ a
  new version (download, verify, extract) at any time, and _applies_ it (flip `current`, rebuild
  each profile's variant, install the icons) only when no Claude Desktop runs: replacing files
  under a running Electron app crashes it. `claude-launch` applies a staged version right before it
  starts the app, so in practice an update lands at the next launch. The previous version is kept.
- **claude-multi** updates itself in the same round, last (`claude-multi self-update`,
  `apps/cli/selfupdate.ts`): a fetch, then a pull only fast-forward and only on a clean tree that follows
  a remote branch (local changes or diverged history: nothing is touched, the log says why, once).
  After a pull the console and the tray app restart if their code changed, the generated settings
  are rebuilt, and `install` runs when it has work to do — only with every Claude closed; otherwise
  it waits for a later round, and System › Updates says so. The launch-time pull above stays.
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
- Every new invariant goes in `apps/cli/doctor/` — the README describes, the doctor verifies. Every new
  pure function gets a test in `apps/cli/tests/`.

---

## Don't

- Write into `~/.claude/` (it is a read-only stub) or change its permissions.
- Edit `~/.claude-multi/shared` outside the repository — it is a symlink into it.
- Run `claude update` or `claude-bin update` by hand; use `claude-multi update`.
- Put `~/.claude-multi` into a file-sync folder: it holds credentials, and backups containing
  tokens have leaked that way before.
- Update Claude Desktop with the app open.

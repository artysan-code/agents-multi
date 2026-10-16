# Agents Multi

Run several **Claude Code** and **Claude Desktop** accounts on one Linux machine, without them
seeing each other. A desktop app carries it all and keeps itself up to date, a local console shows
what every profile is doing, and an optional brain keeps your memory and tasks across machines.

**This repository is the source of truth** for the code, which the app carries and installs into
`~/.agents-multi/`, the runtime (profiles, logins, sessions); what is yours — profiles, accounts, rules — lives in a folder of yours. That
folder may travel between your machines (Syncthing, a private git repository); the runtime never
does, because it holds credentials.

---

## Getting started

### 1. Install the desktop app

Every machine runs the **Agents Multi** desktop app: it carries the console, its backend and the Deno
that runs both, and installs everything else itself. Each version is on the project's
[GitHub releases](https://github.com/artysan-code/agents-multi/releases) (Linux x86_64 for now; macOS
and Windows come with 1.x):

- **Debian, Ubuntu** — `sudo apt install ./agents-multi_<version>_amd64.deb`
- **Fedora, openSUSE** — `sudo dnf install ./agents-multi-<version>-1.x86_64.rpm` (stable versions
  only: a beta or an rc has no rpm, take the AppImage)
- **Arch** — the AUR package `agents-multi-bin` (`paru -S agents-multi-bin`), not published yet: take
  the AppImage meanwhile. pacman will update it, so the app's own updater is off there
- **Anywhere else** — the AppImage: put it where it will stay (for example
  `~/Applications/`), `chmod +x` it and run it. Updates replace that file in place, and the first run
  writes its menu entry. It needs WebKitGTK on the system (`webkit2gtk-4.1`).

It needs python3 (some hooks), a Secret Service keyring (KWallet, GNOME Keyring: it holds the vault's
key), a system tray (GNOME: the AppIndicator extension) and `~/.local/bin` on the `PATH`, where the
install puts the commands.

The app updates itself from then on: it looks for a new version every day and downloads it in the
background, and **System › Updates** in the console installs it and restarts the app; a deb or an rpm asks for
your password to install. Betas are a channel of their own (see
[ADR 0004](docs/adr/0004-desktop-app-releases.md)).

### 2. First run

Start the app. On a machine with no configuration the console opens on the **first-run wizard**,
which does everything one screen at a time: your name and language, the configuration folder
(`agents init`; a folder that already holds one, synced from another machine, is only linked), the
profiles, `agents install --app` with its output, Claude Code when the machine has none (Anthropic's
installer, through `agents update --cli`), the vault (made there, its recovery code shown once, or
opened with another machine's code), each profile's sign-in, the brain (optional) and
`agents mcp sync`. It resumes where it stopped: each step is done when its result is on disk
(`apps/cli/setup.ts`). From then on the app starts in the tray at login, and its console is on
<http://127.0.0.1:7331> while it runs. Check the result:

```bash
agents doctor   # every invariant, each with a fix
```

Without the wizard (or guided by a Claude Code session following [ONBOARDING.md](ONBOARDING.md)):

1. Start the app once: it copies its code into `~/.agents-multi/app/current` (leave its wizard).
2. `agents init <folder> --name Ann --language Italian` — your configuration, from `config.example/`
   (the command is `~/.agents-multi/app/current/bin/agents` until the install links it into
   `~/.local/bin`), then `agents install --app`: the runtime, the launchers and the app's autostart
   entry.
3. `agents vault init` — the secret vault; keep the recovery code somewhere safe. Then each
   account's secret: `agents vault set <service> <account>`, or the console's Connections.
4. `claude` (and each profile's command) — sign in with `/login`.
5. Optionally your own brain: an instance of `apps/brain/` on your server (`apps/brain/README.md`), its
   address as a `brain` account in `accounts.json`, then `agents brain-login` (or Sign in, console ›
   Connections) puts its token and backup key in the vault.
6. `agents mcp sync`, then `agents doctor` (no Claude needs closing for the sync).

`install` is idempotent and reversible: it never deletes real content, it moves it aside to
`*.pre-repo-<stamp>` and says so; `install --dry-run` shows the plan. OAuth credentials are
per-machine and never leave it.

### 3. Your configuration

```
~/.agents-multi/config → your folder
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

### App mode and dev mode

Two modes, decided by what `~/.agents-multi/shared` links to (`apps/cli/lib/mode.ts`):

- **app** — `shared` → `app/current/shared`, the copy of the build in use (`app/<version>-<digest>`,
  the one before kept as `app/previous`). The launchers in `~/.local/bin`, the MCP servers (on
  `~/.agents-multi/bin/deno`, the package's Deno) and the jobs on a schedule (run by the app's
  backend, no systemd unit) all go through it. Updated with the app; no git anywhere.
- **dev** — `shared` → a checkout, as `bin/agents install` from that checkout makes it, for working on
  Agents Multi itself: the launch pulls (`prelaunch.sh`), the systemd timers run the jobs, and
  `claude-multi-app` runs the app on the checkout's code (`AGENTS_MULTI_REPO`). It needs `deno`, `git`
  and `pnpm`. Over SSH, the repository's host name must reach the server directly, not through a
  proxy that does not forward the SSH port (see [ONBOARDING.md](ONBOARDING.md#2-the-repository)).

For Claude Desktop profile variants also `gnupg`, `binutils` (`ar`), `libarchive` (`bsdtar`) and
`@electron/asar`, plus `base-devel` once, for the shims package.

The project was called claude-multi: `claude-multi` still works as another name for the command, and
some folders, services and settings keep that name until they move with a migration of their own.

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
shared/settings.json                 the setup's own: hooks, statusline, the safety rules, and a
                                     repository's AGENTS.md read beside any CLAUDE.md above it
config/settings.json                 yours: what every profile gets, as a JSON Merge Patch over it
                                     (RFC 7386: objects merge, anything else replaces, null deletes)
config/profiles/<p>/settings.json    that profile's differences, the same kind of patch
config/profiles/<p>/profile.json     what the manifest implies (disableAccountMcp)
  → ~/.agents-multi/<p>/settings.json
```

It has to be per profile because of plugins: Claude Code installs every plugin `enabledPlugins`
marks true when a session starts, so a plugin is off for one profile only if that profile's own
file says so. Claude Code also writes into this file (`/plugin`, `/config`): before regenerating,
the difference from the last generated copy (kept in `~/.local/state/agents-multi/settings/`) is
**adopted** into `config/profiles/<p>/settings.json`, so nothing is lost and the change stays with
the profile it was made in. To give it to every profile, move it into `config/settings.json`.

`agents settings` regenerates (and adopts); `install` does the same, and so does every launch
when Deno is there and a source is newer than the last run (`bin/lib/prelaunch.sh`). The doctor
reports a file Claude wrote into and that is not adopted yet, and one that is behind its sources.

### Plugins

The repository decides which plugin is on where: `enabledPlugins` in `config/settings.json` for every
profile, in `config/profiles/<p>/settings.json` for one. The marketplaces are the shared
`extraKnownMarketplaces`. Claude Code owns the runtime — plugin cache, marketplace clones — and every
change there goes through its own `/plugin` or `claude plugin …` in that profile, never by editing
its files. A plugin turned on is installed by Claude at the next session start; off means `false` in
that profile's file, so it is not reinstalled.

The doctor fails on an installed plugin whose files are gone (records hold absolute paths, so a
moved profile directory breaks them). A project or local record whose project directory is gone
is only a warning: it loads nowhere, and the CLI can remove it only from inside that project.

`desktopDir` is where Claude Desktop keeps that profile's data. Omit it and the convention applies:
`~/.config/Claude-<Name>` when it exists, otherwise Desktop's own `~/.config/Claude`.

The easiest way to add one is the console: **Profiles → Add profile** writes the manifest, updates
the MCP registry, and runs `install`. Then open the new launcher once and sign in — credentials are
the one thing no manifest can carry.

Renaming a profile is not a console operation, because it moves things `install` does not own: the
runtime directory `~/.agents-multi/<name>` with its credentials and transcripts, the Desktop data
dir, and the profile column already recorded in `usage.db`. Do it from a terminal with Claude
closed, then run `agents install` and `agents doctor`.

---

## Commands

| Command                                                                       | What it does                                                                                                                                                           |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`                                                                      | Claude Code on the default profile                                                                                                                                     |
| `claude-work`, `claude-client`                                                | Claude Code on that profile (each profile declares its own `command`)                                                                                                  |
| `agents install [--app] [--dry-run]`                                          | materialise runtime, wrappers, desktop entries (and in dev mode the systemd units) from the manifests. Idempotent. `--app`: from the app's code, copied first          |
| `agents settings [--dry-run]`                                                 | regenerate each profile's `settings.json`, adopting into `config/profiles/<p>/settings.json` what Claude wrote into it                                                 |
| `agents doctor [--json\|--notify]`                                            | verify every invariant and say how to fix it; `--notify` raises a desktop notification only when a _new_ failure appears, or when everything clears                    |
| `agents status [--json]`                                                      | versions, available updates, repository sync, what is mounted per profile, running instances. The JSON contract for the statusline, the tray and the console           |
| `agents sync [--fetch]`                                                       | dev mode: align the repository from the remote (fetch when stale, ff-only pull on a clean tree)                                                                        |
| `agents mcp check\|sync\|warm\|health`                                        | write the MCP launch configs and Desktop's servers; `warm` builds the gateway's tool lists; `health` verifies binaries and files, `--probe` starts each server         |
| `agents limits [--json]`                                                      | every account's usage windows (5h, 7d, 30d…): Claude's from the status line, Codex's from its session logs                                                             |
| `agents codex <profile> [args…]\|limits <profile>`                            | Codex (OpenAI) with that profile's own account; its login and usage windows                                                                                            |
| `agents agent start\|list\|status\|say\|answer\|stop\|events`                 | the hub's children from a terminal: sessions of any profile and provider at work in a project, their permission requests answered here                                 |
| `agents gateway [status\|run]`                                                | the lazy MCP gateway (below): what it is doing, or run it in the foreground on a machine with no console                                                               |
| `agents update [--cli\|--desktop\|--self\|--check\|--rollback]`               | update Claude Code, Claude Desktop and Agents Multi itself                                                                                                             |
| `agents usage [--by …] [--since …]`                                           | tokens and list-price estimate by profile, model, project, agent, day, **skill**, **command** (SQLite)                                                                 |
| `agents serve [--no-open]`                                                    | the console on `http://127.0.0.1:7331` (normally the app's backend already serves it)                                                                                  |
| `agents ui build`                                                             | build the console's interface (`apps/ui`, pnpm); install and self-update run it when `apps/ui` changed                                                                 |
| `agents vault status\|init\|pair\|set\|delete\|run`                           | the secret vault the MCP servers read their credentials from (below)                                                                                                   |
| `agents routine add\|list\|rm\|run`                                           | unattended jobs on a schedule (cron, a one-shot `at`, a run's end), each on its own branch under the repository's run policy (below)                                   |
| `agents review [rules [folder]]`                                              | what the reviewer allowed, refused or left to you in routines' runs; the rules a project's runs get (below)                                                            |
| `agents nodes [accept\|decline\|propose\|forget]`                             | the machines and jobs the service sees; `accept` signs a job here, with the vault's approval key (ADR 0012); `forget <name>` drops a machine and its tokens            |
| `agents passkeys [endorse\|revoke <id>]`                                      | the passkeys your phone registered, with their fingerprints; `endorse` signs one here so that it can say yes, `revoke` writes its revocation into the vault (ADR 0014) |
| `agents account status\|default\|proposals\|propose\|accept\|decline\|events` | the limit rules per account, a project's default account, and the owner's yes to a switch (below)                                                                      |
| `agents tasks brief\|add\|done\|remind`                                       | the task list from the terminal; `remind` is what the timer runs                                                                                                       |
| `agents google client <file.json>\|connect <account>`                         | the Google OAuth client, and connecting an account                                                                                                                     |
| `claude-launch <profile>`                                                     | the entry point desktop launchers use: repository sync, a staged Desktop version switched in, then the app                                                             |
| `claude-multi-app [--tray\|--hey\|--pick]`                                    | the desktop app (the package's, or on PATH): console window, tray icon, Hey Claude, the profile picker (below)                                                         |

### Providers

A **provider** is Claude Code or Codex (OpenAI), both behind one interface (`shared/mcp/lib/providers.ts`,
[ADR 0007](docs/adr/0007-codex-provider.md)): how a hub child starts, what it can do (`capabilities`), its
**accounts** and their **usage windows**. A profile has a Claude account; `"codex": true` in its
`profile.json` adds a Codex one (`agents codex <profile> login`, the CLI by `agents update --codex`).
`agents limits` and the hub's read-only `limits` tool show every account's windows at once; they are read
the passive way (the status line's snapshots, Codex's logs), and a window with no reading is unknown, not
zero. A workflow step or `agent_start` takes `provider: "codex"`: the child gets the profile's MCP servers
as the launch config names them, but only each server's `_allow` tools, since it never asks you.

### Saved workflows

A workflow the owner wants again is a **skill** ([ADR 0005](docs/adr/0005-agent-workflows.md)): a folder with a
`SKILL.md`: a name, when to use it, the steps as prose and the plan as a `json` block with `{{placeholders}}`.
The project's lives in `<project>/.agents/workflows/<name>/` (kept out of git like the HANDOFFs), the owner's for every
project in `~/.agents-multi/config/workflows/<name>/` (an example comes with `agents init`); on a name in both, the
project's wins. `workflow_save` prepares one (the coordinator writes the file: the hub's server writes only its own state), `workflow_list` lists them, `workflow_load` fills one by name for the
owner to approve before `workflow_start`. From a terminal: `agents run save <plan.json> <name> "<when>" [--user]`,
`agents run saved`, `agents run start <name> --var target="PR 4"`.

`claude update` inside a wrapper is redirected to `agents update --cli`: the native updater
would rewrite `~/.local/bin/claude` and leave `claude-bin` behind.

---

## The console

The desktop app's backend serves the console at <http://127.0.0.1:7331> while the app runs; on a
headless box `agents serve` runs it by hand.

It is private to you, not just to the machine: every request but the liveness probe (`/api/code`)
carries a random token made at each start and kept in a file only you can read
(`$XDG_RUNTIME_DIR/agents-multi-console.token`, else under `~/.local/state/agents-multi/`; removed when
the console stops). The app's window enters with it once and holds it as a cookie; `agents serve` opens
your browser with a one-use key, or prints the address with the key on a terminal. A browser without it
sees a page that says where to enter from. The shared deny rules keep a Claude session from reading the
file (`agents doctor` checks both).

Updates are **pushed, not polled**: the server watches the transcript tree and the shared config,
asks the brain every half minute whether its tasks or pages moved, and the page redraws the view you
are actually looking at. The page is `apps/ui/` (Preact and TypeScript, built with Vite and pnpm); its
libraries are bundled into the build and nothing is loaded from elsewhere, so it renders on a machine
that has never been online. The app's package carries its build. In dev mode the build is made on
the machine and never committed: `install` and every update that changed `apps/ui` run
`agents ui build`, a failed build keeps the previous one, and the doctor says when it is missing or
behind. It needs pnpm.

Three views, in English or Italian, on a rail of icons that opens into names while the pointer is on
it, and **More** for the rest; at its foot the machine's health (its colour is the worst check; it
opens Health), the update when one is waiting, the commands and the preferences. The language follows
the machine's locale — the regional format (`LC_TIME`) outranks `LANG`, so English messages with
Italian formats open in Italian — and the preferences override it per browser.

- **Chat** (`#chat`) — talking to Claude as in Claude Desktop: the chats on the left by day, the open
  one on the right, Claude's answers streaming in with the changes it made (a task, an event, a page
  of the brain) as chips. Each request is `claude -p` in the default profile with a fixed list of
  tools (`apps/cli/ask.ts`): the tasks, the calendar (create and move events), mail and Drive to read,
  the brain (never deleting); sending mail or inviting stays a conversation's job. The console keeps
  every chat (`apps/cli/chats.ts`, one file each in the state folder) with the Claude Code session it
  resumes: a chat can go on in a terminal, and a request that needs work inside a project's files
  becomes one button that opens Claude Code in that folder. Hey Claude's conversations show here too.
  In a narrow window the list of chats folds into a button.
- **Runs** (`#runs`) — what works now: the Claude Code sessions running, with their context and
  whether they are working (a click brings the window forward); the agents the hub started and the
  workflow runs with their steps (`GET /api/runs`, read only: they are acted on by their coordinator
  or `agents run`); and the last sessions per folder, each reopened in a terminal with one click.
- **Accounts & limits** (`#limits`) — each profile's account and Claude Desktop, then each of its
  accounts (Claude, and Codex where the profile has it) with its usage windows, when they start again
  and how old the reading is, **stale** past half an hour (the limits manager's rule: it does not act
  on such a reading), and today's tokens. The windows are what `agents limits` reads (`GET /api/limits`):
  the status line's snapshots and Codex's session logs; «Ask for the limits now» asks Anthropic for
  Claude's with each profile's login, read for that request only (`apps/cli/live.ts`).
- **More** — **Tasks** (`#tasks`: today with its times first, what is overdue marked, then the open tasks by
  project; marking one done is the only write, `POST /api/tasks/done`) and **Brain** (`#brain`: search the
  brain and read a page, Markdown with its `[[links]]`, read only; the token stays in the console,
  `apps/cli/memory.ts`), both from the brain service and redrawn on the `brain` event, each with a link to
  the brain's own web board (`/board`) for everything else; **Connections** (`#connections`: every MCP server in the registry, which profiles see it
  and where, the accounts and the vault, the calendars the picker reads), and **Profiles**,
  **Permissions** (the shared allow / ask / deny rules and default mode, what each profile adds or
  leaves out — "always allow" answers land there — and a button to move a profile's own rules to every
  profile), **Updates** (versions, and what is pending), **Health** (every doctor check, with a button
  for the fixes that map to a known action) under `#system/<tab>`.

Adding and editing tasks, and writing the brain, stay in the chats and on the brain's board; the full
consumption report stays in the terminal: `agents usage`.

`⌘K` / `Ctrl-K` opens a command palette with every view and every action. Actions run against the
local CLI through `POST /api/action` behind an allowlist and an anti-CSRF header. Updating and
rolling back are actions like the others: nothing in them needs root.

---

## The desktop app

The **Agents Multi** app (`apps/desktop/`, Tauri; `claude-multi-app` runs it) makes the console an
application ([ADR 0003](docs/adr/0003-desktop-app.md)). It is a **view**, like everything that is
not the CLI: its state is the console's, its actions are the commands a terminal would run. It also
runs the console's backend, and while it runs that backend runs the jobs the systemd timers run in
dev mode: task reminders every five minutes, the brain backup, Claude Code and Desktop updates with
`doctor --notify`, stignore-gen (`apps/cli/console/schedule.ts`).

- **Window** — the console in a window with its own icon and menu entry (`agents-multi`). Links
  that leave it open in the system browser. With the server down it says so and offers to start
  it. It opens on Chat. Closing it hides it for twenty minutes, so reopening is instant; after that
  it is destroyed, because the web engine is the heavy part and the tray alone should stay light.
- **Tray** — the state at a glance, from `/api/summary` (a pure function of `status`, tested):
  no dot when all is well, **red** for a failing doctor check,
  **grey** when the console does not answer. Warnings are listed, not coloured: some are standing
  conditions of a machine, and an icon that is always yellow says nothing. It refreshes on the
  console's `state` events and when the menu opens, never on a timer. The menu opens the console,
  Hey Claude, a profile's Claude Desktop, the Updates tab and the Health view. A Claude Desktop version waiting
  to switch is listed there, not coloured: it needs nothing from you.
- **At login** — the XDG autostart entry `~/.config/autostart/agents-multi.desktop`, written by
  `install`, runs `claude-multi-app --tray`. One instance per session: a second start hands its
  request to the first and exits.
- **Its code** — when the app starts with a build its copy in the runtime is not (after an update),
  it runs `agents install --app` before its backend starts: the new copy is swapped in, and the rest
  of install runs then. Only when that rest would change something an open Claude reads (its settings,
  its links) does it wait for every Claude to be closed — the update screen's «Close Claude» step.
  The result is on the Health page (`app.install`, `app.version`).

- **Claude in the menu** — one entry, _Claude_, for every profile: it runs `claude-multi-app --pick`,
  a small window that lists the profiles (with the account each is signed in to, and which Desktop
  is already open) and opens the chosen one through `claude-launch` — or brings it forward when it
  is open. ↑ ↓ or 1–9, Enter, Esc. The per-profile entries are still installed, hidden from the menu
  (`NoDisplay`): the taskbar groups each Desktop under its own, and the default one owns `claude://`.

- **Hey Claude** — `claude-multi-app --hey` (also in the tray menu) opens one
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
doctor says why.

---

### Routines and the run policy

A **routine** is a job that runs when you are not there: a child (`--profile`, a task) or a saved plan
(`--workflow plan.json`, with `{{task}}` in its prompts, or the name of a saved workflow with `--var k=v` for its placeholders: a missing one is refused when you add it) in a git repository under home, started by a trigger:
`--at 02:00` (the next 02:00; or `2026-10-15T02:00`, `+90m`), `--cron "0 9 * * 1-5"` (local time), or
`--on run-done|run-failed [--plan name]` (a workflow run of the project ending). Each is a file in the hub's
state; the console's backend ticks over them every 15 seconds, so they survive restarts. `agents routine
add|list|rm|run`, and `routine_add|list|rm|run` in the `agents` MCP server, so the coordinator can schedule from
chat ("do this tonight at 2").

- **Missed.** An `at` the console missed by more than its grace (6 h) is not run late: it is marked missed and
  you are told. A cron that went by while the console was down is skipped to its next time (grace 15 min).
- **Isolation.** A firing works in a worktree beside the repository (`<repo>-wt/agent-<id>`) on a branch
  `agent/<id>`. Its children belong to the project with no coordinator: any coordinator of the project sees them
  as orphans and may adopt and answer them ([ADR 0005](docs/adr/0005-agent-workflows.md)).
- **Run policy**, enforced by git and the runner, not the prompt ([ADR 0010](docs/adr/0010-scheduler-and-run-policy.md)):
  commits allowed; a `pre-push` hook set for that worktree alone lets only `agent/<id>` and the development branch
  (`dev`) through, never `main`, `master` or `release`, tags or deletions; at most two runs at once, two hours each.
  Your defaults are `config/policy.json`; a repository's `.agents/policy.json` can only tighten them.
- **Limits and accounts** ([ADR 0010](docs/adr/0010-scheduler-and-run-policy.md), part 2). Every minute the
  console reads each account's windows (the status line's, Codex's logs) and applies `config/limits.json`
  (`stopAt` 80 %, `expiringMin` 60, `roomPercent` 30, `holdMaxMin` 720): an account at 80 % takes no new unattended
  work, a window about to reset with room left is announced, a reset wakes what waited (`--on limit-reset`). A
  routine whose account is blocked is held and a **proposal** appears; a project's default account is
  `config/projects.json` (`agents account default <profile>[/codex]`). Nothing switches an account without your yes:
  the coordinator proposes (`account_propose`), you accept, the console applies. `agents account status|events`.
  A reading older than half an hour blocks nothing (Claude's endpoint reading is as fresh as its last refresh):
  `agents limits` says how old each one is.
- **Outward actions** (a permission the child's mode does not grant) go to the **reviewer**, below.

### The reviewer

What a routine's child asks the hub for — send, publish, deploy, delete, spend, anything its mode does not grant —
is decided by your rules in `config/reviewer.json` ([ADR 0011](docs/adr/0011-reviewer.md)), in Claude Code's
permission syntax:

```json
{
  "allow": ["Bash(wrangler deploy --env dev:*)"],
  "ask": ["mcp__google__calendar_*"],
  "deny": ["Bash(npm publish:*)"],
  "review": [{ "match": "mcp__google__gmail_send", "criterion": "only replies to a thread already open" }],
  "askMin": 30,
  "judge": { "model": "haiku", "maxPerDay": 50 }
}
```

- **The most restrictive rule wins**: deny, ask, review, allow; anything no rule names is an ask. A Bash command
  with shell syntax (`;`, `&&`, `|`, `$(…)`, redirections) is never allowed by a rule. A repository's
  `.agents/reviewer.json` can only add `deny` and `ask`.
- **allow** answers the one call (never "for the session"), **deny** refuses it with the reason, **ask** sends you a
  desktop notification: a coordinator of the project can adopt the child and answer; after `askMin` minutes
  nobody answered, it is refused and the run goes on. A child's own question is never answered for you.
- **review** hands the request to a **judge**: a Claude Code run with no tools, no MCP servers and no CLAUDE.md (about
  1.2k tokens on Haiku), on `judge.profile` or the child's account, which reads your criterion and the request as
  data — masked, cut at 4000 characters — and says allow, deny or ask. Anything else, a failure, an account at its
  limit or the daily cap (`maxPerDay`, 0 turns it off) is an ask; the same request is judged once a day.
- Every pattern named in the rules is given to a routine's child as an `ask` rule (a deny one as refused), so the
  auto classifier cannot let it through unseen — a workflow routine's step children too, through its runner;
  Codex never asks. A glob that covers `mcp__team__team_send` would stop a workflow's steps talking: the doctor
  names it. `config.example/reviewer.json` is a conservative start (deletes and publishing denied, the rest asked).
- `agents review` lists the decisions (`<state>/agents-multi/agents/reviewer/decisions.jsonl`: what, the rule, the
  verdict, who decided and why); `agents review rules [folder]` shows what a project's runs get. The doctor
  names ignored entries and an `allow` that lets a run do anything (`Bash`, `Bash(*)`, a shell or interpreter).

### Nodes: work that moves between machines

Every machine's console is a node of **the service** — the brain, which also keeps your machines and the jobs
placed on them ([ADR 0012](docs/adr/0012-agentd-and-the-service.md)). `agents node enable` turns this machine
on (`~/.local/state/agents-multi/node.json`, this machine's alone; what is the same everywhere — where the clones
are, what a command may reach — is `config/nodes.json`); `agents node` shows what it announces, `agents nodes` every machine and job the service
sees, and `agents nodes accept <job>` signs one.

- **Outbound only.** Every 30 s the node tells the service its load, its session cap (from its memory, or
  `maxSessions`), the accounts logged in and whether you are at it, with its own machine token
  (kept in a file of this machine only: the vault's brain token travels to every machine, and the service
  names a node after its token). Nothing listens beyond `127.0.0.1`.
- **Pairing with a code.** `agents node pair` asks the service for a code (eight characters, `XXXX-XXXX`, good
  for ten minutes, one use), shows it big and waits. In the web app, _Machines › Pair_, you type it; the
  service makes this machine's own token for your account and hands it over on the next poll, and the node is
  turned on. No browser on the machine, no address to paste: it works from the phone. A server pairs with
  `agents node pair --server` instead (its token is a node's, never a machine's: [apps/node](apps/node/README.md)). The
  console has the same as _Connections › Pair with a code_. Five wrong codes lock pairing for fifteen
  minutes. `agents node login` stays for scripts.
- **Your yes is checked on the node.** A job placed on a node runs only with your signature, made on one of your
  machines with a key from the vault the service never has: a stolen token or a broken service cannot start an
  agent. A job taken is a one-shot routine, under the same policy, limits and reviewer.
- **The phone's yes is a passkey, and it counts only once a desktop endorsed it**
  ([ADR 0014](docs/adr/0014-from-the-phone.md)). What waits on a machine (a child's permission request or
  question) is relayed to the service, and the web app shows it with the proposed jobs. The phone says yes with a
  passkey (WebAuthn, ES256, no attestation) it registered on the service; the service keeps its public key but a
  passkey is _pending_ until `agents passkeys endorse <id>` (or the console's Connections page) shows its name and
  fingerprint, asks for your yes and signs it with the vault's approval key. The service stores answers and
  assertions and decides nothing: **the node checks everything** — the endorsement against your key, then the
  assertion (challenge over the answer, origin, rpId, user presence and verification, signature), its expiry
  (at most ten minutes) and that it was not used before — and only then answers the child; a refusal goes
  back to the phone with the reason. The signed text binds **the request's words**: it carries the hash of what
  the child asked to do (and its questions), and the node recomputes that hash from its own hub, never from what the
  service sends back, so a service that showed the phone other words under the same id gets a signature that
  fails. A deny needs the same signature, and so does declining a proposed job from the phone; an accepted job may
  carry a passkey's assertion instead of a desktop's signature. A stolen web session or a broken service can
  register a passkey, but it stays pending: it has no endorsement. **Losing the phone means revoking its passkey**
  with `agents passkeys revoke <id>` (or _Revoke_ in the console's Connections page): the revocation is written
  into your vault, which every machine of yours has, and a node refuses a revoked passkey whatever the service
  lists. A node without the vault has only the service withholding it.
- **Resume from the branch.** While a run works, the node pushes its branch `agent/<id>` and its HANDOFFs
  (`refs/agents/<id>`); a node silent for ten minutes loses its running jobs, and a proposal to resume each on
  another node (a clone of the same remote under `repoRoots`) waits for your yes.
- **A clone on first need, and its env files** ([ADR 0014](docs/adr/0014-from-the-phone.md), slice A). A node
  with no clone of a job's repository clones it under the first of `repoRoots`, with its own git key and nothing
  else (no SSH agent, no token), but only when you allowed the remote: one of `repos` in `config/nodes.json`, or
  one under a host or `host/owner` of `gitHosts` there (`["git.example.me", "github.com/you"]`; empty, nothing is
  cloned on need). Any other remote is refused with the reason. What the clone lacks because git ignores it —
  `.env`, `.env.*`, `.dev.vars`, `.dev.vars.*`, at most three folders down — goes through the vault:
  `agents node seed <machine>` on a machine with the vault seals those of your repositories under `repoRoots` for
  that machine (`--dry-run` lists the paths, never the values; a client's repository only with `--repo <path>`
  and your yes; `--forget <repo>` drops it). Never keys, symlinks, binary files or a file holding a Claude key;
  64 KiB a file, 20 files and 256 KiB a repository. The node writes them 0600 when it clones or uses that clone,
  only where git ignores them there and never over a file that differs.
- **It answers your chat from the phone** ([ADR 0014](docs/adr/0014-from-the-phone.md)). A node that is on holds a
  long poll open to the service (outbound, its own token), runs each chat turn written there with the console's
  own Claude (`claude -p`, resumed per chat, the same fixed tools) and sends the answer back as it comes. On a
  server the turn runs sandboxed with the account's token, like any headless child. The console's own Chat
  uses the same path when the machine is a node: its questions become turns pinned to this machine, its list
  shows the service's chats (so a conversation started on the phone is there), and without a brain account
  or when the service does not answer it keeps its local chats.
- **It transcribes your voice notes** ([ADR 0014](docs/adr/0014-from-the-phone.md)). A node announces `voice` when it
  has whisper.cpp (`whisper-cli` and a multilingual ggml model, kept as `voice` in this machine's `node.json`) and
  ffmpeg. `agents node voice` finds them in the usual places (`PATH`, `~/.local/src/whisper.cpp/build*/bin`,
  `~/.local/share/*/models/ggml-*.bin`) and saves them; `--bin <whisper-cli> --model <ggml-….bin>` sets them by
  hand, `--off` turns it off. Only such a machine takes a voice turn: it fetches the audio the service keeps until
  the turn ends, converts it to 16 kHz mono WAV in a temporary folder, transcribes it locally in the account's
  language (`owner.json` `language`), posts the text as the question and answers it like any turn. Both programs
  run with an empty environment (no secrets) and, on a server, without a network. The audio leaves your machines
  only for the service's copy, deleted when the turn ends. The server image builds whisper.cpp (CPU only, a
  pinned commit); `agents node setup` offers to download a model into the volume, checked against its SHA-256.
- **Forgetting a machine.** `agents nodes forget <name>` (or _More › Machines_ in the web app) drops the node, what
  waits on it and its pending answers, hands the turns it held back to the other machines and revokes the tokens
  named after it: a forgotten machine cannot come back without pairing again.
- **A server** runs `agents serve --headless`: no page, every child in Claude Code's Bash sandbox, failing closed
  (`agents node probe`); only the node pushes. It is given your configuration and the vault, read only, as
  Syncthing folders of their own (`agents config move` puts the configuration in `~/agents-multi-config`), and
  set up by one command in its terminal, `agents node setup` ([ADR 0013](docs/adr/0013-a-server-node-without-a-terminal.md)).
  Nobody signs in to Claude there: `agents node token <profile>`, on your desktop, puts a one-year token of that
  account (`claude setup-token`) in the vault, and the node gives it to that account's children only, with Claude
  Code's subprocess scrub keeping it from what they run (checked before the node takes work). Such a token makes
  model requests only: no claude.ai connectors on a server.

### From the phone

The service also serves a web app at `/app` ([ADR 0014](docs/adr/0014-from-the-phone.md)): open
`https://<your service>/app` on the phone, sign in as on `/account`, and add it to the home screen (it is a PWA,
the shell and push only: no data is kept offline). It is made for one hand: a tab bar under the thumb (**Chat**,
**Waiting** with a badge, **Tasks**, **Brain**, **More**), a calm light and dark theme that follows the device (or
the choice in More), and on a wide screen the chat list beside the conversation. The frame is one screen high and
only its panes scroll, so a view whose content fits never moves (one place in the layout, `web.css`: no `100vh`, the
safe areas added once). You move between the tabs by swiping, with a spring; on rows a swipe is a shortcut for a
button that is always there (a task to the right is done, a chat to the left is deleted with an Undo, a request or a
job to the right is yes, to the left no, still with the passkey).

- **Voice**: dictation in the composer where the browser has speech recognition (the words appear as you speak; the
  browser's own service does the recognition, which the app says), and **voice notes** (up to five minutes and
  10 MB, Opus or AAC): the recording goes to the service, a machine of yours with whisper.cpp transcribes it and
  answers, and the audio is deleted when the turn ends. A chat can be renamed, searched by title and question, and
  a turn **cancelled** at any moment (a waiting one ends at once, a running one is stopped on its machine).
- **Chat**: the conversations by day with the machine that answered; your messages as compact bubbles, answers as
  full-width text (Markdown, code blocks with a copy button, lists, links), the changes Claude made as chips under
  the answer, a live cursor while it writes, _Cancel_ for a waiting or running answer and _Try again_ for a failed or
  cancelled one, rename, delete, a search of the list, and a composer that stays over the keyboard (Enter sends on a desktop, a new line on a touch screen). The machine that
  answers can be changed in place, for the next messages. **Voice**: a microphone dictates into the box
  (`webkitSpeechRecognition`, in the account's language; the phone's own service hears it, and the app says so), and a
  voice note is recorded (`MediaRecorder`: Opus in WebM, AAC in MP4 on iOS; hold and release, slide away to cancel, or
  tap for a recording that stays open; 5 minutes, 10 MB), sent to `POST /api/chats/voice` and shown as an audio bubble
  until a machine with whisper.cpp (`agents node voice`) sends the words. With none online it says the note waits.
- **Waiting**: what the agents on your machines ask (permissions and questions) and the jobs proposed to them, each
  answered with **a passkey**: _Yes_, _Yes for the session_, _No_ (the challenge binds a hash of the request's words;
  declining a job is signed too). The first run creates the passkey, as a discoverable credential so a password
  manager can keep it, and shows the browser's own error with a hint when it fails; it counts only
  once a desktop with your vault has endorsed it (`agents passkeys`), and until then it is shown as pending.
- **Tasks** (compact rows: today with its times, overdue, done today) and **Brain** (search, recent pages, a page in the serif
  face), with loading skeletons, error banners with a retry, an offline banner, and pull to refresh.
- **More**: Machines (state, load and accounts of each node, which one answers, **forget** one you no longer use,
  **pair a machine** with the code
  `agents node pair` shows), notifications (Web Push; on iPhone and iPad once the app is on the home screen), the
  passkeys (list, revoke), theme, language, sign out.

The app runs nothing itself: a chat is answered by one of your paired machines. It is `apps/ui`'s second entry
(`vite.web.config.ts`, strings in `src/i18n/web.ts`), built into the brain's image and served by
`apps/brain/webapp.ts`. To look at it without a service: `pnpm exec vite build --config vite.web.config.ts`, then
`deno run --allow-net --allow-read apps/ui/scripts/web-fixture.ts` serves it with made-up data (a streaming answer
included) on `http://127.0.0.1:8799/app/`.

### On a service someone else hosts

The service can be hosted by someone for other people ([ADR 0014](docs/adr/0014-from-the-phone.md)): an
invitation from `brain-admin create`, an account each, a database each. The person installs Agents Multi on a
machine of theirs, pairs it with `agents node pair` and the code typed in the web app (which shows the machine
before it pairs it), and talks from the phone. The host keeps their memory, tasks and chats, and can read them as
anyone who runs a server can; it never holds their Claude login, their vault or their code, runs nothing on their
machines and cannot say yes for them (a yes is their passkey, endorsed by their own desktop and checked by their
machines). The privacy notice at `/privacy` says what the service keeps. The site's guide: «Starting on a hosted
service».

## Consumption

`agents usage` reports tokens by profile, model, project, agent, day, skill or command, with
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
agents usage --by skill --since 30d
agents usage --by command --since all
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

- `cli` → the profile's generated `~/.agents-multi/<profile>/mcp.json`, which `bin/claude` passes with
  `--mcp-config` at every start (so the hub's children get it too, they start through the launcher).
  For a profile without Desktop nothing is copied into Claude's own `.claude.json`: there is no copy to
  fall out of step. Claude merges
  it over its own servers, the project's `.mcp.json` and the plugins' (no `--strict-mcp-config`), and
  on a name clash the registry wins. The file is rebuilt before Claude starts whenever the registry,
  `accounts.json` or the profiles change (`prelaunch.sh`, with the settings).
- `desktop` → that profile's `claude_desktop_config.json`, read by the Desktop chat. Desktop cannot be
  handed servers at launch, so this one is still a projection: a non-destructive merge (registry-managed
  servers only, hand-added ones survive), written while that Desktop is closed — never an error when it
  is open: `claude-launch` applies it just before opening the app.
- a profile **with Desktop** also gets the registry's servers in its `.claude.json` (managed ones only,
  merged with a backup, `oauthAccount` and hand-added servers untouched), because the Claude Code that
  Desktop embeds (its Code tab) reads that file, not the launch config. Same non-blocking rule: written
  when no Claude of that profile is open, otherwise left for the next Desktop launch.

`agents mcp sync` rebuilds the launch configs and Desktop's servers at once (no Claude needs closing;
a target in use waits), and on first run, for a profile without Desktop, takes the servers an older
version projected into `.claude.json` out of it (only those its per-machine state names, with a backup
into `~/.local/state/agents-multi/`, and only while no Claude of that profile is open). `agents mcp check`
shows what differs.

`mcp health` checks binaries, files, lock files and dependencies. `mcp health --probe` actually
starts each server and waits for its `initialize` reply, which catches what static checks cannot —
native modules built for the wrong Node ABI, missing environment, cold-start crashes. It also asks
each stdio server for `tools/list` and warns when the entry's lists disagree with it (a tool in no
list, a listed tool the server does not offer), and when a program installed outside the repository
reports another version than the entry's `_version`, the one its lists were checked against.

### The lazy gateway

A session used to start its own copy of every MCP server, used or not. With the **gateway**
([ADR 0008](docs/adr/0008-mcp-gateway.md)) the profile's `mcp.json` holds, for each stdio server that can
go through it, an `http` entry with the server's own name (so `mcp__<server>__<tool>` and the
`_allow`/`_ask`/`_deny` rules do not change) pointing at `http://127.0.0.1:7332/p/<profile>/<server>`. One
gateway process per machine (`shared/mcp/gateway/`, Deno, loopback only) answers `tools/list` from a cache,
starts the real stdio server on the **first call**, shares it between every session of that profile and
account, and stops it after ten idle minutes. The console keeps the gateway up (no systemd); a gateway that
restarts is picked up by Claude on its next call.

- It is on by default in app mode and off in dev mode. `<config>/gateway.json`:
  `{ "enabled": false }` is the kill switch (the launch config goes back to plain stdio entries at the next
  launch, or `agents mcp sync`), `idleMinutes` and `port` tune it.
- Each profile has a token in `~/.agents-multi/<profile>/mcp-token` (mode 0600), sent by `headersHelper`
  (`shared/mcp/gateway/headers.sh`); a token opens its own profile's paths and no other. The token is never
  in an argument or in `mcp.json`. The gateway itself refuses the tools in a server's `_deny`. The generated
  settings add deny rules for the port in use and the token files: a barrier against error, not against a
  hostile agent (Claude Code's sandbox is the real one: ADR 0008, _What protects what_).
- Tool lists are cached per server, start command (the tool filters) and version, in
  `~/.agents-multi/gateway/cache/`; the first real start fills them, `agents mcp warm` fills them now (`--force`: all again).
- Not through the gateway: the `agents` hub (it needs its session's folder), servers with `_bind` (the project
  binding is read from the session's folder), remote servers, and everything Desktop reads.

Servers written in-house live in `shared/mcp/<name>/` (Deno, least privilege). The ones that work on
an external service share `shared/mcp/lib/`: `coolify` and `google` today. n8n is not ours any more: it runs n8n-mcp, one server per account (below).

### Servers that are not ours: one per account

An official MCP server (or a good community one) works on one account at a time. An entry with
`_service` and `_perAccount` becomes **one server per account the profile sees**, named
`<entry>-<account>`: which profile sees which account is `profiles` in `accounts.json`, as for every
account-backed server. `{url}`, `{host}` and `{name}` anywhere in the entry are that account's.

```json
"n8n": {
  "_service": "n8n", "type": "stdio", "_npm": { "package": "n8n-mcp", "version": "2.92.1", "bin": "n8n-mcp" },
  "_perAccount": { "env": { "N8N_API_URL": "{url}", "N8N_API_KEY": "{secret}" } },
  "_deny": ["n8n_delete_workflow"], "_ask": ["n8n_test_workflow"]
},
"supabase": {
  "_service": "supabase", "type": "stdio", "args": ["--features=database,docs"],
  "_npm": { "package": "@supabase/mcp-server-supabase", "version": "0.13.0", "bin": "mcp-server-supabase" },
  "_perAccount": { "env": { "SUPABASE_ACCESS_TOKEN": "{secret}" } },
  "_bind": { "project": "--project-ref={value}", "readOnly": "--read-only" }
},
"lovable": { "_service": "lovable", "type": "http", "url": "https://mcp.lovable.dev", "_perAccount": {} }
```

- **The secret never enters a config.** `{secret}` stays a placeholder; `shared/mcp/lib/launch.ts`
  fills it in from the vault when the server starts: for a stdio command (`env`: `launch.sh` reads what
  it prints, exports it and `exec`s the server, so no wrapper process stays alive), or as Claude Code's
  `headersHelper` for an http server (`headers`). It refuses an account the profile does not see.
- **`_npm: { package, version, bin }`**: a third-party npm server is installed by `agents install` at
  that version into `~/.agents-multi/tools/mcp` (only when a profile reaches it) and started as
  `node <bin>`, never through `npx` (whose `npm exec` parent stays alive for the whole session). The
  version is pinned there and nowhere else; the doctor says when it is missing or stale.
- `"_perAccount": {}` is a server that signs in by itself (OAuth): one per account, each logged in
  once with `/mcp`. Mark those accounts `"auth": "oauth"`: they have nothing in the vault.
- **`_allow` / `_deny` / `_ask`**: tool names that become `mcp__<server>__<tool>` rules in each
  profile's generated `settings.json`, for every server the entry expands to (any entry may use them).
  The convention: reads and changes that stay reversible and inside the service (lists, logs, drafts,
  labels, links) in `_allow`, so they run without a question; what reaches outside or production
  (messages, deploys, variables, SQL, merges), spends credits or touches secrets in `_ask`; deletions in
  `_deny` — this is how "no deletion tools" holds on a server that has some. Every tool a server offers
  is in one of them: one left to the permission mode on purpose is named in `_auto`.
  `scripts/mcp-probe.ts` fails when a list names a tool one of our servers does not have, and
  `apps/cli/tests/mcp_tools_test.ts` when one of our servers registers a tool no list names.
- **The repository's own deny and ask lists** (`shared/settings.json`) are added to every profile's,
  whatever the person's or profile's layer says (a merge patch replaces arrays whole): the doctor
  (`profile.<p>.safety`) fails when a built file lacks one of them or a required guard.
- **`_guard: { tool, hook }`**: a PreToolUse hook of `shared/hooks` that decides on each call of
  that tool (or of each tool in a list), wired by the same generated settings on exactly the entry's servers. For a server whose
  one tool does everything: `cloudflare-guard.ts` reads the code `execute` would run, lets reads
  through, denies any deletion and asks for writes. `gitea-guard.ts` reads the `method` of Gitea's consolidated
  `*_write` tools: a merge or a delete asks, everything else reversible goes through.
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
import it (console › Connections, or `agents google client <file.json>`). Then each account:
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
are files in `~/brains/tasks/items` (`AGENTS_MULTI_TASKS`). `~/brains/tasks` also keeps
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
  name a chat used.
- The **`tasks` MCP server** is in every profile, on the CLI and in Desktop (the brain connector
  has the same tools on the same list): `tasks_brief` (the
  debrief), `tasks_list` (with `full` for the whole notes, `status: all` for the archive),
  `tasks_get`, `tasks_add`, `tasks_update`, `tasks_done` (it says what it unblocked), `tasks_steps`,
  `tasks_note`, `tasks_edit` (one passage of the notes), `tasks_attach`. Changes run one at a time per process. The tasks rule (in your `rules/`) tells every session to keep the
  list current from the conversation.
- **Reminders**: `claude-tasks.timer` runs `agents tasks remind` every five minutes: the
  briefs at the times in `~/brains/tasks/settings.json` (default 08:30, 13:30, 19:00; an empty brief
  is not sent) and a warning before each timed task. Never more than an hour late, never twice.
- **In the console**: none of their own — the Chat keeps them from what you write, and «Which
  Claude?» shows the day's next appointment.
- **Appointments count too**: today's and tomorrow's events of every connected Google account join
  the briefs, the warnings and the picker (marked as events, not completable; declined and cancelled
  ones left out). The `tasks` server itself stays local: in a chat, the debrief combines
  `tasks_brief` with the google server's `calendar_events`.

### Accounts and the secret vault

- **Accounts** are listed in your configuration's `accounts.json`, with no secret in it: service, a short
  name, the address, and the profiles that see it (none = every profile). A profile can see several
  accounts of one service; each tool then takes `account`, required as soon as there is more than
  one — never a silent default. A registry entry with `_service` goes only to the profiles that see
  one of that service's accounts, with `AGENTS_MULTI_PROFILE` in its environment and `{hosts}` in
  its arguments replaced by those accounts' hosts (its `--allow-net`). A server that is not ours is
  one per account instead ([above](#servers-that-are-not-ours-one-per-account)).
- **Secrets** are in the vault, `~/agents-multi-vault` (a Syncthing folder of its own: they travel between
  machines already encrypted, a relay machine carries them without reading them, and a server node can be
  given this folder alone; before 1.2.1 it was `~/vault/claude-multi`, still read until `agents vault move`). One file per secret,
  AES-GCM with a fresh IV per write, named by an HMAC so the names say nothing. The key is in each
  machine's keyring (Secret Service: KWallet here), so nothing is typed at login.
- **Deleting** a secret rewrites it as a tombstone instead of removing the file: through an encrypted
  relay a removal can lose against a concurrent modification and come back, a write cannot.
- **Machines**: `agents vault init` on the first one prints a recovery code — keep it outside the
  machine. Every other machine runs `agents vault pair` with it. The first-run wizard and the vault
  card of console › Connections do the same without a terminal. Never restore the vault
  directory from a backup onto a reinstalled machine: pair it and let Syncthing bring the entries.
- **Adding an account**: console › Connections (the secret is checked against the service before it
  is stored, and never comes back to the page), or `agents vault set <service> <account>`
  with the secret on stdin. A secret is never a command-line argument and never a tool result.
- **A service's own command-line tool** gets the same token: `agents vault run cloudflare
  [account] -- wrangler deploy` (`apps/cli/toolrun.ts`). Only that tool runs (the project's
  `node_modules/wrangler` under the project's root — the nearest package.json, never above it, never
  PATH; `pnpm add -D wrangler` in the project), the token is in its
  environment and hidden if it ever reaches the output, and its own login is refused. What deletes,
  rolls back, applies remote migrations or runs DROP/DELETE/TRUNCATE/ALTER on a remote D1 asks for a
  typed "yes" on a terminal: a Claude session has none, so there it is refused with the command to
  run. The doctor warns when wrangler is logged in on its own, outside the vault.

---

## Repository layout

```
bin/            wrappers and scripts: claude, agents-multi, claude-multi-app, claude-launch, claude-update, …
bin/lib/        prelaunch.sh — repository sync before every launch, dev mode only (pure bash, never blocking)
apps/cli/            the agents-multi CLI (Deno, zero dependencies)
apps/ui/             the console page (Preact + TSX, Vite, pnpm)
shared/         what every profile gets: agents, commands, hooks, skills, the MCP catalogue, base settings.json
config.example/ the configuration `agents init` starts from
apps/desktop/   the desktop app (Tauri): console window, tray, picker, the backend and the post-update install
systemd/user/   dev mode's timers: update check, tasks, brain backup, stignore-gen
desktop/        .desktop entries, the autostart entry and icons
pkg/            the pinned Anthropic apt key, and claude-desktop-shims (the system half of Claude Desktop)
```

Runtime, generated by `install`:

```
~/.agents-multi/
  shared         → app/current/shared (app mode) or <checkout>/shared (dev mode)
  app/           the app's code: <version>-<digest>/ per build, current and previous links (app mode)
  bin/           deno and agents-multi-desktop: links to the package's (copies out of an AppImage)
  config         → your configuration folder
  marketplaces/  plugin marketplace clones (per-machine, re-clonable)
  <profile>/     CLAUDE.md, hooks, skills, agents, commands → shared or your configuration
                 settings.json — generated: shared ⊕ config ⊕ config/profiles/<p> ⊕ the manifest
                 .claude.json, .credentials.json (600), projects/  — per-machine, never committed
```

---

## How it travels between machines

In app mode the code travels with the app's updates; what follows is dev mode's.

- One machine is where you work and commit. **Pushing is never automatic.**
- On every launch, `bin/lib/prelaunch.sh` fetches if the last fetch is over 12 h old (3 s timeout),
  and pulls `--ff-only` when the tree is clean and behind. Claude then starts with the new config —
  no restart needed. Offline, or with diverged history, it starts anyway and touches nothing.
- The result lands in `~/.cache/agents-multi/sync.json` and in the statusline: `cfg ↓3` behind,
  `cfg ↑1` unpushed, `cfg ✎2` uncommitted, `cfg ≠` diverged, `cfg offline`.
- `agents sync --fetch` forces a fetch — useful on a laptop before starting.

---

## Updates

Everything updates itself, in the background, with no approval and no window. `DISABLE_AUTOUPDATER=1`
stays set everywhere: the updates are driven from here, not by each binary on its own.

- **Schedule**: 10 min after login, then every 4 h, `claude-update --auto` (Code, Desktop, then
  Agents Multi), then `doctor --notify` — run by the app's backend in app mode, by
  `claude-update-check.timer` in dev mode (nice and idle I/O: it should not be felt).
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
- **Agents Multi** in app mode is the app: it updates with its package, and installs its code when
  it starts on a new build (above); `self-update` only runs an install left waiting. In dev mode it
  updates itself in the same round, last (`agents self-update`, `apps/cli/selfupdate.ts`): a fetch, then a pull only fast-forward and only on a clean tree that follows
  a remote branch (local changes or diverged history: nothing is touched, the log says why, once).
  After a pull the console and the tray app restart if their code changed, the generated settings
  are rebuilt, and `install` runs when it has work to do — only with every Claude closed; otherwise
  it waits for a later round, and System › Updates says so. The launch-time pull above stays.
- **The desktop app** updates itself with Tauri's signed updater: it checks the project site's manifest
  for its channel (`/updates/stable.json`, `/updates/beta.json`) daily, downloads and verifies a new
  version in the background, and installs it when System › Updates asks — then restarts with what it
  runs. A release (tag → CI → signed bundles on GitHub → the manifests on the site) is
  [ADR 0004](docs/adr/0004-desktop-app-releases.md).
- **Rollback**: `agents update --rollback [--desktop]`, or the button in System › Updates.
- **Log**: every result is a line in `~/.local/state/agents-multi/updates.jsonl`, shown in
  System › Updates. The doctor turns a failed last attempt into a warning, a failed verification
  into a failure.
- **Supply chain**: the apt repository key is pinned in `pkg/claude-desktop/anthropic-apt.asc`.
  The `InRelease` signature is checked against it with `gpgv`, then the `Packages` index hash, then
  the `.deb` hash from that index. Anything missing or different stops the update before a file is
  extracted, and raises the only notification the updater ever sends.
- **System half**: `pkg/claude-desktop-shims` holds the runtime dependencies and the links the app
  expects at Debian paths (virtiofsd, OVMF). It is installed once and never changes
  (`cd pkg/claude-desktop-shims && makepkg -si`).

---

## Development

```bash
deno task check   # type-check the CLI and tests, bash -n every script, the app's Rust
deno task test    # usage (rates, dedupe, turns), notifications, guards, mcp, manifests, changelog,
                  # prelaunch against real git repositories; files in parallel (scripts/test.sh)
deno task ci      # the whole gate (scripts/ci.sh): its steps at once, failures named at the end
bash scripts/ci.sh --fast   # what a workstation runs: check (no Rust), commit subjects, tests
```

- **Pre-commit** (`.githooks/pre-commit`, wired up by `install`): blocks staged state or credential
  files and added lines that look like tokens, then runs the Deno and shell check and the tests together,
  at low priority, when code changed. Deliberate bypass: `git commit --no-verify`.
- **Pre-push** (`.githooks/pre-push`): the commit subjects only. The gate is CI's.
- **CI** (`.forgejo/workflows/ci.yml`): the whole gate on every push to `dev`, to an agent's branch
  (`wf/*`, `agent/*`) and on pull requests, with its tools, Deno's cache and the pnpm stores kept between
  runs; it leaves its verdict as a git note on the commit (`refs/notes/ci`), which `deno task ship` waits
  for. Needs a runner with the `docker` label; the release's app build runs on `heavy`, the brain's image
  beside it.
- **Guards for Claude** (`shared/hooks/`): `branch-guard.sh` lets pushes to work branches through and
  asks before anything that reaches production — a protected branch, a stable version tag, a deleted or
  rewritten ref, `--no-verify`, `ship stable`; `destructive-blocker.sh` asks before broad deletions, lost
  work, destructive SQL and Docker volume removal, and denies what cannot be undone. Both are tested in
  `apps/cli/tests/guards_test.ts`.
- Every new invariant goes in `apps/cli/doctor/` — the README describes, the doctor verifies. Every new
  pure function gets a test in `apps/cli/tests/`.

---

## Don't

- Write into `~/.claude/` (it is a read-only stub) or change its permissions.
- Edit `~/.agents-multi/shared` — it is the app's copy (replaced at the next update) or a link into
  a checkout.
- Run `claude update` or `claude-bin update` by hand; use `agents update`.
- Put `~/.agents-multi` into a file-sync folder: it holds credentials, and backups containing
  tokens have leaked that way before.
- Update Claude Desktop with the app open.

## Environment variables

The variables are `AGENTS_MULTI_<NAME>` (`ROOT`, `CONFIG`, `PORT`, `VAULT`, `TASKS`, `BRAIN`, `ACCOUNTS`,
`PROFILE`, `BRAIN_SCOPE`, `OWNER_ID`, `OWNER_NAME`, `LANGUAGE`, `REPO`, `FETCH_TTL`, `FETCH_TIMEOUT`,
`NO_ASSISTANT_TRAILER`). The old `CLAUDE_MULTI_<NAME>` names are no longer read.

## License

Agents Multi is **open source** under the [GNU AGPL-3.0](LICENSE). Copyright © 2026 Samuel
Tagliacozzo. You may use it, study it, modify it and share it; whoever conveys it, or lets people use
a modified version over a network, gives them its source under the same licence and keeps the line
«Based on Agents Multi by Samuel Tagliacozzo» (the licence's additional terms). The name and the logo
are not part of the licence: [TRADEMARKS.md](TRADEMARKS.md).

Files taken from other projects keep their own licences: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Contributions are welcome under the contributor licence agreement in [CONTRIBUTING.md](CONTRIBUTING.md).

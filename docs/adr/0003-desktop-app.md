# 0003 — The desktop app: a Tauri 2 shell on the local console

- Status: accepted
- Date: 2026-10-07

## Context

Two pieces make Agents Multi an application today: the console, served by `agents serve` under a
systemd user unit (`claude-multi-console.service`, port from `PORT` in `apps/cli/lib/paths.ts`), and
the PySide6 tray (`apps/tray/`), which shows it in a Qt web view and adds the tray icon, «Hey» and the
profile picker. 1.0 replaces both with one Tauri 2 app (`apps/desktop/`) that a person installs like
any other: it starts what it needs and shows the console. Phase 5 builds it in pieces — the shell,
the backend as a sidecar, the tray and its windows, the first-run wizard — and this record is the
shell's.

## Decision

- **The window loads the console by URL** (`http://127.0.0.1:<port>/`), never a copy of `apps/ui`
  of its own (the package carries the page for the backend to serve). The console is same-origin by construction — relative URLs, server-sent events on
  `/api/events`, its cookies and CSRF header — and served from `tauri://localhost` it would be
  another origin, needing CORS on every route and a second build of the page. Loaded by URL, the
  window is one more browser on the console, and the page is the same in both.
- **The port follows the CLI**: `AGENTS_MULTI_PORT`, then `CLAUDE_MULTI_PORT`, else 7331
  (`src-tauri/src/console.rs`, with its tests).
- **A bundled local page waits for the console** (`apps/desktop/src/`, plain HTML, CSS and JavaScript,
  no build step). The window opens on it; it asks `GET /api/code` on the port (the app passes it as
  `?port=`), says clearly when nothing answers, retries by itself and on a button, and navigates to
  the console once it answers. The request is `no-cors`: an opaque answer is enough to know the
  console is up, so the console needs no CORS headers for it.
- **A window appears already showing the console** (`src-tauri/src/reveal.rs`): each window (the
  console's, the picker, Hey) is built hidden on the local page and shown when the console's page has
  finished loading in it, or after 1.5 s when it has not — then the local page says the console is slow
  or down, as before. So a console that answers at once (one already running, or the backend's cold
  start, measured well inside that time) never flashes «Connecting to the console…». A second launch that
  asks to raise a window still hidden leaves its activation token for the moment it is shown; the first
  launch's window is mapped then too, and GTK applies the launcher's token from the environment.
- **The backend is the package's Deno running the package's source** (phase 5, piece 2; the model
  is the next section's): started, supervised and stopped by the app (`src-tauri/src/backend.rs`) in
  place of the systemd unit. `apps/desktop/scripts/bundle.sh` (`pnpm bundle`; `pnpm build` runs it)
  prepares, gitignored under `src-tauri/`: the host's `deno` as the external binary
  `binaries/agents-multi-deno-<target triple>`, checked against the version pinned in that script;
  `bundle/repo/`, the source; `bundle/deno-dir/`, the module cache. Only
  `src-tauri/tauri.bundle.conf.json` declares them (`bundle.externalBin`, `bundle.resources` → `repo/`
  and `deno-dir/` in the resources), so `cargo build` and `tauri dev` never need them. Fetching Deno
  per target, for other platforms and for CI, is phase 6's.
  - **The source mirrors the repository's layout**, so every `REPO`-relative path keeps working:
    `REPO` (`apps/cli/lib/paths.ts`) is still the folder the code is in, now decoded (a macOS bundle
    sits under `Agents Multi.app`). It is the CLI's module graph (with the four brain modules it
    imports), and, as git tracks them, `apps/cli` without its tests (the old page under `/old/` is
    there), `shared/` (settings, hooks, the MCP registry and servers), `bin/` (the commands the
    console runs), `deno.json`, `deno.lock`, `CHANGELOG.md` («What's new»), plus the built
    `apps/ui/dist`; since the replacement step also what install, init and the doctor read
    (`desktop/`, `config.example/`, `pkg/`), and `build.json` (the version, the commit and a digest of
    the files: the build's name). Not bundled: `systemd/` (app mode installs no unit) and the git
    checkout itself.
  - **Offline modules: a module cache shipped as a resource** and used read-only (`DENO_DIR`), with
    `--cached-only` so a missing module is an error, never a download, and `DENO_NO_UPDATE_CHECK`.
    The script fills it with `deno cache --frozen` of the CLI and of each MCP server with its own
    lock (they run with `--no-config`), then drops what Deno compiled, which is keyed by path and
    recompiled in memory where the cache cannot be written. The CLI's graph has no npm: or jsr:
    module today; the servers' (29 MB) is there for the replacement step, which runs them on this
    Deno. Not `vendor`/`node_modules`: those would change how the repository itself resolves, for a
    need only the package has, and the servers each have their own lock.
  - **The cache is the backend's alone**: the app names it in `AGENTS_MULTI_BACKEND_ONLY`, and
    `serve` removes those variables from its environment as it starts (`forgetBackendOnly`), so
    Claude and its MCP servers, started from the console, keep the person's own writable cache. The
    package's Deno is handed on as `AGENTS_MULTI_DENO`, which `bin/agents` runs instead of `deno`, so
    the console's commands work on a machine without Deno.
  - **Which source** (`src-tauri/src/repo.rs`): `AGENTS_MULTI_REPO` (the name `bin/lib/prelaunch.sh`
    reads) when set, else in a debug build the checkout it was built from, else the package's copy.
    A checkout runs as a developer runs it, through its `bin/agents serve --no-open` (the Deno on
    `PATH`, `bin/agents`' permissions); the package's copy runs on the package's Deno. Without either,
    nothing is started and the log says why.
  - **Permissions**: `bin/agents`' set (`--allow-read --allow-write --allow-run --allow-env
    --allow-sys=hostname`) with the network open (`--allow-net`), not `-A`: `bin/agents` lists the
    brain's host, which comes from the person's `accounts.json`, read by Python in that script.
    Opening the network adds no reach the process lacks, since `--allow-run` already lets it start
    any program. A test in `backend.rs` keeps the list equal to `bin/agents`' but for the network.
  - **Lifecycle**: on start, if a console already answers `GET /api/code` on the port (the systemd
    unit during the transition, one started by hand), the app uses it and starts nothing, and never
    stops or restarts it. Otherwise it starts the backend (with `AGENTS_MULTI_PORT`, and the unit's
    `PATH` folders appended to its own, since a desktop session's `PATH` often lacks `~/.deno/bin`),
    its output appended to `backend.log` in the app's log folder. When it exits, a window showing the
    console goes back to the local page, which waits and returns, and the app restarts it after 1 s,
    doubling to 30 s; eight quick failures in a row (each run under a minute) and it stops trying.
    Before a restart, a console that answers in the meantime is used instead. On exit
    (`RunEvent::Exit`) the app sends SIGTERM to the process it started, SIGKILL after five seconds;
    on Linux the child also has a parent-death signal (SIGTERM), so it ends with the app even when
    the app is killed or crashes.
  - **The tray's «Start the console»**: when the app runs the backend, it starts it now — out of the
    backoff, or again after it gave up (`backend::start_again`); a console the app does not run (the
    unit) is still started with `systemctl --user start`.
  - **`std::process`, not tauri-plugin-shell**: the plugin's sidecar API only resolves the path
    (`<exe dir>/<name>`, which `backend.rs` does in one line) and its `kill()` is SIGKILL, with no
    graceful stop and no hook for the parent-death signal; it would also be a plugin carrying
    JavaScript commands. The backend is a Rust-only plugin with no commands, so no page can reach it.
- **Security model**:
  - No page gets IPC: the app declares no capabilities (`app.security.capabilities` is empty) and
    registers no plugin with JavaScript commands, so neither the local page nor the console's origin
    can call into the app. The opener crate is used from Rust only, without its plugin.
  - The main frame may show two origins, the bundled page and `http://127.0.0.1:<port>`
    (`src-tauri/src/navigation.rs`, with its tests). Any other web link (http, https, mailto) opens
    in the system browser; any other scheme is refused. A request for a new window (`target="_blank"`,
    `window.open`) never opens one: a web URL goes to the system browser, the console's included.
  - The local page has a CSP (`tauri.conf.json`): nothing but its own files, and connections only
    to `http://127.0.0.1:*`. The console's own headers govern the console.
- **One instance**: a second launch raises the running window and exits
  (`tauri-plugin-single-instance`). A compositor raises a window only with the launcher's proof
  that the user asked for it, an activation token, and the plugin forwards nothing but the second
  launch's arguments and working directory (over D-Bus on Linux). So on Linux the second launch
  executes itself again with the token added as `--activation-token=` (the environment kept, so a
  first launch still finds it there), and the running instance hands it to GTK as the window's
  startup id (`src-tauri/src/activation.rs`). When the window has not got the focus half a second
  later, it asks for attention — never always-on-top. What that gives:

  - From the app menu, KRunner, a `.desktop` file or a file manager (the launcher gives a token):
    on Wayland the window is raised, GTK activating it with `XDG_ACTIVATION_TOKEN`
    (xdg-activation-v1); on X11 it is presented with the launch time from `DESKTOP_STARTUP_ID`, and
    the window manager's focus-stealing prevention has the last word.
  - From a terminal, or any launcher that gives no token: on Wayland the window is not raised —
    KWin refuses the activation GTK asks for on its own and highlights the taskbar entry; on X11 the
    window manager decides, and if it refuses, the urgency hint highlights the taskbar entry.

  GTK 3 ignores the urgency hint on Wayland, so there the highlight is the compositor's own answer
  to a refused activation; other compositors may show nothing. Tao (the window layer) has no
  activation-token support of its own, and its focus call is a plain `present`, which is why the
  token goes through GTK directly.
- **The window's identity on Linux is the bundle identifier.** A Wayland compositor ignores icons set
  by the app: it takes the window's app_id and reads `<app_id>.desktop` from the XDG data dirs for
  the icon and the name (KWin otherwise shows the generic Wayland icon). GTK 3 sends the program name
  as the app_id, which was the binary's name (`agents-multi-desktop`) and matched no desktop file,
  while the bundler (tauri-bundler 2.10.1, the Tauri CLI's) always names its desktop file after the
  product name (`Agents Multi.desktop`). So:
  - the app sets the program name to the identifier before GTK starts (`set_app_id` in `main.rs`),
    and the X11 class (WM_CLASS) to the same after GTK's init, which resets it;
  - on Linux the product name _is_ the identifier (`tauri.linux.conf.json`), so the bundles' file is
    `net.local.agents-multi.desktop`; its template (`src-tauri/linux/app.desktop`) writes the shown
    name, `Agents Multi`, and `StartupWMClass` from the same product name; `Icon=` is the binary's
    name, under which the bundler installs the icons;
  - `build.rs` fails the build when the Linux product name and the identifier differ.

  The price: the deb and rpm packages are named after the product name too
  (`net-local-agents-multi`, `net.local.agents-multi`). The window icon (X11, the task switcher) is the
  first PNG in `bundle.icon`, the 256-pixel one. The AppImage reuses the deb's desktop file; it was not
  built here.
- **The bundle identifier is provisional**: `net.local.agents-multi`, in `tauri.conf.json` and, as
  the product name, in `tauri.linux.conf.json` (`build.rs` keeps the two equal). It is decided
  before phase 6 (signed releases and the updater), since changing it afterwards moves the app's data
  directories, its desktop file and its package names, and breaks updates.
- **Versions**: the app's version is `apps/desktop/package.json`'s, listed in `MANIFESTS` and read by
  `tauri.conf.json`; Cargo's own version stays `0.0.0`. Rust crates are pinned exactly in
  `Cargo.toml`, with `Cargo.lock` committed; the Tauri CLI is a pinned devDependency (pnpm, like
  `apps/ui`).
- **Linux first**: the app is built and checked on Linux (WebKitGTK). macOS and Windows come with
  1.x; the code avoids what would tie it to Linux (the bundled page's origin is recognised on all
  three).

## 1.0: the app ships everything (Samuel, 2026-10-07)

- **The package carries everything it runs**: the backend, the console's page, `shared/` (hooks,
  settings, MCP servers) and **one Deno runtime**, which runs both the backend and the MCP servers
  from the bundled source. No git checkout on a user's machine.
- **Updates** come from Tauri's signed updater, its manifest on the project's own site (e.g.
  `/updates/<channel>.json`), the artifacts wherever they are hosted (GitHub Releases or our server):
  renaming or moving the repository changes one line in the manifest, never the installed apps.
  **AUR** is an extra channel for Arch (the same release, the updater disabled in that build: pacman
  updates it); Homebrew and winget later.
- **`~/.agents-multi/shared`** becomes a versioned copy the app installs on each update (today it
  is a link into the repository). **Dev mode** keeps today's model: `AGENTS_MULTI_REPO` points at a
  checkout.
- **Extensibility stays in the person's configuration** (`~/.agents-multi/config`): their own MCP
  servers (any command: npx, uvx, deno, a binary) and templates, registered without waiting for a
  release.
- **Ready for «native Rust, a real binary» after 1.0**: the console's page talks to the backend only
  through `apps/ui/src/api.ts`. After the release, endpoint by endpoint, the backend's work moves into
  Rust commands (the page switches `fetch` to `invoke` for that endpoint), our MCP servers move to
  Rust (rmcp) one at a time, and when nothing needs Deno it leaves the package. Every step is
  releasable; there is no big rewrite.

## The replacement step: installed machines run the app (done, 2026-10-07)

Samuel's decisions: every machine, his included, runs the packaged app; a git checkout is for
development only; nothing in app mode depends on systemd (macOS and Windows come with 1.x).

- **Two modes, decided in one place** (`apps/cli/lib/mode.ts`, and `cm_mode` in `bin/lib/profiles.sh`
  reading the same link): **app** when `~/.agents-multi/shared` links to `app/current/shared`,
  **dev** when it links to a checkout's `shared` (an absolute link, as every earlier install made it).
  A machine with no runtime yet takes the running code's: a checkout installs dev, the app's code app.
  The installation decides, not the code running: the app's backend (the package's code) on a dev
  machine keeps the installation's checkout, and a checkout's `bin/agents` on an app machine installs
  into the app's copy.
- **The copy** (`apps/cli/appcopy.ts`): the package's code is copied, as it is, into
  `~/.agents-multi/app/<version>-<digest>/` (the digest from `build.json`, so two builds of one version
  differ), then swapped in by renaming a new link over `app/current`; the build before becomes
  `app/previous`, older ones go. `shared` is the link `app/current/shared`, so it never changes on an
  update and a reader sees one build or the other. Not `shared` itself as a real folder: the launchers
  need `bin/` and the CLI beside it, and a copy of one folder can only be swapped atomically through
  a link. Links to skills installed by other tools (absolute links that install puts in
  `shared/skills`) are carried into the new build. The same for deb, rpm and AppImage: the package's
  path is never linked into the runtime, since an AppImage's mount moves at every run.
- **Launchers** (`~/.local/bin/claude`, `claude-<profile>`, `agents`, …) point into
  `~/.agents-multi/app/current/bin`, so an update moves them all at once. `prelaunch.sh` does git
  work only in dev mode (or when `AGENTS_MULTI_REPO` names a checkout); it still regenerates the
  settings. `self-update` and `sync` have nothing to pull in app mode; `self-update` settles an
  install left waiting.
- **No systemd in app mode.** The console's unit and the PySide6 app's unit are stopped, disabled and
  removed in both modes; in app mode install removes every unit of ours (a link into some code's
  `systemd/user`) and installs none. The timers' jobs — task reminders on the clock every five
  minutes, the brain backup (10 min after start, then every 30), Claude Code and Desktop updates with
  `doctor --notify` (10 min, then every 4 h), stignore-gen (2 min, then every 15) — are run by the
  console's backend while it runs in app mode (`apps/cli/console/schedule.ts`), under the conditions
  install enabled their timers on, never two at once, each with a time limit. The app starts at login
  from an XDG autostart entry with `--tray` (`desktop/autostart.desktop.in`, written by install where
  there is a session and the app is installed). Dev mode keeps the timers. The doctor's checks follow
  the mode. Install leaves the systemd manager alone when its HOME is not this HOME (a sandbox, a
  test: `machine().systemd`), and still removes this HOME's unit files.
- **MCP servers**: in app mode the registry's `deno` servers, `launch.ts` and the guard hooks run on
  `~/.agents-multi/bin/deno` (`denoFor` in `apps/cli/mcp/registry.ts`), a link to the package's Deno
  (a copy out of an AppImage) refreshed by `install --app`; Claude and Desktop start servers with
  their own PATH, which need not have one. In dev mode the `deno` on PATH, as before. The servers use
  **the person's writable Deno cache**, never the package's read-only one (it is the backend's
  alone), and `install --app` **seeds** it with the package's cache, copying only the files it lacks:
  a server then starts offline on its first run and without a download inside Claude's MCP start-up
  time, the cache stays the person's (Deno writes it, other Deno programs share it), and what is
  copied is exactly what the servers' locks pin. `bin/agents` runs on the same Deno in app mode, so a
  terminal needs none.
- **Install is run by the app** (`src-tauri/src/install.rs`): a release build running the package's
  code writes the build it carries (`$XDG_STATE_HOME/claude-multi/app-build.json`) and, when the
  copy's build differs, runs `agents install --app` (`apps/cli/appinstall.ts`) from its package, with
  its Deno and module cache, before its backend starts — after an update, then, before the console
  is shown. `install --app` is idempotent: it installs the copy, links the package's programs, seeds
  the cache, then runs install (in app mode, without printing the doctor), or — with a Claude open
  on an existing installation — leaves it waiting (`install-pending`) for the console's «Close Claude
  and update» or the next scheduled round. It refuses a dev installation (that is the migration's)
  and a machine without a configuration (the first-run wizard's). Its result goes to
  `app-install.json`, which the doctor turns into `app.install` on the health page; the app's own log
  is `install.log`. The first-run wizard and the update flow (ADR 0004) call the same command.
- **The doctor in app mode**: the repository's git checks give way to `app.version` (the build the
  app carries and the copy's agree), `app.copy`, `app.install`, `runtime.shared` (the link to the
  copy) and the launchers against the copy; the console's unit check to `console.unit` (the retired
  units still there) and `console` (something answers on the port); the app's PySide6 dependencies to
  the app's executable and its autostart entry. Dev mode keeps its checks and the dev-checkout note.
- **Migration** (`agents migrate app [--from <dir>] [--dry-run] [--rollback [--to <checkout>]]`,
  `apps/cli/migrate-app.ts`), with every Claude closed: the package's code (beside the installed
  app's executable, or `--from`) becomes the copy, install runs in app mode (links, units, autostart),
  the MCP servers are placed again on the stable Deno, and the checkout's sync state goes. The
  configuration, the vault, the brain login and the profiles are not touched. The checkout is
  recorded (`migrate-app.json` in the state folder); `--rollback` points `shared` back at it, runs
  that checkout's own install and `mcp sync`, and removes the copy and the runtime's `bin/`. Tested
  on a fixture runtime in a throwaway home (`apps/cli/tests/migrate_app_test.ts`).
- **The PySide6 app** goes: `bin/claude-multi-app` runs the desktop app (the runtime's link, or the one
  on PATH; from a checkout with `AGENTS_MULTI_REPO` set to it), `desktop/claude-multi.desktop` goes
  (the package has its own entry) and install removes the copy it wrote; the picker's entry stays.
  `apps/tray/` is removed, and with it the check's Python step.

## The tray, the launch flags and the profile picker (phase 5, piece 3)

The app takes over what `apps/tray/app.py`, `tray.py`, `picker.py` and `hey.py` do, in its own modules
(`flags.rs`, `controller.rs`, `tray.rs`, `http.rs`, `profiles.rs`, `picker.rs`, `hey.rs`), with `main.rs` only
wiring them.

- **Flags are the tray app's**: none shows the console window (on Today, as `show` did), `--tray`
  starts in the tray without a window, `--pick` opens the picker, `--hey` opens «Hey Claude» (below). The first match wins in
  the tray app's order. A second launch hands its arguments to the running app through the
  single-instance plugin, which routes them like its own; `--tray` there does nothing.
- **Lifetime**: with a tray, closing the console window hides it and the app lives in the tray; Quit
  is in the menu. Without one the app quits with its last window. `--tray` waits up to a minute for a
  tray host (at login it can come up after the app), then says so and exits; any other launch looks
  once. On Linux a tray host is a StatusNotifier watcher on the session bus — the one kind the app's
  tray speaks — asked with `zbus` (already in the tree through the single-instance plugin). The
  answer goes to `$XDG_STATE_HOME/claude-multi/app.json`, the file the doctor's `app.tray` check reads.
  The tray app's other habit — destroying a window hidden for twenty minutes to free the web engine —
  is not carried over.
- **The tray reads the console from Rust**, over HTTP on 127.0.0.1 (`http.rs`: a GET, a chunked or
  sized body; no client library, since a stream's silence has to fail one read, not the whole body).
  It draws `/api/summary` with the tray app's headline, lines, dot and menu (`tray::view`, with its
  tests); it refetches on a `state` event of `/api/events` (a second after the last of a burst), never
  on a timer; a stream silent for 70 s is dead; reconnection backs off 2, 4, 8, 16, then 30 s; the
  menu is rebuilt only when what it shows changes. The profiles of «Open Claude Desktop» come from
  the manifests (`profiles.rs`, the CLI's rule), so the menu opens a Desktop with the console down;
  its actions are CLI commands (`claude-launch`; `systemctl --user start` of the console's unit when the
  app does not run the backend, else the backend) or the app's windows.
- **On Linux the tray is a StatusNotifierItem of the app's own** (`tray/sni.rs`, the `ksni` crate),
  not Tauri's: Tauri's goes through libayatana-appindicator there, which reports no click, so any
  click opened the menu. The item has `Activate`: the left click shows the console window, or hides
  it when it is shown and has the focus (`controller::toggle_console`, the tray app's rule); the menu
  is on the right click. It draws the same `tray::View` as Tauri's tray elsewhere — icon with its dot,
  the menu, the tooltip (the headline as its title, the other lines as its text). `ksni` runs on the
  `zbus` already in the tree, on its async-io executor (features `async-io` and `blocking`, not the
  default tokio), so there is one D-Bus stack; Tauri's `tray-icon` feature is enabled on the other
  systems only. KDE hands an item an activation token before `Activate`
  (`ProvideXdgActivationToken`, a KDE extension) that `ksni` 0.3.6 does not implement: the window a
  click shows is raised as far as the compositor allows a request without a token.
- **The picker is a page of the console** (`apps/ui/src/pages/pick/`, `/#pick`, drawn without the
  console's frame) in a small frameless window, loaded by URL through the local page like the main
  window: it gets no IPC. Its action goes through **a new endpoint, `/api/launch`** (`GET` the
  profiles from the manifests, `POST {profile}` to run `claude-launch` through the same function as
  «Close Claude and update»'s reopen step, which starts only a declared profile). `/api/close-claude`'s
  `reopen` step would have run the same command, but it belongs to that flow's contract, and a picker
  calling «close Claude» to open one would break silently the day that flow changes. The page asks for
  its window to close (after a choice, on Esc) by setting its title to `agents-multi:close`, which the
  app watches on that window only: `window.close()` would not do — wry answers WebKitGTK's close
  signal by destroying the web view alone, leaving an empty window. The window also closes when it loses the focus, once it has had
  it. With the console down the picker shows the local page, waiting, until the sidecar makes that
  rare. The tray menu's own «Open Claude Desktop» stays a CLI command.
- **«Hey Claude» is a page of the console too** (`apps/ui/src/pages/hey/`, `/#hey`, drawn without the
  console's frame) in a small frameless window (`hey.rs`), opened by `--hey`, a second launch with
  `--hey` (raised with its activation token, as the console window is), and the tray's «Hey Claude…».
  It does what `apps/tray/hey.py` did through endpoints that already exist, so none was added: the
  question streams from `/api/ask` (kind `ask`, the same tools and prompt as the field at the foot of
  Today), a follow-up passes the session back, the model is the one shared with that field
  (`/api/ask/model`), and «Continue in the terminal» / «Open Claude Code in <folder>» are
  `/api/terminal` (`resume`; `cwd` and `ask`). Esc aborts the request — which stops `claude -p` on the
  server — and closes. The model is a button that cycles through the choices rather than a `<select>`,
  whose popup would take the focus from the window and close it.
  - **The window fits the page**: the page tells it its height through its title,
    `agents-multi:size=<px>` (`,answer` added while an answer is on screen), next to the picker's
    `agents-multi:close` (`apps/ui/src/lib/window.ts`; parsed and clamped by `hey::message`, with its
    tests). It closes when it loses the focus, once it has had it, unless an answer is there to keep
    reading (hey.py's rule). It opens at the top centre of the screen under the pointer, 22% of the way
    down; on Wayland the compositor places it.
- **The app speaks to a page only by setting its location** (a view's hash, validated as lowercase
  words and slashes on both sides, `flags::is_view` and the local page); pages still cannot call it.

The replacement step (above) made the app the tray app: the autostart entry runs it with `--tray`,
the picker's entry runs `claude-multi-app --pick`, which runs the app, and the KDE shortcut for «Hey
Claude» (`~/.local/bin/claude-multi-app --hey`) reaches it the same way and opens the Hey window. The doctor checks the app's executable and its autostart entry in place of
pyside6 and the unit.

## Development

- **A development instance beside the installed app**: in a debug build,
  `AGENTS_MULTI_DEV_INSTANCE=<name>` gives the app a single-instance identity of its own
  (`src-tauri/src/instance.rs`): on Linux the plugin's D-Bus name becomes
  `<identifier>.dev_<name>.SingleInstance`, elsewhere the plugin is left out. So a build under test
  runs on the normal session bus next to the installed app instead of handing its launch over to it,
  and a second launch with the same name still reaches it. Give it a port of its own too
  (`AGENTS_MULTI_PORT`), or it uses the console already on 7331. A development instance does not
  write `app.json` (the doctor's `app.tray`), which belongs to the session's app. Release builds
  ignore the variable.
- **Not `dbus-run-session`**: a private bus starts its own secret service, and KDE Wallet asks for its
  password at every run.
- **The doctor run from another checkout** (a development console, `bin/agents doctor` in a worktree)
  checks the installation's links against the installed repository — what `~/.agents-multi/shared`
  points at — and says once that it runs from a development checkout (`repo.running`), instead of
  failing every link.

## Consequences

- Until a machine is migrated (`agents migrate app`), its console unit and the app can both serve
  the console; whichever starts first serves the port (the app uses a running unit; a unit started
  after the app fails to bind and retries). The migration removes the unit.
- An update replaces the copy under running Claude sessions, as a pull did in dev mode; what install
  rewrites besides waits for them to be closed.
- A console the app started that dies sends the window back to the local page; one it did not start
  (the unit, by hand) is not supervised, and its death leaves the console's own reconnect behaviour
  on screen.
- The package grows with what it carries (Linux x86_64, release): the deb is 4.2 MB without a backend,
  51 MB with it (128 MB installed: Deno 92 MB, the module cache 29 MB, the source 2.7 MB). A
  `deno compile`d CLI, the first version of this piece, made it 38 MB (117 MB installed) and still
  needed a checkout for everything but the code.
- Deno is a release input like the Rust crates: its version is pinned in `scripts/bundle.sh`, and a
  bump is a deliberate change there.
- `scripts/check.sh` runs `cargo fmt --check` and `cargo clippy -D warnings` on the app where cargo
  and WebKitGTK are installed and skips it elsewhere; CI's image has neither, so CI does not check
  the Rust until it installs them.

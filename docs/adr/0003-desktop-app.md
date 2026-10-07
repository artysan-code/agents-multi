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

- **The window loads the console by URL** (`http://127.0.0.1:<port>/`); the app does not bundle
  `apps/ui`. The console is same-origin by construction — relative URLs, server-sent events on
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
- **The backend is a sidecar** (phase 5, piece 2): the CLI compiled with `deno compile`
  (`apps/desktop/scripts/sidecar.sh`, into `src-tauri/binaries/agents-multi-backend-<target triple>`,
  gitignored), started and stopped by the app (`src-tauri/src/backend.rs`), in place of the systemd
  unit. `tauri build` bundles it through `bundle.externalBin`, which only
  `src-tauri/tauri.sidecar.conf.json` declares (`pnpm build` passes it): `cargo build` and
  `tauri dev` never need it.
  - **The repository is passed in**: a compiled binary's modules live in a virtual file system, so
    `REPO` (`apps/cli/lib/paths.ts`, the only use of `import.meta.url` for a path in the CLI's graph)
    is `AGENTS_MULTI_REPO` when set — the name `bin/lib/prelaunch.sh` already reads — else today's
    checkout; a compiled binary without it stops with a clear error. (`AGENTS_MULTI_ROOT` was taken:
    it names the runtime.) The app finds the repository (`src-tauri/src/repo.rs`): the variable when
    set, the checkout it was built from in a debug build, else the target of the runtime's `shared`
    link (`~/.agents-multi/shared` → `<repo>/shared`, made by `agents install` on every machine),
    checked by `apps/cli/main.ts` being there. With no repository found, nothing is started and the
    log says why.
  - **Permissions**: `bin/agents`' set (`--allow-read --allow-write --allow-run --allow-env
    --allow-sys=hostname`) with the network open (`--allow-net`), not `-A`: `bin/agents` lists the
    brain's host, which comes from the person's `accounts.json` and is unknown when the binary is
    built, and permissions are fixed at compile time. Opening the network adds no reach the process
    lacks, since `--allow-run` already lets it start any program. No FFI and no dynamic imports.
  - **Lifecycle**: on start, if a console already answers `GET /api/code` on the port (the systemd
    unit during the transition, one started by hand), the app uses it and starts nothing, and never
    stops or restarts it. Otherwise it starts the sidecar (`serve --no-open`, with
    `AGENTS_MULTI_PORT`, `AGENTS_MULTI_REPO`, and the unit's `PATH` folders appended to its own, since
    a desktop session's `PATH` often lacks `~/.deno/bin`), its output appended to `backend.log` in the
    app's log folder. When it exits, a window showing the console goes back to the local page, which
    waits and returns, and the app restarts it after 1 s, doubling to 30 s; eight quick failures in a
    row (each run under a minute) and it stops trying. Before a restart, a console that answers in
    the meantime is used instead. On exit (`RunEvent::Exit`) the app sends SIGTERM to the process it
    started, SIGKILL after five seconds; on Linux the child also has a parent-death signal (SIGTERM),
    so it ends with the app even when the app is killed or crashes.
  - **`std::process`, not tauri-plugin-shell**: the plugin's sidecar API only resolves the path
    (`<exe dir>/<name>`, which `backend.rs` does in one line) and its `kill()` is SIGKILL, with no
    graceful stop and no hook for the parent-death signal; it would also be a plugin carrying
    JavaScript commands. The backend is a Rust-only plugin with no commands, so no page can reach it.
  - **Dev mode**: a debug build uses the sidecar when it sits next to the executable (`pnpm tauri
    build --debug --config src-tauri/tauri.sidecar.conf.json` puts it there), else the checkout's
    `bin/agents serve --no-open` (Deno, with `bin/agents`' own permissions). A release build without
    the sidecar starts nothing and says so in its log; the local page then explains the console is
    not reachable.
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

## The tray, the launch flags and the profile picker (phase 5, piece 3)

The app takes over what `apps/tray/app.py`, `tray.py` and `picker.py` do, in its own modules
(`flags.rs`, `controller.rs`, `tray.rs`, `http.rs`, `profiles.rs`, `picker.rs`), with `main.rs` only
wiring them.

- **Flags are the tray app's**: none shows the console window (on Today, as `show` did), `--tray`
  starts in the tray without a window, `--pick` opens the picker, `--hey` opens the console and logs
  that «Hey Claude» is not ported yet (`controller::show_hey` is its place). The first match wins in
  the tray app's order. A second launch hands its arguments to the running app through the
  single-instance plugin, which routes them like its own; `--tray` there does nothing.
- **Lifetime**: with a tray, closing the console window hides it and the app lives in the tray; Quit
  is in the menu. Without one the app quits with its last window. `--tray` waits up to a minute for a
  tray host (at login it can come up after the app), then says so and exits; any other launch looks
  once. On Linux a tray host is a StatusNotifier watcher on the session bus — the one kind the app's
  indicator speaks — asked with `zbus` (already in the tree through the single-instance plugin). The
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
  its actions are CLI commands (`claude-launch`, `systemctl --user start` of the console's unit) or the
  app's windows. On Linux the indicator has no click, tooltip or «menu about to open» events: the menu
  opens on any click, and the tooltip shows on the other systems only.
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
- **The app speaks to a page only by setting its location** (a view's hash, validated as lowercase
  words and slashes on both sides, `flags::is_view` and the local page); pages still cannot call it.

When the app replaces the tray app, that step changes:

- `systemd/user/claude-multi-app.service`: `ExecStart` runs the app with `--tray` (or the unit gives way
  to an autostart entry the app installs), and `apps/cli/install.ts` enables whichever it is.
- `desktop/claude-multi.desktop` and `desktop/claude-multi-launcher.desktop`: `Exec` runs the app (no
  flag, and `--pick`); `bin/claude-multi-app` goes, or becomes a link to the app.
- The KDE shortcut for «Hey Claude» (`~/.local/bin/claude-multi-app --hey`) points at the app once Hey
  is ported; until then `--hey` there would only open the console.
- The doctor's `app.deps` (pyside6, qt6-webengine) becomes the app's own (WebKitGTK,
  libayatana-appindicator), and its `app.tray` fix names the app's unit; the README's section on the
  desktop app is rewritten; `apps/tray/` is removed.

## Consequences

- `apps/tray/`, `systemd/` and the unit written by `apps/cli/install.ts` stay until the app replaces
  them; until then both can show the console (and a tray icon) at once, and whichever starts first serves the port (the
  app uses a running unit; a unit started after the app fails to bind and retries). The step that
  replaces them on installed machines must: stop and disable `claude-multi-console.service` and
  remove its file (install, and a migration for machines that have it), have install stop writing it,
  make the doctor's console check expect the app instead of the unit, start the app at login in place
  of the tray, and keep `agents serve` working by hand for headless machines, where there is no app.
- A console the app started that dies sends the window back to the local page; one it did not start
  (the unit, by hand) is not supervised, and its death leaves the console's own reconnect behaviour
  on screen.
- The sidecar is about 100 MB (the Deno runtime) and is built per target: `deno compile --target`
  covers Linux, macOS and Windows on x86_64 and aarch64, so the 1.x platforms need no other tool.
- The repository must exist on the machine: the sidecar ships the CLI's code, not `shared/`, the
  console's page or the git checkout it updates.
- `scripts/check.sh` runs `cargo fmt --check` and `cargo clippy -D warnings` on the app where cargo
  and WebKitGTK are installed and skips it elsewhere; CI's image has neither, so CI does not check
  the Rust until it installs them.

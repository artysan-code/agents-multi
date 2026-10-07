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
- **The backend becomes a sidecar** (phase 5, piece 2): the CLI compiled with `deno compile`,
  started and stopped by the app, in place of the systemd unit. Its place is marked in `main.rs`'s
  `setup`, before the window opens; the local page already waits for whatever serves the port.
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
- **One instance**: a second launch focuses the running window and exits
  (`tauri-plugin-single-instance`).
- **The bundle identifier is provisional**: `net.local.agents-multi`, in `tauri.conf.json` only. It
  is decided before phase 6 (signed releases and the updater), since changing it afterwards moves
  the app's data directories and breaks updates.
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
  them; until then both can show the console at once, and both can show a tray icon.
- The window shows whatever answers on the port: a console that dies after the page navigated
  leaves the console's own reconnect behaviour on screen, not the local page.
- `scripts/check.sh` runs `cargo fmt --check` and `cargo clippy -D warnings` on the app where cargo
  and WebKitGTK are installed and skips it elsewhere; CI's image has neither, so CI does not check
  the Rust until it installs them.

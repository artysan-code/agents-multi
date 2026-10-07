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

## Consequences

- `apps/tray/`, `systemd/` and the unit written by `apps/cli/install.ts` stay until the app replaces
  them; until then both can show the console at once, and whichever starts first serves the port (the
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

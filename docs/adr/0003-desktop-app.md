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

## Consequences

- `apps/tray/`, `systemd/` and the unit written by `apps/cli/install.ts` stay until the app replaces
  them; until then both can show the console at once.
- The window shows whatever answers on the port: a console that dies after the page navigated
  leaves the console's own reconnect behaviour on screen, not the local page.
- `scripts/check.sh` runs `cargo fmt --check` and `cargo clippy -D warnings` on the app where cargo
  and WebKitGTK are installed and skips it elsewhere; CI's image has neither, so CI does not check
  the Rust until it installs them.

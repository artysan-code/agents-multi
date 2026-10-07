# 0004 — Releases of the desktop app

- Status: accepted
- Date: 2026-10-07

## Context

ADR 0002 decided how versions are cut and that the desktop app updates through Tauri's signed updater,
its artifacts on GitHub and its manifest on the project site; ADR 0003 that the app ships everything it
runs. This record is phase 6: how a tag becomes installable bundles and an update the installed apps
see, how the app updates itself, and what the owner holds. On 2026-10-07 the owner added that updating
is the console's to show: one «Update now» screen that downloads, installs and relaunches the app and
everything it runs, then says what changed.

## Decision

### One place for each fact

- **`apps/desktop/release.json`**: the project site that serves the manifests (`site`), the GitHub
  repository that holds the artifacts (`github`, owner/name), the AUR package (`aur`) and its licence
  (`license`, SPDX). `build.rs` compiles `site` into the app; the release scripts read the rest. Empty,
  the app has no updates (`not-configured`) and `scripts/app-release.ts check` stops a release.
- **The updater's public key**: `plugins.updater.pubkey` in `tauri.conf.json`, Tauri's own place, with
  `requireSignedVersion`: the signature's trusted comment carries the version (the Tauri CLI writes
  `version:` there), so a tampered manifest cannot pair a version number with another release's file.
- **The bundle identifier** stays where ADR 0003 put it. Nothing here repeats it: the assets are named
  `agents-multi_<version>_amd64.deb`, `agents-multi-<version>-1.x86_64.rpm` (a beta's `~beta.N`) and
  `agents-multi_<version>_amd64.AppImage` whatever the identifier, and the AUR script reads it from
  `tauri.conf.json`. Changing it before 1.0 is still that one change (ADR 0003); after 1.0 it moves the
  app's folders and package names, so it does not change.

### From a tag to an update

1. `deno task release` (stable on `release`, `beta` on `beta`) bumps every manifest, the app's
   included, and tags. The owner pushes the branch and the tag.
2. `.forgejo/workflows/release.yml`, job `app`, on the tag: the tag must be the app's version; the
   release configuration must be filled; then the gate (`scripts/ci.sh`, the Rust included since the
   job installs it), the console's page (`agents ui build`), and `pnpm release` in `apps/desktop` —
   `bundle.sh` and `tauri build` with `tauri.release.conf.json`, which turns on the updater artifacts:
   each bundle gets a `.sig` made with `TAURI_SIGNING_PRIVATE_KEY`. Only that configuration asks for
   the key, so `pnpm build` on a workstation needs none.
3. `app-release.ts prepare` copies the bundles under their stable names and writes `latest.json`, the
   version's manifest in Tauri's static format: one platform per package kind
   (`linux-x86_64-deb`, `-rpm`, `-appimage`, which the updater asks for first) and `linux-x86_64`, the
   AppImage, for anything else; the notes are the version's CHANGELOG section.
4. `app-release.ts publish` makes the GitHub release: it waits for the tag to reach GitHub through the
   push mirror (a release made before would make GitHub create the tag on its default branch), creates a
   draft, uploads, then publishes it — a pre-release for a beta. It is idempotent, and never replaces an
   asset: a version's files do not change.
5. `app-release.ts channels` moves the site's manifests, `apps/site/public/updates/<channel>.json`, to
   the version, and for a stable version `scripts/aur.ts render` writes `pkg/agents-multi-bin/`. They
   are committed on `release` (`chore(updates): vX.Y.Z on its update channels`) and pushed; that push
   redeploys the brain's image, which builds the site and serves them. Then the AUR package is pushed
   when the AUR key is there.

**The runner image** is still `node:22-bookworm`; the job installs WebKitGTK's headers, `patchelf` and
`file` from apt and Rust with rustup at a pinned version (`RUST_VERSION`), and caches Cargo's target.
Deno is pinned in the workflow and in `bundle.sh`, which refuses any other. A dedicated image would save
the installs on every release; it is not needed for correctness. The AppImage tooling (linuxdeploy) is
downloaded by the Tauri CLI at build time, unpinned, and runs with `APPIMAGE_EXTRACT_AND_RUN` (no FUSE in
a container).

### Why the manifests are committed on `release`

The site is the brain's image, rebuilt by Coolify on every push to `release`. Three ways for a manifest
to reach it were weighed:

- **Committed by CI** (chosen): a static file, its history the release history, a rollback a commit;
  no new endpoint, no runtime dependency, and the redeploy is the one a push to `release` already
  triggers. The cost: the workflow pushes one commit to `release` per release, a beta's included, and
  the owner pulls before cutting the next version.
- Uploaded to the brain through an authenticated endpoint: a write API and a token on the service that
  holds the owner's memory, and release state outside git.
- Proxied by the brain from GitHub's releases at request time: every brain instance depending on
  GitHub's API and its rate limits, and a rollback done by editing releases.

The site answers `/updates/stable.json` and `/updates/beta.json` from its build, revalidated on every
request (`no-cache` with an ETag), never filled with the instance's particulars (their URLs are the
artifacts'). A channel without a manifest yet answers 204, which the updater reads as «nothing newer»
(`apps/brain/public.ts`).

### Channels

`stable` follows `release`, `beta` follows `beta`. A stable version is written to both manifests when
it is newer than the last beta, so a beta never lags behind a stable; a beta only to `beta`. A manifest
never moves back by itself (a workflow run again for an old tag changes nothing). The app follows `beta`
when it is a beta build, and writes `beta` to `update-channel` in its config folder so the stable version
a beta ends in keeps following betas; deleting that file (or writing `stable`) leaves the channel, and
`AGENTS_MULTI_UPDATE_CHANNEL` overrides both.

### The update in the app

The app owns the updater (`src-tauri/src/updater.rs`); the console shows it.

- **Checks** a minute after start, then daily by the wall clock, and when the console asks. A newer
  version is downloaded in the background and verified before it is kept (in memory, until installed).
- **The contract**, `GET /api/app/update` on the console: `{ app, current, channel, state, available:
  { version, notes, date } | null, progress?, error?, off?, updated?: { from, to }, checkedAt? }`, the
  states `idle`, `checking`, `downloading`, `ready`, `installing`, `restarting`, `error`; `app` is false
  where no app answers (a headless `agents serve`). Each change is the `app-update` event on
  `/api/events`; the page never polls. `POST /api/app/update` with `{ action }` and the anti-CSRF
  header: `check`, `install` (download when needed, install, relaunch) and `dismiss` (the «updated»
  screen was shown). 400 for another action, 503 without an app, 409 when the app refuses (updates off).
- **The local channel** is a unix socket of the app's, `$XDG_RUNTIME_DIR/agents-multi-app.sock`, mode
  600 in a folder only the user can open; one JSON line per request (`status`, `watch`, `check`,
  `install`, `dismiss`), and `watch` keeps the connection to send the status on every change
  (`updater/socket.rs`). The backend follows it on one connection, again after the app goes (2 s
  doubling to 30 s), and relays (`apps/cli/console/app-update.ts`). The socket's file permission is the
  authentication: a loopback HTTP endpoint would have needed a server in the app and a token in a file
  with the same protection; IPC from the page was ruled out by ADR 0003 (no page reaches the app); a
  status file the console reads, the first draft, cannot carry the page's requests. The name is not
  the old PySide app's (`claude-multi-app.sock`). A development instance has its own
  (`agents-multi-app.dev_<name>.sock`), which the app hands to the backend it starts as
  `AGENTS_MULTI_APP_SOCKET`; `bin/agents` allows that path (Deno checks unix sockets as network).
- **Installing**: a deb or an rpm is installed with `pkexec dpkg -i` / `rpm -U`, which asks for an
  administrator's password; an AppImage replaces its own file. Then the app leaves `updated.json` in its
  data folder, says `restarting`, waits a moment for the console to tell the page, and relaunches —
  itself and what it runs: the backend stops with it and starts with the new version, as do the tray
  and the windows. At start the new version finds the note (`after_relaunch`), sets `updated` in the
  status, and opens the console on the update screen (`system/updates`), whatever the launch asked.
  The install of what changed (`agents install --app`, `install.rs`, ADR 0003) runs before the
  backend starts, so before the console the window waits for. A note
  for another version than the running one is an error («the update did not take»).
- **An AppImage installs on quit** a version it downloaded and did not install, since that asks nothing,
  and leaves the same note. A deb or an rpm never does: a quit must not ask for a password. The app
  never restarts on its own.
- **Off**, said in the status: built without the `updater` Cargo feature (`build`), no site or key
  (`not-configured`), not a bundle (`not-packaged`: `cargo run` and `tauri dev`, where installing would
  overwrite the binary), or a package manager owns it (`package-manager:<name>`, from a
  `package-manager` file in the app's resources).
- **Told**: once per version a desktop notification (normal urgency, eight seconds), and while a version
  is there the tray says so with «Update Agents Multi…», which opens the update screen.
- The updater plugin carries JavaScript commands; no capability grants them, so no page can call them.

### AUR

`agents-multi-bin` repackages the release's deb (`scripts/aur.ts render`): the deb's dependencies in
pacman's names (WebKitGTK 4.1, GTK 3; not libayatana, which the app does not load on Linux), and a
`package-manager` file saying `pacman` in `/usr/lib/<identifier>/`, which turns the updater off. Stable
versions only (a pacman version cannot carry the beta's dash). `.SRCINFO` is written by the script in
`makepkg --printsrcinfo`'s layout, since the runner has no makepkg. The workflow commits both under
`pkg/agents-multi-bin/` and pushes them to the AUR with `AUR_SSH_PRIVATE_KEY` (`aur.ts push`); without
the key they are only committed. A package built from source would leave the feature out instead
(`cargo build --no-default-features`).

### Secrets, and who holds them

All of them are the owner's; nothing in the repository or in a log carries one.

| Secret                                    | Where                                                | For                                                                    |
| ----------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`, `…_PASSWORD` | Forgejo Actions secrets; a copy in the owner's vault | signing the bundles                                                    |
| `GH_RELEASE_TOKEN`                        | Forgejo Actions secret                               | a fine-grained GitHub token, Contents read and write on the repository |
| `AUR_SSH_PRIVATE_KEY`                     | Forgejo Actions secret                               | pushing the AUR package                                                |

The push of the manifests' commit uses the job's own token, which must be allowed to push to `release`.

### Rollback

A bad version is taken off its channel by putting the previous manifest back: revert the workflow's
`chore(updates)` commit (or commit the previous `<channel>.json`) on `release` and push; the site is
redeployed with it. Apps that already installed the bad version stay on it — the updater never
downgrades — so they are fixed by a new version that reverts the change; versions only move forward. A
release's assets are never replaced; the AUR package is fixed the same way, by the next version.

### Key rotation

The app trusts only the public key it was built with. To rotate: generate a new pair, release one
version signed with the old key that carries the new public key, and sign every version after it with
the new key once the apps have moved. A lost or leaked private key cannot be rotated that way: the apps
built with it must be reinstalled by hand from a release, and the release notes say so.

## Consequences

- The site's redeploy is on the path of every release: an update reaches the apps once Coolify has
  rebuilt the brain's image.
- `release` receives a commit from the workflow after each tag; `deno task release` wants a clean tree
  on an up-to-date branch, so the owner pulls first.
- The release job is long (the gate, a Rust release build, three bundles) and needs about 2 GB of
  cache; the CI job on pushes stays as it was.
- Before 1.0: fill `release.json` and the public key, set the secrets, create the GitHub repository and
  its mirror, decide the identifier (ADR 0003) and the licence.

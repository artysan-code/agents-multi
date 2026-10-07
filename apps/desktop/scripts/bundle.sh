#!/usr/bin/env bash
# bundle.sh [target]: prepares what `tauri build` packs besides the app (src-tauri/tauri.bundle.conf.json,
# docs/adr/0003), all gitignored under src-tauri/:
#
#   binaries/agents-multi-deno-<triple>   the Deno runtime, as Tauri's external binary (sidecar)
#   bundle/repo/                          the source the backend runs, in the repository's layout, with
#                                         build.json: the version, the commit and a digest of the files,
#                                         which the installation's copy is compared with (apps/cli/appcopy.ts)
#   bundle/deno-dir/                      a Deno cache holding every npm:/jsr: module that source
#                                         imports, so the first run downloads nothing
#
# The runtime is the host's `deno`, checked against DENO_VERSION below (the one place it is pinned);
# fetching it per target is phase 6's. The target defaults to rustc's host.
set -euo pipefail
DENO_VERSION="2.9.7"

HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
TAURI="$REPO/apps/desktop/src-tauri"
cd "$REPO"

command -v deno >/dev/null 2>&1 || { echo "bundle: deno is required (https://deno.land)" >&2; exit 1; }
have="$(deno --version | sed -n 's/^deno \([^ ]*\).*/\1/p')"
[[ "$have" == "$DENO_VERSION" ]] || { echo "bundle: deno $DENO_VERSION is pinned, this is $have" >&2; exit 1; }
target="${1:-}"
if [[ -z "$target" ]]; then
  command -v rustc >/dev/null 2>&1 || { echo "bundle: rustc is required to name the target" >&2; exit 1; }
  target="$(rustc -vV | sed -n 's/^host: //p')"
fi
host="$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')"
[[ "$target" == "$host" ]] || { echo "bundle: only the host's target ($host) until phase 6" >&2; exit 1; }
[[ -f apps/ui/dist/index.html ]] || { echo "bundle: the console's page is not built (agents ui build)" >&2; exit 1; }

ext=""
[[ "$target" == *windows* ]] && ext=".exe"
mkdir -p "$TAURI/binaries"
install -m 755 "$(command -v deno)" "$TAURI/binaries/agents-multi-deno-$target$ext"

# The source: the CLI's module graph (it imports a few of the brain's modules), and what it reads at run
# time — shared/ (settings, hooks, the MCP registry and servers), bin/ (the commands the console runs and
# the launchers), the old page (apps/cli/dashboard), what install, init and the doctor read (desktop/,
# config.example/, pkg/), the manifest, the lock, the changelog and the licences — as tracked by git, and
# the built page. Not the tests, and not systemd/: app mode installs no units (the app runs their jobs).
stage="$TAURI/bundle"
rm -rf "$stage"
mkdir -p "$stage/repo/apps/ui"
{
  deno info --json apps/cli/main.ts |
    deno eval 'const d = JSON.parse(await new Response(Deno.stdin.readable).text());
      const root = Deno.cwd() + "/";
      for (const m of d.modules) if (m.specifier.startsWith("file://")) {
        const p = decodeURIComponent(new URL(m.specifier).pathname);
        if (p.startsWith(root)) console.log(p.slice(root.length));
      }'
  git ls-files apps/cli shared bin desktop config.example pkg deno.json deno.lock CHANGELOG.md \
    LICENSE THIRD_PARTY_NOTICES.md | grep -v '^apps/cli/tests/'
} | sort -u | while IFS= read -r f; do
  [[ -e "$f" ]] && cp --parents -P "$f" "$stage/repo/"
done
cp -RL apps/ui/dist "$stage/repo/apps/ui/dist"

# The build's stamp: two builds of one version (a development build) differ by their digest.
version="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' deno.json | head -n1)"
commit="$(git rev-parse --short HEAD)$([[ -z "$(git status --porcelain --untracked-files=no)" ]] || echo -dirty)"
digest="$(cd "$stage/repo" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)"
printf '{"version":"%s","commit":"%s","digest":"%s"}\n' "$version" "$commit" "$digest" > "$stage/repo/build.json"

# The cache: the CLI's graph with the repository's lock, each MCP server's with its own (they run with
# --no-config). Only remote modules are kept: what Deno compiles is cached by path, which differs once
# installed, and it recompiles into its own cache.
export DENO_DIR="$stage/deno-dir"
deno cache --quiet --frozen "$stage/repo/apps/cli/main.ts"
for server in "$stage"/repo/shared/mcp/*/server.ts; do
  lock="$(dirname "$server")/deno.lock"
  if [[ -f "$lock" ]]; then
    deno cache --quiet --no-config --frozen --lock="$lock" "$server"
  else
    deno cache --quiet --no-config "$server"
  fi
done
rm -rf "$DENO_DIR/gen" "$DENO_DIR"/*_cache_v*

echo "bundle: $target $version ($commit) — runtime $(du -sh "$TAURI/binaries/agents-multi-deno-$target$ext" | cut -f1)," \
  "source $(du -sh "$stage/repo" | cut -f1), cache $(du -sh "$DENO_DIR" | cut -f1)"

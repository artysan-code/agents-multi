#!/usr/bin/env bash
# sidecar.sh [target]: compiles the CLI (apps/cli/main.ts) into the desktop app's backend, the sidecar
# `tauri build` bundles (src-tauri/tauri.sidecar.conf.json, docs/adr/0003). Tauri looks for it as
# src-tauri/binaries/agents-multi-backend-<target triple>; the target defaults to rustc's host.
#
# The binary runs `serve` for the app and is told the repository by AGENTS_MULTI_REPO (its own modules
# live in a virtual file system). Its permissions are bin/agents' except the network, which is open:
# the brain's host comes from the person's accounts.json, unknown when the binary is built.
set -euo pipefail
HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"

command -v deno >/dev/null 2>&1 || { echo "sidecar: deno is required (https://deno.land)" >&2; exit 1; }
target="${1:-}"
if [[ -z "$target" ]]; then
  command -v rustc >/dev/null 2>&1 || { echo "sidecar: rustc is required to name the target" >&2; exit 1; }
  target="$(rustc -vV | sed -n 's/^host: //p')"
fi
ext=""
[[ "$target" == *windows* ]] && ext=".exe"
out="$REPO/apps/desktop/src-tauri/binaries/agents-multi-backend-$target$ext"
mkdir -p "$(dirname "$out")"

deno compile --quiet --target "$target" --output "$out" \
  --allow-read --allow-write --allow-run --allow-env --allow-sys=hostname --allow-net \
  "$REPO/apps/cli/main.ts"
echo "sidecar: $out"

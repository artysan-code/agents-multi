#!/usr/bin/env bash
# install-gitea-mcp.sh — the official Gitea MCP server (gitea.com/gitea/gitea-mcp, MIT), which Forgejo
# speaks too, into ~/.local/lib/gitea-mcp: the release archive checked against the release's own
# checksums before anything is unpacked. servers.json runs it from there (entry "gitea").
#   scripts/install-gitea-mcp.sh [version]      default: the version pinned below
set -euo pipefail
VERSION="${1:-1.8.0}"
ARCH="$(uname -m)"; [[ "$ARCH" == "aarch64" ]] && ARCH=arm64
BASE="https://gitea.com/gitea/gitea-mcp/releases/download/v${VERSION}"
FILE="gitea-mcp_Linux_${ARCH}.tar.gz"
DEST="$HOME/.local/lib/gitea-mcp"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/$FILE" "$BASE/$FILE"
curl -fsSL -o "$TMP/sums" "$BASE/gitea-mcp_${VERSION}_checksums.txt"
(cd "$TMP" && grep " ${FILE}\$" sums | sha256sum -c --quiet -) || { echo "gitea-mcp: checksum mismatch, nothing installed" >&2; exit 1; }
tar -xzf "$TMP/$FILE" -C "$TMP" gitea-mcp
install -Dm755 "$TMP/gitea-mcp" "$DEST/gitea-mcp"
echo "gitea-mcp $VERSION → $DEST/gitea-mcp"

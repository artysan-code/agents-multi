#!/usr/bin/env bash
# install-slack-mcp.sh — the Slack MCP server that acts as the user (github.com/korotovsky/slack-mcp-server,
# MIT) into ~/.local/lib/slack-mcp: the release binary checked against the SHA-256 written below before
# it is installed (the release publishes no checksum file; these are GitHub's digests of its assets).
# servers.json runs it from there (entry "slack"). A new version means new digests here, on purpose.
set -euo pipefail
VERSION="1.3.0"
case "$(uname -m)" in
  x86_64) ARCH=amd64; SUM=d1525962e9b9dbfdd2eaf48d0a81ca1eca7d8f1862b8d34931b812c850b3e568 ;;
  aarch64 | arm64) ARCH=arm64; SUM=a307a48d16c2261346bdc257274cdcdb8b2027c867dc971b41d52cef36472c88 ;;
  *) echo "slack-mcp: no build for $(uname -m)" >&2; exit 1 ;;
esac
FILE="slack-mcp-server-linux-${ARCH}"
DEST="$HOME/.local/lib/slack-mcp"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/$FILE" "https://github.com/korotovsky/slack-mcp-server/releases/download/v${VERSION}/$FILE"
echo "$SUM  $TMP/$FILE" | sha256sum -c --quiet - || { echo "slack-mcp: checksum mismatch, nothing installed" >&2; exit 1; }
install -Dm755 "$TMP/$FILE" "$DEST/slack-mcp-server"
echo "slack-mcp-server $VERSION → $DEST/slack-mcp-server"

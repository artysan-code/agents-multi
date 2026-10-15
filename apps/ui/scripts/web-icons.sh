#!/usr/bin/env bash
# web-icons.sh — the web app's PNG icons (web-public/icons), drawn from src/assets/mark.svg on the dark
# ground of the app. Run by hand when the mark changes (needs rsvg-convert and ImageMagick); the PNGs are
# committed, so a build needs neither.
set -euo pipefail
cd "$(dirname "$0")/.."
out=web-public/icons
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# the mark's stem is drawn for a light page and flips in a dark one by a media query: here the ground is dark
sed 's/\.stem{fill:#ddbd99}/.stem{fill:#f4e7d8}/' src/assets/mark.svg >"$tmp/mark.svg"
icon() { # <file> <size> <mark share of the size, percent>
  local mark=$(($2 * $3 / 100))
  rsvg-convert -w "$mark" -h "$mark" "$tmp/mark.svg" -o "$tmp/m.png"
  magick -size "$2x$2" xc:'#151515' "$tmp/m.png" -gravity center -composite -strip "$out/$1"
}
mkdir -p "$out"
icon icon-192.png 192 70
icon icon-512.png 512 70
# maskable: the mark inside the 80% safe circle
icon icon-maskable-512.png 512 52
icon apple-touch-icon.png 180 70

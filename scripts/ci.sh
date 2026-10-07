#!/usr/bin/env bash
# ci.sh — the whole gate, in the order CI runs it; the pre-push hook runs the same script.
#
#   scripts/ci.sh             check, commit subjects, tests, MCP server probe, secret scan, console UI build, site build
#   scripts/ci.sh --no-site   the same without the site build
#
# gitleaks is optional on a workstation (skipped with a warning) and required in CI (CI=true).
set -euo pipefail
cd "$(dirname "$0")/.."

site=1
[[ "${1:-}" == --no-site ]] && site=0

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step check
bash scripts/check.sh

step commits
deno run --quiet --allow-read --allow-run=git scripts/release.ts --lint

step "brain image"
deno run --quiet --allow-read --allow-run=deno --allow-env scripts/brain-image.ts

step test
deno task --quiet test

step "mcp servers"
deno run --quiet --allow-read --allow-run=deno --allow-env scripts/mcp-probe.ts

step secrets
if command -v gitleaks >/dev/null; then
  gitleaks git --no-banner --redact --config .gitleaks.toml .
elif [[ "${CI:-}" == true ]]; then
  echo "ci: gitleaks is required in CI" >&2
  exit 1
else
  echo "ci: gitleaks is not installed, secret scan skipped" >&2
fi

step "console ui"
# into a scratch directory: in the runtime checkout apps/ui/dist is what the console serves, and the
# pre-push hook runs this there (only `agents ui build` replaces it, with its stamp)
ui_out=$(mktemp -d)
(cd apps/ui && pnpm install --frozen-lockfile --silent && pnpm exec tsc --noEmit &&
  pnpm exec vite build --logLevel warn --outDir "$ui_out" --emptyOutDir)
rm -rf "$ui_out"

if ((site)); then
  step site
  (cd apps/site && pnpm install --frozen-lockfile --silent && pnpm build)
fi

printf '\n\033[32mci ok\033[0m\n'

#!/usr/bin/env bash
# ci.sh — the whole gate, in the order CI runs it; the pre-push hook runs the same script.
#
#   scripts/ci.sh             check, tests, secret scan of the history, site build
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

step test
deno task --quiet test

step secrets
if command -v gitleaks >/dev/null; then
  gitleaks git --no-banner --redact --config .gitleaks.toml .
elif [[ "${CI:-}" == true ]]; then
  echo "ci: gitleaks is required in CI" >&2
  exit 1
else
  echo "ci: gitleaks is not installed, secret scan skipped" >&2
fi

if ((site)); then
  step site
  (cd site && pnpm install --frozen-lockfile --silent && pnpm build)
fi

printf '\n\033[32mci ok\033[0m\n'

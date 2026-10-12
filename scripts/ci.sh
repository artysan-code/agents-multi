#!/usr/bin/env bash
# ci.sh — the whole gate; CI and the pre-push hook run the same script.
#
#   scripts/ci.sh             check, commit subjects, tests, MCP server probe, secret scan, console UI build, site build
#   scripts/ci.sh --no-site   the same without the site build
#
# The steps are independent of each other: they run at once, each into its own log, printed in this
# order when all are done; the gate fails when any fails, and names it.
# gitleaks is optional on a workstation (skipped with a warning) and required in CI (CI=true).
set -euo pipefail
cd "$(dirname "$0")/.."

site=1
[[ "${1:-}" == --no-site ]] && site=0

ui() {
  # into a scratch directory: in the runtime checkout apps/ui/dist is what the console serves, and the
  # pre-push hook runs this there (only `agents ui build` replaces it, with its stamp)
  local out rc=0
  out=$(mktemp -d)
  (cd apps/ui && pnpm install --frozen-lockfile --silent && pnpm exec tsc --noEmit &&
    pnpm exec vite build --logLevel warn --outDir "$out" --emptyOutDir) || rc=$?
  rm -rf "$out"
  return "$rc"
}

secrets() {
  if command -v gitleaks >/dev/null; then
    gitleaks git --no-banner --redact --config .gitleaks.toml .
  elif [[ "${CI:-}" == true ]]; then
    echo "ci: gitleaks is required in CI" >&2
    return 1
  else
    echo "ci: gitleaks is not installed, secret scan skipped" >&2
  fi
}

names=() pids=()
logs=$(mktemp -d)
trap 'rm -rf "$logs"' EXIT
step() {
  local name=$1
  shift
  names+=("$name")
  ("$@") >"$logs/${#names[@]}" 2>&1 &
  pids+=($!)
}

step check bash scripts/check.sh
step commits deno run --quiet --allow-read --allow-run=git scripts/release.ts --lint
step "brain image" deno run --quiet --allow-read --allow-run=deno --allow-env scripts/brain-image.ts
step test deno task --quiet test
# the shared agents' frontmatter: a broken one is skipped by Claude Code without a word
step agents python3 shared/scripts/validate_agents.py shared/agents
step "mcp servers" deno run --quiet --allow-read --allow-run=deno --allow-env scripts/mcp-probe.ts
step secrets secrets
step "console ui" ui
((site)) && step site bash -c 'cd apps/site && pnpm install --frozen-lockfile --silent && pnpm build'

failed=()
for i in "${!pids[@]}"; do
  rc=0
  wait "${pids[$i]}" || rc=$?
  printf '\n\033[1m== %s\033[0m\n' "${names[$i]}"
  cat "$logs/$((i + 1))"
  ((rc == 0)) || failed+=("${names[$i]}")
done

if ((${#failed[@]})); then
  printf '\n\033[31mci failed: %s\033[0m\n' "${failed[*]}" >&2
  exit 1
fi
printf '\n\033[32mci ok\033[0m\n'

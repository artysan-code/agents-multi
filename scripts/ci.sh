#!/usr/bin/env bash
# ci.sh — the whole gate, run by CI on every push of dev, of an agent's branch (wf/*, agent/*) and of a pull
# request; `deno task ship` waits for its verdict (the note CI leaves on the commit) instead of running it.
#
#   scripts/ci.sh             check, commit subjects, tests, MCP server probe, secret scan, console UI build, site build
#   scripts/ci.sh --no-site   the same without the site build
#   scripts/ci.sh --fast      check (Deno and shell), commit subjects and tests: what a workstation runs, at low
#                             priority, before saying done; the builds, the probe, the scan and the Rust are CI's
#
# The steps are independent of each other: they run at once, each into its own log. When all are done
# each step prints one line with its time, in this order, and a failed one its whole log (CI_VERBOSE=1:
# every log); the gate fails when any fails, and names it.
# gitleaks is optional on a workstation (skipped with a warning) and required in CI (CI=true).
set -euo pipefail
cd "$(dirname "$0")/.."

site=1 fast=0
[[ "${1:-}" == --no-site ]] && site=0
[[ "${1:-}" == --fast ]] && fast=1 site=0

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
  local n=${#names[@]}
  (
    start=$SECONDS
    rc=0
    "$@" || rc=$?
    echo $((SECONDS - start)) >"$logs/$n.time"
    exit "$rc"
  ) >"$logs/$n" 2>&1 &
  pids+=($!)
}

if ((fast)); then
  step check bash scripts/check.sh --fast
else
  step check bash scripts/check.sh
fi
step commits deno run --quiet --allow-read --allow-run=git scripts/release.ts --lint
((fast)) || step "brain image" deno run --quiet --allow-read --allow-run=deno --allow-env scripts/brain-image.ts
step test deno task --quiet test
# the shared agents' frontmatter: a broken one is skipped by Claude Code without a word
step agents python3 shared/scripts/validate_agents.py shared/agents
if ((!fast)); then
  step "mcp servers" deno run --quiet --allow-read --allow-run=deno --allow-env scripts/mcp-probe.ts
  step secrets secrets
  step "console ui" ui
fi
((site)) && step site bash -c 'cd apps/site && pnpm install --frozen-lockfile --silent && pnpm build'

failed=()
for i in "${!pids[@]}"; do
  rc=0
  wait "${pids[$i]}" || rc=$?
  n=$((i + 1))
  if ((rc == 0)); then
    printf '\033[32m✓\033[0m %-12s %3ss\n' "${names[$i]}" "$(cat "$logs/$n.time" 2>/dev/null)"
    [[ "${CI_VERBOSE:-}" == 1 || "${CI:-}" == true ]] && cat "$logs/$n"
  else
    printf '\033[31m✗\033[0m %-12s %3ss\n' "${names[$i]}" "$(cat "$logs/$n.time" 2>/dev/null)"
    sed 's/^/    /' "$logs/$n"
    failed+=("${names[$i]}")
  fi
done

if ((${#failed[@]})); then
  printf '\033[31mci failed: %s\033[0m\n' "${failed[*]}" >&2
  exit 1
fi
printf '\033[32mci ok\033[0m\n'

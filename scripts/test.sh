#!/usr/bin/env bash
# test.sh — the test suite (`deno task test`), in two processes at once:
#
#   - the files that change the process's environment or directory (Deno.env.set/delete, Deno.chdir)
#     one after another, in a process of their own: `deno test --parallel` runs files as workers of one
#     process, where one file's AGENTS_MULTI_TASKS or AGENTS_MULTI_CONFIG would be another's
#   - every other file with --parallel, one worker per core
#
# The split is found by grep, so a new test file needs no edit here. Extra arguments go to both runs
# (e.g. --filter vault).
set -euo pipefail
cd "$(dirname "$0")/.."

export AGENTS_MULTI_CONFIG=apps/cli/tests/fixtures/config
# loopback only: the tests talk to servers of their own on ports the system picks
net=127.0.0.1
perms=(--allow-read --allow-write --allow-run --allow-env "--allow-sys=hostname,loadavg,systemMemoryInfo" "--allow-net=$net")

serial=() pool=()
for f in apps/cli/tests/*_test.ts apps/brain/tests/*_test.ts; do
  if grep -qE 'Deno\.(env\.(set|delete)|chdir)\(' "$f"; then serial+=("$f"); else pool+=("$f"); fi
done

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
deno test --quiet "${perms[@]}" "$@" "${serial[@]}" >"$out/serial" 2>&1 &
s=$!
deno test --quiet --parallel "${perms[@]}" "$@" "${pool[@]}" >"$out/pool" 2>&1 &
p=$!

rc=0
wait "$s" || rc=1
wait "$p" || rc=1
cat "$out/serial" "$out/pool"
exit "$rc"

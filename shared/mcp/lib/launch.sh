#!/usr/bin/env bash
# launch.sh — starts a stdio server that is not ours with one account's secret, and leaves nothing of itself.
#
#   launch.sh <deno> run <deno flags…> <launch.ts> -- env <service> <account> [--env …] [--bind …] -- <command> [args…]
#
# Everything before the first `--` is the Deno command line of launch.ts; after it come launch.ts's own
# arguments (launch.ts › env). launch.ts resolves the vault secret and the project's binding and prints
# them as NUL-ended records on a pipe (E NAME=value, A extra-argument), then exits. This script reads
# them into its own environment and `exec`s <command>: the server replaces the shell, so what is left
# of a session is the server alone — no wrapper process between it and Claude, signals go straight to it.
#
# The secret travels only on that pipe and ends in the server's environment, exactly as before (it was
# the Deno wrapper's `env:` for the child). It is never in an argument (not of this script, not of
# `exec`, not of launch.ts), never in a file, and the records are read, not evaluated.
set -euo pipefail

deno_cmd=()
while [ $# -gt 0 ] && [ "$1" != "--" ]; do
  deno_cmd+=("$1")
  shift
done
[ $# -gt 0 ] || { echo "launch.sh: expected '--' after the Deno command line" >&2; exit 2; }
shift
[ ${#deno_cmd[@]} -gt 0 ] || { echo "launch.sh: no Deno command line before '--'" >&2; exit 2; }

# the server's own command line: after the next `--` (launch.ts takes the same one)
rest=("$@")
cmd=()
for i in "${!rest[@]}"; do
  if [ "${rest[i]}" = "--" ]; then
    cmd=("${rest[@]:i+1}")
    break
  fi
done
[ ${#cmd[@]} -gt 0 ] || { echo "launch.sh: the server's command goes after a second '--'" >&2; exit 2; }

extra=()
while IFS= read -r -d '' rec; do
  case $rec in
    E[A-Za-z_]*=*) export "${rec:1}" ;;
    A*) extra+=("${rec:1}") ;;
    *) echo "launch.sh: unexpected record from launch.ts" >&2; exit 1 ;;
  esac
done < <("${deno_cmd[@]}" "$@")
# the process substitution's own status: a launch.ts that failed must not start the server without its secret
wait $! || exit $?

exec "${cmd[@]}" ${extra[@]+"${extra[@]}"}

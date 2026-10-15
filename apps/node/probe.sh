#!/usr/bin/env bash
# node-probe: whether Claude Code's Bash sandbox can start in this container: the same command agentd probes
# with (apps/cli/node/probe.ts: every namespace bubblewrap makes and a fresh /proc) and socat, the sandbox's
# network relay. Exit 0: it can. Anything else: it cannot, and the node takes no job (failing closed).
set -uo pipefail
command -v socat >/dev/null 2>&1 || { echo "node-probe: socat is not installed" >&2; exit 1; }
if out=$(bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --die-with-parent true 2>&1); then
  echo "node-probe: the sandbox works"
else
  echo "node-probe: bubblewrap cannot make the sandbox: ${out##*$'\n'}" >&2
  echo "node-probe: needs the seccomp profile, systempaths=unconfined and, with AppArmor, the agents-node profile" >&2
  exit 1
fi

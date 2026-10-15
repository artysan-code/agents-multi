#!/usr/bin/env bash
# seccomp.sh: writes seccomp.json — Docker's default seccomp profile at a pinned release, plus the one rule
# ADR 0012 measured (what bubblewrap needs to make a sandbox without CAP_SYS_ADMIN). Run it to check that the
# committed file is what the pinned profile gives (`seccomp.sh --check`) or to move to a newer release (change
# PROFILES_TAG, run it, and probe again: README.md, step 6).
#
# Docker's own profile since 29 is published in github.com/moby/profiles (it was profiles/seccomp in moby/moby).
set -euo pipefail
PROFILES_TAG="seccomp/v0.2.4"
SHA256="785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334" # of that release's default.json
HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsS -o "$tmp" "https://raw.githubusercontent.com/moby/profiles/${PROFILES_TAG}/seccomp/default.json"
echo "$SHA256  $tmp" | sha256sum -c --quiet - || { echo "seccomp: default.json of ${PROFILES_TAG} is not the pinned one" >&2; exit 1; }

out="$(python3 -I - "$tmp" <<'PY'
import json, sys
profile = json.load(open(sys.argv[1]))
# the five syscalls bubblewrap needs: each was taken out once and bwrap failed without it. setns is not needed
# and stays as Docker has it (with CAP_SYS_ADMIN only); clone3 stays ENOSYS (libc falls back to clone).
profile["syscalls"].append({
    "names": ["clone", "mount", "pivot_root", "umount2", "unshare"],
    "action": "SCMP_ACT_ALLOW",
    "comment": "Agents Multi node (ADR 0012): bubblewrap's namespaces and mounts, without CAP_SYS_ADMIN",
})
print(json.dumps(profile, indent=2))
PY
)"

if [[ "${1:-}" == --check ]]; then
  diff -q <(printf '%s\n' "$out") "$HERE/seccomp.json" >/dev/null || { echo "seccomp: seccomp.json is not what ${PROFILES_TAG} gives" >&2; exit 1; }
  echo "seccomp: seccomp.json matches ${PROFILES_TAG} plus the node's rule"
else
  printf '%s\n' "$out" > "$HERE/seccomp.json"
  echo "seccomp: wrote seccomp.json (${PROFILES_TAG} plus the node's rule)"
fi

#!/usr/bin/env bash
# headers.sh <token file> — what Claude Code's `headersHelper` runs for a gateway server (docs/adr/0008):
# prints the profile's token as an Authorization header. The token stays in a 0600 file, never in an
# argument or in the launch config; the config names this script and the file, not the secret.
set -euo pipefail
IFS= read -r token <"$1"
printf '{"authorization":"Bearer %s"}\n' "$token"

#!/usr/bin/env bash
# The node image's entry point (ADR 0012): puts the image's code in the home as the installation's app copy,
# then runs the console headless. A node not yet set up stays up and idle, so that the terminal that sets it up
# is there (docker exec): README.md, steps 4 and 5.
set -euo pipefail
CODE=/opt/agents-multi
CONFIG="$HOME/.agents-multi/config"

# The profile launcher (bin/claude) runs `~/.local/bin/claude-bin`: the Claude Code of the image, at the version
# it pins. `agents update` does not move it: a new version is a new image.
mkdir -p "$HOME/.local/bin"
ln -sfn "$(readlink -f /usr/local/bin/claude)" "$HOME/.local/bin/claude-bin"

if [[ ! -f "$CONFIG/owner.json" ]]; then
  cat >&2 <<'MSG'
This node has no configuration yet. In a terminal of this container (docker exec -it <container> bash):
  agents init ~/config --name <you>
then restart the container (README.md, step 4).
MSG
  exec sleep infinity
fi

# the app copy: a new image replaces the code in the home; the same one changes nothing
"$CODE/repo/bin/agents" install --app

if ! grep -q '"headless": *true' "$CONFIG/node.json" 2>/dev/null; then
  cat >&2 <<'MSG'
This node is not a headless node yet. In a terminal of this container (docker exec -it <container> bash):
  agents node enable --headless
then restart the container (README.md, step 5).
MSG
  exec sleep infinity
fi

exec agents serve --headless --no-open

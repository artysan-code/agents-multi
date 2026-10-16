#!/usr/bin/env bash
# The node image's entry point (ADR 0012, 0013): links the owner's configuration when it is mounted, puts the
# image's code in the home as the installation's app copy, then runs the console headless. A node not yet set up
# stays up and waits, so that the terminal that sets it up is there (docker exec … agents node setup), and goes on
# by itself once it is: no restart (README.md, step 5).
set -euo pipefail
CODE=/opt/agents-multi
CONFIG="$HOME/.agents-multi/config"
SHARED="$HOME/agents-multi-config"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/agents-multi"
MACHINE="$STATE/node.json"

# The profile launcher (bin/claude) runs `~/.local/bin/claude-bin`: the Claude Code of the image, at the version
# it pins. `agents update` does not move it: a new version is a new image.
mkdir -p "$HOME/.local/bin" "$HOME/.agents-multi"
ln -sfn "$(readlink -f /usr/local/bin/claude)" "$HOME/.local/bin/claude-bin"

# the owner's configuration, mounted read only from its Syncthing folder: the node's own, over one `agents init`
# made before it was mounted (that folder is left where it is)
link_shared() {
  [[ -f "$SHARED/owner.json" ]] || return 1
  [[ -d "$CONFIG" && ! -L "$CONFIG" ]] && return 0 # a real folder is never replaced
  [[ "$(readlink "$CONFIG" 2>/dev/null)" == "$SHARED" ]] || ln -sfn "$SHARED" "$CONFIG"
}

# a server with no token that knows the service's address (NODE_SERVICE_URL in compose) is paired from the owner's
# console (ADR 0013, F2): the code and its key's fingerprint go to this log, a new code as each expires; the token and
# the vault key arrive with the owner's yes. The configuration still comes by Syncthing, as below.
if [[ -n "${AGENTS_MULTI_SERVICE_URL:-}" && ! -s "$STATE/node-token" ]]; then
  "$CODE/repo/bin/agents" node pair --server &
fi

said=0
until link_shared || [[ -f "$CONFIG/owner.json" ]]; do
  if ((said == 0)); then
    cat >&2 <<'MSG'
This node has no configuration yet: mount the owner's (NODE_CONFIG_DIR, README.md step 3) and wait for Syncthing,
or, with none to share, in a terminal of this container (docker exec -it <container> bash):
  agents init ~/config --name <you> --brain https://<your brain>
It goes on by itself once there is one.
MSG
    said=1
  fi
  sleep 5
done

# the app copy: a new image replaces the code in the home; the same one changes nothing
"$CODE/repo/bin/agents" install --app

headless() {
  grep -q '"headless": *true' "$MACHINE" 2>/dev/null ||
    { [[ ! -f "$MACHINE" ]] && grep -q '"headless": *true' "$CONFIG/node.json" 2>/dev/null; } # before 1.2.1
}
said=0 next_setup=0
until headless; do
  # paired from the console: setup's steps run here with no terminal, once a minute until the node is on; what still
  # waits (a Claude token, the forge taking the git key) is in its announce, on the console's page
  if [[ -s "$STATE/node-token" && -s "$HOME/.local/state/agents-multi/vault-key" ]] && ((SECONDS >= next_setup)); then
    agents node setup </dev/null || true
    next_setup=$((SECONDS + 60))
  fi
  if ((said == 0)); then
    cat >&2 <<'MSG'
This node is not set up yet. In a terminal of this container (docker exec -it <container> bash):
  agents node setup
It goes on by itself once the node is on (README.md, step 5).
MSG
    said=1
  fi
  sleep 5
done

exec agents serve --headless --no-open

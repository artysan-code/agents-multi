#!/usr/bin/env bash
# bind-volume.sh: on the host, makes one of the node's named volumes (`node-vault`, `node-config`) a read-only
# window on a Syncthing folder of the owner's (README.md, «The vault and the configuration»). Coolify reads
# compose.yaml itself and resolves `${NODE_VAULT_DIR:-node-vault}` to its default, a named volume, whatever the
# variable says: this turns that volume into a bind of the folder, keeping Compose's labels so the next deploy
# takes it as its own. Once per volume and server; a deploy keeps it.
#
#   sudo apps/node/bind-volume.sh <volume> <folder>
#   sudo apps/node/bind-volume.sh ctspzl…_node-vault  /var/lib/docker/volumes/<syncthing>_data1/_data/agents-multi-vault-server
#   sudo apps/node/bind-volume.sh ctspzl…_node-config /var/lib/docker/volumes/<syncthing>_data1/_data/agents-multi-config
#
# It refuses a volume that holds files (it only replaces the empty one a deploy made) and a node that is running.
set -euo pipefail
vol="${1:?usage: bind-volume.sh <volume> <folder>}"
dir="${2:?usage: bind-volume.sh <volume> <folder>}"
labels=()

# what the folder must already hold: the vault's key check, or the configuration's owner
[[ -f "$dir/key-check.json" || -f "$dir/owner.json" ]] ||
  { echo "bind-volume: neither a vault nor a configuration in $dir: wait for Syncthing" >&2; exit 1; }
if docker volume inspect "$vol" >/dev/null 2>&1; then
  if [[ "$(docker volume inspect -f '{{index .Options "device"}}' "$vol")" == "$dir" ]]; then
    echo "bind-volume: $vol is already a bind of $dir"
    exit 0
  fi
  mp="$(docker volume inspect -f '{{.Mountpoint}}' "$vol")"
  if [[ -n "$(ls -A "$mp" 2>/dev/null)" ]]; then
    echo "bind-volume: $vol holds files: not the empty volume of a deploy, left as it is" >&2
    exit 1
  fi
  if [[ -n "$(docker ps -q --filter "volume=$vol")" ]]; then
    echo "bind-volume: a running container uses $vol: stop the node first (Coolify: Stop)" >&2
    exit 1
  fi
  while IFS= read -r l; do [[ -n "$l" ]] && labels+=(--label "$l"); done \
    < <(docker volume inspect -f '{{range $k, $v := .Labels}}{{$k}}={{$v}}{{println}}{{end}}' "$vol")
  # stopped containers of the node still hold the volume; their state is in node-home, not in them
  for c in $(docker ps -aq --filter "volume=$vol"); do docker rm "$c" >/dev/null; done
  docker volume rm "$vol" >/dev/null
fi
docker volume create ${labels[@]+"${labels[@]}"} -d local -o type=none -o o=bind -o device="$dir" "$vol" >/dev/null
echo "bind-volume: $vol is a bind of $dir; deploy the node again"

# The server node

The image of a machine with no screen that runs Agents Multi's jobs ([ADR 0012](../../docs/adr/0012-agentd-and-the-service.md)):
`agents serve --headless` as an unprivileged user (uid 1000), with Claude Code's Bash sandbox (bubblewrap) working
inside the container and failing closed when it cannot.

| File                        | What it is                                                                                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                | Debian trixie-slim, bubblewrap, socat, git, Deno and Claude Code at pinned versions, the repository's code as the app copy                                                                                                   |
| `compose.yaml`              | the service for Coolify: no capability, seccomp + AppArmor profiles, `systempaths=unconfined`, a memory limit                                                                                                                |
| `seccomp.json`              | Docker's default profile (`moby/profiles` `seccomp/v0.2.4`) plus one rule: `clone`, `mount`, `pivot_root`, `umount2`, `unshare` without the capability; `setns` stays refused. `seccomp.sh` makes it (`--check` verifies it) |
| `apparmor/agents-node`      | `docker-default` with `mount` and `pivot_root` allowed                                                                                                                                                                       |
| `entrypoint.sh`, `probe.sh` | what runs at start (it waits for the configuration and for `agents node setup`); `node-probe` in the container tries what the sandbox needs                                                                                  |

No secret is in the image, in `compose.yaml` or in an environment variable: the Claude logins, the git key, the
service token and the vault key file are made once in the container's terminal and live in its volume.

## What you run on atlas

1. **Host: Docker and the kernel.** User namespaces must be allowed to unprivileged users
   (`sysctl kernel.unprivileged_userns_clone` is `1` or absent, `user.max_user_namespaces` above 0); Debian 13
   does by default.

2. **Host: the AppArmor profile**, once (Debian has AppArmor; `aa-status` says whether it is on):

   ```sh
   sudo cp apps/node/apparmor/agents-node /etc/apparmor.d/agents-node
   sudo apparmor_parser -r -W /etc/apparmor.d/agents-node
   ```

   Files in `/etc/apparmor.d` are loaded again at boot. **Check it** is loaded:

   ```sh
   sudo aa-status | grep -x '   agents-node'      # the profile is listed
   ```

   Without AppArmor on the host, Docker ignores `apparmor=` and nothing is needed. With it, a container that
   names a profile the host does not have does not start: load it first. Docker's own `docker-default` would
   keep the sandbox from starting (`deny mount`): that is why this one exists.

3. **The vault and the configuration, on this server.** Both are Syncthing folders of their own on your machines:
   `~/agents-multi-vault` and `~/agents-multi-config` (`agents config move` puts the configuration there, ADR 0013).
   Share **those two alone** with this server's Syncthing as a **trusted** device (no encryption password),
   receive only: the node runs your profiles, accounts and MCP servers, and its jobs open their accounts. The rest
   of your Syncthing folders stay encrypted there. Note each folder's path **on the host** (with Syncthing in
   Docker, inside its data volume: `docker volume inspect -f '{{.Mountpoint}}' <its data volume>`), and make each
   the node's user's before anything mounts it, or Docker makes it root's and Syncthing can no longer write there:
   `install -d -o 1000 -g 1000 -m 700 <folder>`.

   **Claude's accounts**: on your desktop, once a year per account, `agents node token <profile>` (Claude Code's
   `setup-token`, one browser sign-in) puts a long-lived token in the vault. The node starts that account's
   children with it; nobody signs in on the server.

4. **Coolify: the service.** A new resource from the repository, _Docker Compose_, base directory `/apps/node`,
   compose file `/compose.yaml` (it builds the image from the repository's root). Variables: `NODE_MEMORY`
   (default `8g`; the node's session cap is `(memory − 2 GiB) / 1.5 GiB`, so 8g is 4 sessions), `NODE_NAME`,
   `NODE_TIMEZONE`. Deploy: the container starts and waits. **The two folders**: Coolify reads the compose file
   itself and mounts the named volumes `<uuid>_node-vault` and `<uuid>_node-config`, empty, whatever
   `NODE_VAULT_DIR` and `NODE_CONFIG_DIR` say; once Syncthing has brought them, make each a bind of its folder,
   then deploy again (a deploy keeps them):

   ```sh
   sudo apps/node/bind-volume.sh <uuid>_node-vault  <vault folder>
   sudo apps/node/bind-volume.sh <uuid>_node-config <configuration folder>
   ```

   Without Coolify, `NODE_VAULT_DIR=<folder> NODE_CONFIG_DIR=<folder> docker compose up -d --build` in this
   folder mounts them directly. Without the vault the node runs no job that needs a service's secret (the doctor's
   `node.vault` says so); without the configuration it needs one of its own (`agents init ~/config --brain <url>`).

5. **In the container's terminal** (`docker exec -it <container> bash`; Coolify has a terminal for it), one
   command:

   ```sh
   agents node setup
   ```

   It does in order what is missing, and runs again to finish what waited: links the configuration; pairs the
   vault (it asks for the recovery code: `agents vault recovery-code` on your machine); signs the node in (a link
   to open anywhere, the address to paste back); checks each Claude account's token and names the missing ones;
   makes the git key and waits until the forge takes it; clones the repositories `nodes.json` lists (`repos`);
   turns the node on, headless. The container sees it and starts serving: no restart. The key and the logins live
   in its volume; whoever has the volume has them («The vault key without a keyring»).

   **Or, with no terminal** (ADR 0013, F2): set `NODE_SERVICE_URL` (the brain's address) in the compose
   environment before the first start. The unconfigured container then prints a pairing code and its key's
   fingerprint in its log, a new code every ten minutes. On your machine, the console's _Connections › Add a
   server_ takes the code and shows the fingerprint: say yes only if it is the one in the log. The node gets a
   token of its own (scope `node`: it reads projects and notes, the tasks and its own jobs, nothing else of the
   brain) and the vault key sealed to its key; once the configuration arrives by Syncthing it runs setup's steps
   by itself, and the page shows its git key to add to the forge and what still waits.

6. **Check the sandbox**, from the host:

   ```sh
   docker exec <container> node-probe                    # "the sandbox works", exit 0
   docker inspect -f '{{.HostConfig.SecurityOpt}}' <container>   # no-new-privileges, seccomp, apparmor, systempaths
   docker exec <container> grep -E 'NoNewPrivs|CapEff|Seccomp' /proc/self/status   # 1, all zeros, 2
   ```

   If `node-probe` fails: _No permissions to create a new namespace_ is the seccomp profile (or the host's
   user namespaces), _Can't mount proc_ is `systempaths`, an _Operation not permitted_ on a mount or
   `pivot_root` with the first two in place is AppArmor (`dmesg | grep -i apparmor`, `aa-status`). The node
   probes itself at start and every hour, and a node whose probe fails announces `sandbox: false`, takes no job
   and fires no routine.

7. **Updating** is a new image: redeploy; the entrypoint puts the new code in the volume as the app copy. Claude
   Code moves with `CLAUDE_CODE_VERSION` in the Dockerfile, never by itself.

## Moving to a newer Docker

`seccomp.sh` pins the release of Docker's profile (`PROFILES_TAG`) and its checksum. To follow a newer one,
change both, run `apps/node/seccomp.sh`, and run step 6 again (and the probe with Docker's defaults, which must
fail: `docker run --rm --user 1000:1000 --cap-drop ALL --entrypoint node-probe <image>`).

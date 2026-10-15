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
| `entrypoint.sh`, `probe.sh` | what runs at start; `node-probe` in the container tries what the sandbox needs                                                                                                                                               |

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

3. **The vault, on this server.** The vault (`~/agents-multi-vault` on your machines) is a Syncthing folder of
   its own: share **that folder alone** with this server's Syncthing as a **trusted** device (no encryption
   password), so the MCP servers of the node's jobs can open their accounts. The rest of your Syncthing folders
   stay encrypted there. Its entries are sealed with the vault key; the key arrives in step 5. Note the folder's
   path **on the host** (with Syncthing in Docker, inside its data volume): it is `NODE_VAULT_DIR` below.

4. **Coolify: the service.** A new resource from the repository, _Docker Compose_, base directory `/apps/node`,
   compose file `/compose.yaml` (it builds the image from the repository's root). Variables: `NODE_VAULT_DIR`
   (the host folder of step 3, mounted read only; unset, the node has no vault and runs no job that needs a
   service's secret), `NODE_MEMORY` (default `8g`; the node's session cap is `(memory − 2 GiB) / 1.5 GiB`, so 8g
   is 4 sessions), `NODE_NAME`, `NODE_TIMEZONE`. Deploy: the container starts and waits, unconfigured. To run it
   without Coolify: `docker compose up -d --build` in this folder.

5. **In the container's terminal** (`docker exec -it <container> bash`; Coolify has a terminal for it): make the
   configuration, then restart the container so that the code is installed:

   ```sh
   agents init ~/config --name <you>
   ```

   **Restart, then in the terminal again**, the node's own logins, one by one; each puts its secret in the
   volume, never in the environment. With no browser here, each prints a link to open on any machine:

   ```sh
   agents vault pair --file             # the recovery code: the vault key in a file only this user reads (0600)
   agents node login --no-browser       # this node's own token: open the link, sign in, paste back the address
   claude                               # per profile with an account: /login; the login is a file in the volume
   ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ''   # the git key: add the public one to the forge
   git clone <remote> ~/<repo>                         # the repositories the node may work on
   agents node enable --headless
   ```

   Then restart the container: it runs `agents serve --headless`. Not `agents brain-login`: the vault is read
   only here, and the service names a node after its own token (ADR 0012). The key and the logins are the
   owner's to place here, once; whoever has the volume has them («The vault key without a keyring»).

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

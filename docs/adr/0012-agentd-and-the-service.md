# 0012 — agentd, the service, and work that moves between machines

- Status: accepted (phase F of [ADR 0009](0009-agents-multi-2.md); slice F1 built, F2 listed below)
- Date: 2026-10-15

## Context

ADR 0009 (7–9, 21, 24) wants a daemon on every machine that runs jobs, says what it can take, and is the only
thing that starts agents there; the orchestrator proposes where a job runs, the owner accepts, and a job cut by a
machine going off resumes elsewhere from its branch. Phase D gave routines, the run policy and the limits
manager ([ADR 0010](0010-scheduler-and-run-policy.md)); phase H the reviewer ([ADR 0011](0011-reviewer.md)).

The owner chose (2026-10-15), among the options weighed:

- **transport** — not a VPN between machines, which would work only for the owner: the brain becomes **the
  service** Agents Multi runs on, and the machines talk to it (over node-to-node on WireGuard, and over both);
  the structure has to be simple enough for someone else to set up;
- **name** — the service of Agents Multi, with the brain as its memory; code (`apps/brain`), `BRAIN_*` variables,
  domain and tokens stay (over keeping "brain" for everything, and over renaming it all);
- **placement** — always a proposal the owner accepts; a routine that names a node is that yes given in advance
  (over automatic rules, and over a proposal that accepts itself after a delay);
- **the owner's yes** — signed on the owner's machine with a key from the vault and checked on the node (over
  trusting the service's session, and over passkeys now, which are phase G's);
- **what travels** — the run's branch, pushed as it moves, and its HANDOFFs on a ref of their own (over the
  branch alone, which loses a workflow's finished steps, and over HANDOFFs in the brain);
- **the server's vault key** — a file only the user reads (over systemd-creds, whose host key sits on the same
  disk of a VPS, and over a second, smaller vault);
- **the server node** — a Docker service like the brain, with a cap on sessions from its memory, and Claude's
  Bash sandbox kept on through a narrow seccomp profile, studied below (over the container as the only
  boundary, and over a host install with a systemd unit).

## Decision

### The shape

- **The service** (today's brain, one deployment per person or organisation) keeps, per account: the memory,
  the tasks, the **nodes** (what each machine last said) and the **jobs** (proposed, accepted, running, ended or
  interrupted). Phase G adds the chat API and the PWA's push to it. Each account is its own database, as today.
- **agentd** is the console's backend as a node: `agents serve` on a desktop (the app starts it) is already one,
  `agents serve --headless` on a server is one with no page and no desktop jobs. It runs the routines, the
  limits scan, the reviewer and the gateway as before (reused, not duplicated), and when the node is on
  (`agents node enable`, `config/node.json`) it also announces itself and takes the jobs placed on it.
- **The CLI and the app are views**: `agents nodes` reads the service, `agents nodes accept` signs.
- **A new person**: deploy the service (one compose file, Coolify or plain Docker), take an account; on each
  machine install Agents Multi, `agents brain-login` (the machine's token and the backup key go into the vault),
  `agents vault pair` and `agents node enable`. A server node is the image in `apps/node/` with the same three
  steps in its terminal. No VPN, no open port on any machine.

### Talking: outbound only, one credential per machine

- **A node only calls out**, over HTTPS to the service; nothing it runs listens beyond `127.0.0.1` (the console
  on 7331, the gateway on 7332). The doctor checks both (`node.bind`).
- **Its credential is its own**: the personal token `agents brain-login` already makes per machine
  (`token:<machine>`, listed and revoked one by one on `/account`). The service takes the node's name from the
  token, never from the body: a token can announce only its own node and claim or report only the jobs
  placed on it. The name is the machine's hostname (`agents-multi su <hostname>` is how the token is named;
  `nodeNameOf`), which the node computes itself and never takes from the service; `name` in `node.json` when
  the token was named otherwise, and a container sets its hostname.
- **Announcing** (`PUT /api/node`, every 30 s): platform, version, load and memory, its **session cap** and the
  sessions running, the accounts it can run (each profile with a Claude login, without reading it), whether
  the owner is at it (a graphical session not locked; a server never is), whether the sandbox works there,
  and whether it is headless. The answer is the jobs accepted for it. A node unseen for 90 s is offline;
  unseen for 10 minutes, its running jobs are **interrupted**.
- **Session cap**: `(memory − 2 GiB) / 1.5 GiB`, at least 1, where memory is the container's limit
  (`memory.max`) when there is one, else the machine's; `maxSessions` in `node.json` overrides it. A node at
  its cap takes no job and gets no proposal; its own routines still queue under the run policy.

### The owner's yes is checked on the node

- A job carries what to do (`spec`), the node it is for, and, once accepted, a **signature**: Ed25519 over
  `agents-multi job v1` and the canonical JSON of `{id, node, kind, spec, expires}`. The private key is derived
  from the vault key (HKDF, its own label); the service never has it.
- **Accepting** happens on one of the owner's machines (`agents nodes accept`, or a coordinator's question):
  it reads the job back, shows it, signs it, and sends the signature. Accepted jobs expire after 24 hours.
  The approval can also come from the phone, as an assertion of a passkey a desktop endorsed
  ([ADR 0014](0014-from-the-phone.md)); the node checks it as it does the signature.
- **The node verifies** before it starts anything: the signature against the public key (derived from its own
  vault, or `approvalKey` in `node.json` for a node that has no vault), that the job names this node, that it
  has not expired and that it has not run it before (`<runs>/node/seen.json`).
- So **a stolen node token** can announce that node, see its jobs and claim them, but cannot make one run: it
  has no signature. **A compromised service** can hold a job back or show a wrong state, but cannot start an
  agent anywhere. What a token still reads is the brain itself: a narrower `node` scope is F2.
- A node's **own routines** run there without a signature, as today: they are files on that machine. agentd
  records each firing as a job of its own (`local`), so that it is seen and can be resumed.
- **A job taken is a one-shot routine** (`job-<id>`, `at` now, the job's id in it): the routines' tick fires
  it, so the run policy, the limits, the reviewer and the timeout are the same as for any routine. A job that
  fails the check is declined with the reason, and the owner is told.

### Placement

- A proposal names a job and a node, with why. The **service** raises one when a job is interrupted (resume
  it); the **CLI** (`agents nodes propose <routine> [--node N]`) and, in F2, a coordinator raise one to run a
  routine elsewhere now. Without a node named, the best is chosen (`place`): online, sandbox working, room
  under its cap, the account the job needs, then the server when the owner is away, else the node with the
  most room.
- The owner accepts or declines; a pending proposal lapses after 24 hours. Nothing moves on its own.

### Moving and resuming

- **Checkpoints**: every minute agentd pushes the branch `agent/<id>` of each of its runs whose head moved,
  and the run's HANDOFFs (`.agents/runs/…`, outside git, ADR 0005) as a commit of their own on
  `refs/agents/<id>`. The run's pre-push hook allows exactly these two refs for its id, besides the policy's.
- **Resuming** on another node: the repository is found there by its remote (a clone under `repoRoots` of
  `node.json`), the branch and the checkpoint are fetched, a new worktree continues the same `agent/<id>`, the
  HANDOFFs come back into its `.agents/runs/`, and the child is told it continues work a machine dropped: the
  task, where it was, what the commits and HANDOFFs say.
- A job in a folder with no remote, or a repository the node has no clone of, cannot move: the proposal says so.
  Nor can the runs of a repository whose policy forbids pushing (`push: false`): its hook refuses the
  checkpoint too.
- F1 resumes a run as **one child** of the job's account: a workflow's later steps are not restarted one by
  one, the child reads their HANDOFFs and carries on; resuming step by step is F2.

### The server node

- **One image** (`apps/node/`): Debian, git, bubblewrap, socat, Deno, Claude Code, the code of Agents Multi; it
  runs `agents serve --headless` as a user (uid 1000), with one volume for its home (runtime, configuration,
  Claude logins, clones, git credentials, the vault key file). Logins are made once in its terminal
  (`claude /login` through the profile's launcher, `agents brain-login`, `agents vault pair --file`).
- **The vault key without a keyring**: on a desktop the vault key is in the Secret Service keyring (KWallet,
  GNOME Keyring), which lives in the graphical login. Claude Code itself needs none (its login is a file); only
  our vault key does. Where there is no keyring, `agents vault pair --file` keeps it in a file only the user
  reads (`<state>/vault-key`, 0600); the doctor checks its mode. Whoever has the disk or root has every secret of
  the vault: the price the owner accepted.
- **`agents serve --headless`** refuses to start unless `node.json` says `headless` (`agents node enable
  --headless`): the children's sandbox comes from that file, so a headless backend without it would run them
  unsandboxed.
- **Bash sandbox on, failing closed**: every child on a headless node gets `--settings` with
  `sandbox.enabled`, `failIfUnavailable` and `allowUnsandboxedCommands: false` (which also stops a repository's
  settings from loosening it), reads denied on the vault key, the gateway tokens, the Claude logins and the git
  credentials, and the network limited to `node.json` `allowedDomains` (strict). agentd also probes bubblewrap
  at start and every hour; a node whose probe fails announces `sandbox: false`, takes no job and fires no
  routine. Since the git credentials are out of the sandbox's reach, **on a server only agentd pushes** (the
  run's branch and checkpoint); a push to `dev` waits for the owner — the node tightens the policy, as a
  repository may.

### Docker and the sandbox: what was measured

Measured on 2026-10-15 (Docker 29.9, kernel 7.2, debian:trixie-slim, bubblewrap 0.12, `@anthropic-ai/sandbox-runtime`
0.0.79, the runtime Claude Code's sandbox is built on), a non-root user, `--cap-drop ALL`, `no-new-privileges`:

- **Docker's default seccomp profile stops bubblewrap**: `clone` is allowed only without namespace flags, and
  `unshare`, `mount`, `umount2`, `pivot_root`, `setns` only with `CAP_SYS_ADMIN`. bwrap: "No permissions to
  create a new namespace".
- **The node's profile is Docker's plus one rule** allowing `unshare`, `clone`, `mount`, `umount2` and
  `pivot_root` without the capability (`apps/node/seccomp.json`). Each of the five was taken out once and bwrap
  failed without it; `setns` is not needed and stays refused, `clone3` stays `ENOSYS` (libc falls back to
  `clone`). Allowing a syscall grants no capability: the kernel still lets these act only inside a user
  namespace the caller made, which is what Debian already allows any user on the host.
- **`systempaths=unconfined`** as well: Docker overmounts parts of `/proc`, and the kernel then refuses a new
  `/proc`, so bwrap's own failed ("Can't mount proc"). Without the overmounts bwrap mounts a fresh `/proc` and
  **the weaker nested mode is not needed**. The overmounts protect `/proc/sysrq-trigger`, `/proc/kcore` and
  `/proc/sys` from a root user in the container; the node runs as uid 1000 with no capabilities, for whom they
  are closed anyway.
- **Measured inside the container, with `srt`**: the denied file is not there; through `/proc/<pid>/root` of a
  process outside the sandbox it is not either; only the sandbox's 4 processes are visible; a write outside the
  allowed folder is "read-only file system"; a host outside the list gets no connection. With the weaker mode
  instead (`/proc` of the container bound in), 18 processes are visible and the environment of another process
  of the same user is readable: what that mode gives up, and why the node does not use it.
- **A sandboxed command may make a user namespace of its own** with srt 0.0.79 (its seccomp layer blocks only
  Unix sockets); later srt releases refuse it. It is the same on a desktop host, and the mounts it inherits stay
  locked; it is noted, not solved here.
- **agentd's own probe** (`apps/cli/node/probe.ts`, `agents node probe`), run in the same container: with
  Docker's defaults it fails ("No permissions to create a new namespace"), with the seccomp profile alone it
  fails ("Can't mount proc"), with the profile and `systempaths=unconfined` it passes; each failure names
  what is missing.
- **AppArmor**: Docker's `docker-default` profile has `deny mount`, which would stop bwrap again on a host with
  AppArmor (Debian has it; this workstation does not, so it was not measured). The node ships its own profile
  (`apps/node/apparmor/agents-node`: `docker-default` with mounts and `pivot_root` allowed), loaded once on the
  host. If it is missing or not enough, the probe fails and the node takes nothing: failing closed.

## What protects what

- **Real boundaries**: outbound-only nodes; the signature checked on the node; the Bash sandbox on a headless
  node (bubblewrap, measured above) with `failIfUnavailable`; the container with no capabilities; the run
  policy's hook (ADR 0010) and the reviewer's rules (ADR 0011), unchanged.
- **Barriers against error**: the deny rules of ADR 0010; the service refusing a claim or report from another
  node's token.
- **Not covered**: a machine token reads the whole brain (F2: a `node` scope); Claude's Read and Edit tools are
  outside the sandbox and are held by permission rules only (the headless children get deny rules on the same
  secret files); a node whose disk is taken gives up its vault.

## Slices

- **F1**: the service's nodes and jobs (`apps/brain/fleet.ts`), the signature (`shared/mcp/lib/nodes.ts`),
  agentd's loop (announce, verify, claim, run, checkpoint, report: `apps/cli/node/`), resume from branch
  (`shared/mcp/lib/moving.ts`), `agents node`, the vault key file, the sandbox for headless children
  (`shared/mcp/lib/headless.ts`) and its probe; built on branches of their own: the node image (`apps/node/`),
  `agents nodes` (the view, propose, accept) and the doctor's `node.*` checks.
- **F2**: a `node` token scope; MCP tools for a coordinator (list nodes, propose); the console's view (with
  phase E); presence beyond "a session not locked".

## Consequences

- The service becomes the one place the machines meet; when it is down, nodes keep running their own routines
  and their running jobs, and catch up when it is back.
- A second process class runs on a server, as a container; app mode still needs neither systemd nor git.
- The CLI and the app's backend may read the load and the memory (`--allow-sys=hostname,loadavg,systemMemoryInfo`).
- The relay of ADR 0005 (issue #11) is not built: a job moves as a branch, never as a live session.
- Work that moves needs a remote both nodes can reach and a clone on each; the server's clones and credentials
  are the owner's to make, once.

## Amendment (1.2.1, 2026-10-15)

Configuring the first server showed three things the first slice had wrong.

- **A node's token is its own file, not the vault's.** `agents brain-login` keeps the brain token in the vault,
  which travels to every machine; the service names a node after its token, so every machine would have been the
  same node, and a login on one would have changed the others'. `agents node login` makes a token for this
  machine and keeps it in `<state>/node-token` (0600, never synced, denied to sessions like the vault key);
  agentd announces only with it (`node.token` in the doctor). The owner's views (`agents nodes`) use it when there
  is one, else the vault's.
- **Signing in with no browser.** On a server the brain's redirect lands on a `127.0.0.1` page the owner's browser
  cannot reach: `--no-browser` (or no opener) prints the link and takes the address pasted back.
- **The vault is a Syncthing folder of its own**, `~/agents-multi-vault` (was `~/vault/claude-multi`, still read
  until `agents vault move`), so that a server can be given that folder alone, as a trusted device, while the
  owner's other folders stay encrypted there. The node mounts it read only (`NODE_VAULT_DIR`): its jobs' MCP
  servers open their accounts, and whoever has the server has the vault — the price of MCP on a server, the same
  as with the key file.

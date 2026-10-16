# 0016 — The setup is too complex: stabilise before the stable, then a revamp

- Status: proposed 2026-10-16
- Date: 2026-10-16

## Context

One afternoon of bringing three machines (a laptop, a desktop, a server node) up to 1.2.1-rc.5/rc.6 showed what the
setup costs the person who owns it. Phases A–H are built; using them is the problem. What went wrong, in order of
cost:

1. **Each machine drifts and nothing says so.** The desktop had moved to `~/agents-multi-vault` on 1.2.1; the laptop
   was still on the old vault folder, so a sign-in on one never reached the other, and a pairing confirmed from the
   desktop's console made a second server vault with a key the server refused. The laptop also kept two checkouts of
   the repository (one with `core.bare` set and a stale index) and stale node names. The doctor looks at one machine:
   differences _between_ machines are nobody's check.
2. **Too many kinds of credential, shown alike.** Machine token, node token, the connector's OAuth token, Claude's
   setup tokens, the vault key, the server vault key, the pairing key, the approval key, passkeys. On the brain's
   `/account` the machine tokens are rows with a name and a date: the wrong one was revoked twice (the vault's brain
   token, then the server's new node token), and the server went offline.
3. **Every release adds a manual migration per machine.** `agents config move`, `agents vault move`,
   `agents node enable` after rc.2, accepting Syncthing folders with the right type (send/receive, receive only,
   trusted or encrypted), `bind-volume.sh` with sudo, `docker volume rm`, files to delete by hand. Skipping one
   leaves two realities.
4. **Fixing things still takes the CLI, often a lot of it.** Most repairs above were terminal work: SSH, `sudo docker
   exec`, `syncthing cli`, `agents …` subcommands with flags (`pair --server --url`), even `ssh … sudo rm` that only
   the owner could run. The console shows state but rarely mends it; the desktop app adds nothing the console does
   not. (Already noted: the task «Console: riparazioni e azioni funzionanti dalla UI».)
5. **Sharp edges in the commands**: `agents node token` broken by the launcher's `--mcp-config` (fixed, a763f0a),
   `pair --server` needing `--url` and refusing a revoked token, `agents brain-backup --help` running a backup, the
   local gate failing on build files that disappear.

The cause underneath: **the desired state is written nowhere.** Each machine reaches it by hand, step by step, and no
one compares the whole. «Simple for others» (ADR 0012's decision for the service) does not hold today.

## Decision

Two stages.

### Stage 1 — stabilise before 1.2.1 stable (features frozen)

- **Measure first**: a fresh install on a clean VM, and an upgrade from 1.2.0 on a copy of a real machine, counting
  every manual step. Each manual step is a bug: it is automated, moved into the app, or removed.
- **Migrations run themselves** at update, idempotent, recorded per machine (`<state>/migrations.json`), and the
  doctor names one that did not run. No release ships a step the person must remember on each machine.
- **One vault, one config, by construction**: a machine joining the owner's Syncthing gets the vault and config
  folders by their ids; a machine still on an old folder is a doctor failure with its fix (`agents vault merge`, then
  `vault move`), never a silent split.
- **Credentials you can tell apart**: `/account` lists one token per machine, with its kind (machine, node), the
  machine it belongs to, when it was made and last used; pairing a machine again **replaces** its token instead of
  adding a second row; revoking the token a node is using now asks twice and says it will go offline.
- **Pairing a server from any console** uses the shared vault's server key; a console that has none says so instead of
  making one.
- **Repairs from the UI**: every doctor finding with a fix gets a button in the console when the fix is a command of
  ours (the CLI stays, the page calls it); the ones that need root on a server show the exact command and why.
- **The commands' edges**: `--help` never acts; `pair --server` takes the service from the configuration and replaces
  a revoked token; the local gate's vanishing build files are found and fixed.

### Stage 2 — a complete revamp, graphics included

After the stable: **Agents Multi redesigned as one product across its three faces** — the web app (phone), the brain
(its pages, `/account`, the public site) and the desktop app (console). One design language, one information
architecture (what you do, not how it is built: «my machines», «my agents», «my memory», «my keys»), the same
components and words everywhere; the repairs of stage 1 as first-class screens. It starts with a design pass (an ADR
and mock-ups) before any code.

## Consequences

- No new features until stage 1 is through; 1.2.1 stable waits for it.
- The count of manual steps in a fresh install and in an upgrade becomes the measure of progress, written in this
  ADR's «As built».
- Stage 2 is large: it gets its own ADR, phases and review, and touches `apps/ui`, `apps/brain`'s pages and
  `apps/site`.

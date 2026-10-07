# 0001 — Repository layout: apps, packages, shared

- Status: accepted
- Date: 2026-10-06

## Context

The repository grew as top-level folders by history (`cli/`, `brain/`, `site/`, `lib/claude-multi-app/`,
`shared/`). Two of them are deployed on their own (the brain service and the site it serves), one
is installed on each machine (the CLI and its local console), and `shared/` is read at run time by
Claude Code through the `~/.claude-multi/shared` symlink. Code used by more than one of them (the
task model, the owner, masking) lived under `shared/mcp/lib/` and was reached by relative paths.

A self-hoster should be able to deploy one app by pointing a platform (Coolify, a compose host) at
its folder, and a contributor should see from the tree what is deployed, what is installed and what
is a library.

## Decision

```
apps/
  cli/        the agents-multi CLI and the local console (installed on each machine)
  brain/      the brain service: Dockerfile and compose.yaml in this folder (deployed)
  site/       the public site, Astro; built into the brain's image (deployed with it)
  tray/       the PySide6 tray app, until the desktop app replaces it
shared/       read at run time through ~/.claude-multi/shared: settings, hooks, agents, commands,
              skills, the MCP registry, the MCP servers and their library (shared/mcp/lib)
bin/          the bash launchers (no Deno on the launch path)
scripts/      the gate (check.sh, ci.sh) and release.ts
docs/adr/     decisions like this one
```

- `shared/` and `bin/` keep their paths: installed machines and Claude Code configurations refer
  to them, and moving them would need a migration on every machine for no gain.
- Code shared by the CLI alone stays in the CLI, split by concern under `apps/cli/lib/` (paths,
  fs, proc, output, git, profiles, machine, processes, …). A `packages/` folder appears when a
  second consumer does, not before.
- `shared/mcp/lib` never imports outside `shared/`: the MCP servers load it through the
  `~/.claude-multi/shared` symlink, where the rest of the repository is not reachable by a
  relative path. What the servers and the CLI both need (the vault, the task model) lives there.
- `apps/brain/compose.yaml` builds with the repository root as context, so a platform pointed at
  `apps/brain` (base directory) still reaches the shared code it imports. A prebuilt image is published as well
  (phase 6), for hosts that should not build at all.

## Consequences

- `bin/claude-multi` and `bin/claude-multi-app` point at `apps/`; nothing else on an installed
  machine refers to the old folders.
- The brain's deployment changes its base directory from `/brain` to `/apps/brain` in the same
  release that moves the folder.
- Operating-system specifics (systemd, the Secret Service keyring, /proc, pacman, KDE) are
  confined to named modules (`apps/cli/lib/machine.ts`, `apps/cli/lib/processes.ts`,
  `shared/mcp/lib/vault.ts`, `apps/cli/install.ts`), so macOS and Windows support (1.x) replaces
  modules rather than lines spread across the code.

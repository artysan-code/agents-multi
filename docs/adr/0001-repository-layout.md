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
  cli/        the claude-multi CLI and the local console (installed on each machine)
  brain/      the brain service: Dockerfile and compose.yaml in this folder (deployed)
  site/       the public site, Astro; built into the brain's image (deployed with it)
  tray/       the PySide6 tray app, until the desktop app replaces it
packages/
  core/       pure logic, no I/O: merge patches, versions, plugin records, settings layering
  platform/   operating-system adapters behind one interface each: keyring, services,
              processes, notifications, opening URLs, desktop entries, paths
shared/       read at run time through ~/.claude-multi/shared: settings, hooks, agents, commands,
              skills, the MCP registry, the MCP servers and their library (shared/mcp/lib)
bin/          the bash launchers (no Deno on the launch path)
scripts/      the gate (check.sh, ci.sh) and release.ts
docs/adr/     decisions like this one
```

- `shared/` and `bin/` keep their paths: installed machines and Claude Code configurations refer
  to them, and moving them would need a migration on every machine for no gain.
- An app may import `packages/*` and `shared/mcp/lib`; a package never imports an app.
- `apps/brain/compose.yaml` builds with the repository root as context, so a platform pointed at
  `apps/brain` (base directory) gets the packages it needs. A prebuilt image is published as well
  (phase 6), for hosts that should not build at all.

## Consequences

- `bin/claude-multi` and `bin/claude-multi-app` point at `apps/`; nothing else on an installed
  machine refers to the old folders.
- The brain's deployment changes its base directory from `/brain` to `/apps/brain` in the same
  release that moves the folder.
- Splitting `cli/lib.ts` lands its pure parts in `packages/core` and its OS calls in
  `packages/platform`, so the split and the move are done once.

# 0002 — Versions, branches and releases

- Status: accepted
- Date: 2026-10-06

## Decision

- **Semantic Versioning**, one version for the whole repository, kept in `deno.json` and copied to
  every manifest listed in `MANIFESTS` (`scripts/release.ts`). Raising a component resets the ones
  to its right: 0.1.24 → 0.2.0 → 1.0.0. Before 1.0.0 a breaking change raises the minor.
- **Branches**: `dev` receives the work; `beta` and `release` move only by merge from the branch
  before them. Betas (`X.Y.Z-beta.N`) and release candidates (`X.Y.Z-rc.N`, after the last beta) are cut on `beta`; stable versions are cut on `release`.
  Installations follow `release`.
- **Commit subjects are Conventional Commits**; the CHANGELOG section and the bump are generated
  from them by `deno task release`. The `commit-msg` hook and CI enforce the format on every commit
  since the last tag.
- **Forgejo is the primary remote** and the only place CI runs (its own runner). GitHub is a push
  mirror of Forgejo from 1.0.0 on; the public history starts with a single 1.0.0 commit, and
  Forgejo is realigned to the same commits at that point.
- **Desktop app updates** (from phase 6): the Tauri updater, with signed artifacts. The artifacts
  are GitHub release assets; the update manifest per channel (`stable`, `beta`) is served from the
  project site, so the app does not depend on where the artifacts live.

## Consequences

- A machine whose runtime is a checkout keeps it on `release` and develops in a worktree on `dev`.
- The release tooling has no dependency outside Deno and git.

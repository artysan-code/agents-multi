# Contributing

Thank you for wanting to help. Before a pull request is merged, two things: how the work is done here,
and the agreement that covers what you contribute.

## How the work is done

- Read [AGENTS.md](AGENTS.md): the rules for working in this repository (layout, modes, what never goes
  into it).
- Work on a branch from `dev` and open the pull request against `dev`.
- Commit subjects are Conventional Commits (`<type>(<scope>): <description>`); the `commit-msg` hook and
  CI check them.
- Before opening the pull request, run `deno task ci` (or at least `deno task check` and `deno task test`).
- Code, commits and docs are in English. Nothing personal goes in: no names, clients, accounts, home
  paths or credentials.

## Contributor licence agreement

The project is source-available under the AGPL-3.0 with the Commons Clause ([LICENSE](LICENSE)). So
that its owner can keep maintaining it, and change its licence later if needed, every contribution is
made under this agreement.

By submitting a contribution (code, documentation, artwork or anything else) you agree that:

1. **You keep your copyright.** What you wrote stays yours; you can use it elsewhere as you like.
2. **You grant a licence to the project's owner**, Samuel Tagliacozzo, and to whoever later takes
   over the project: a perpetual, worldwide, non-exclusive, royalty-free, irrevocable licence to use,
   copy, modify, distribute and sublicense your contribution, and to **relicense** it, including under
   terms other than the project's current licence.
3. **You have the right to contribute it.** The contribution is your own work, or you have the right to
   submit it under these terms (for example, your employer allows it). If it includes someone else's
   work, you say so in the pull request, with its source and licence.
4. **No warranty.** You give the contribution as it is, without warranty of any kind.

**How to accept it:** write in the pull request's description

> I have read the contributor licence agreement in CONTRIBUTING.md and I accept it for this contribution.

A pull request without that sentence is not merged. An automated check will replace this step later.

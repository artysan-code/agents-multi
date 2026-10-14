# 0010 — Scheduler, run policy and limits manager

- Status: accepted
- Date: 2026-10-14

## Context

[ADR 0009](0009-agents-multi-2.md) (phase D) wants the orchestrator to work when the owner is not there:
routines on a clock or an event, and a policy per repository that says what an unattended run may do to it.
The console's backend already ran internal jobs in app mode (`apps/cli/console/schedule.ts`).

## Decision

### Routines

- A routine is a file, `<runs>/routines/<id>.json` (trigger, action, folder, project), with its state in
  `<id>.state.json`. The CLI and the MCP tools only write and read these files, which is all the narrow
  permissions of the `agents` server allow; the **console's backend fires them** (`startRoutineSchedule`, in
  both modes, every 15 s). A firing is one `tick` over the files, written back only when it changed: nothing
  lives in the process, so a restart loses nothing.
- Triggers: `cron` (five fields, local time), `at` (one-shot), `event` (`run-done`, `run-failed` of a workflow
  run of the same project, by plan name if given; what ended before the routine looked is history; a routine's
  own runs never trigger one). Task-due from the brain is not built: it needs a brain call from the backend for
  little; a cron routine can do it.
- Actions: a child (profile, model, task) or a plan file. A plan's folders move into the run's worktree; a step
  outside the repository is refused.
- **Missed.** An `at` later than its `grace` (default 6 h) is marked `missed` and the owner is told — a night job
  does not start at breakfast. A cron later than its grace (15 min) is skipped to the next time and logged. An
  event routine cannot be missed: it looks at the runs it has not seen.
- **Ownership.** The children and runs of a routine are the project's, with no coordinator
  (`owner: { project }`): by ADR 0005 that is an orphan, so any coordinator of the project sees it and may adopt
  and answer it, and no one else can. The first message names the routine and the run.
- Scheduling from chat is limited to the session's own project; a plain terminal may schedule anywhere under home.

### Run policy

- **Where it lives.** The owner's defaults in their configuration (`config/policy.json`), a repository's
  `.agents/policy.json` (excluded from git like the rest of `.agents/`, ADR 0005) which can only **tighten**:
  fewer pushable branches, less time or concurrency, no commit or push, more protected branches. The owner's
  file may loosen the defaults but not the floor: `main`, `master`, `release` are never pushable. Junk in a file
  is ignored. Pure: `resolvePolicy`.
- **Defaults** (ADR 0009, 19): own branch `agent/<id>` in a dedicated worktree beside the repository, from `dev`
  (or HEAD without one); commits allowed; push to its own branch and `dev`; 120 minutes; two runs at once
  (machine-wide, over all routines). A firing that finds no room waits (`queued`) until its grace, then is missed.
- **Enforcement is git's.** A `pre-push` hook is written for the run and set with `git config --worktree
  core.hooksPath` (this turns on `extensions.worktreeConfig` in the repository, so the main checkout and other
  worktrees are untouched): it refuses protected refs, any ref outside the allow list, tags and deletions. The
  child also gets deny rules (`--disallowedTools`: `--no-verify`, `--force`, `git config … hooksPath`, `git -c`),
  a guard against error; the boundary against intent is the hook plus, on a server, the Bash sandbox (ADR 0009,
  24). A Codex child does not get the rules (Claude's flag), only the hook.
- **Outward actions** are the child's permission requests: they already wait in the hub. For an unattended run
  the runner announces each once with `desktopNotify()` (the routine, what it wants), and the same for a run's
  end, timeout (the child is stopped, its branch keeps the commits) and failure to start.

## Consequences

- No unit file and no systemd: app and dev mode behave alike.
- The worktree and branch of a run stay after it ends, for review and merge; cleaning them is the owner's.
- A workflow routine's children are started by the runner of ADR 0005, which does not pass the deny rules; the
  hook still holds.

## Part 2 — the limits manager and account routing

ADR 0009 (16–17): usage windows per account, rules over them, events, and a default account per project the
owner confirms. Built on phase C's providers (`Provider.limits`, ADR 0007): nothing is read from a vendor or a
login here; the one place that does stays `apps/cli/live.ts`.

- **Scan.** Every minute the console reads each account's running windows through `allLimits` (the status line's
  snapshots for Claude, Codex's session logs), runs the owner's rules (`config/limits.json`, defaults below) over
  them (pure: `evaluate`), and keeps `<runs>/limits/state.json` (what routines consult) and `events.jsonl`. A
  scan older than 30 minutes blocks nobody: unknown is never a guess.
- **Rules**, per account, over its windows: `stopAt` 80 — at that % of any window the account takes no new
  unattended work (`blocked`); `expiringMin` 60 and `roomPercent` 30 — a window resetting within the hour with
  30 % free is `expiring` (the owner is told; a coordinator can offer queued work); a window whose time passes
  or comes back later is `reset`. Each event has a stable id and is announced once, with `desktopNotify()`;
  `agents account events` and `account_status` show them.
- **Routines honour them.** Before a firing starts, its accounts (the child's, or the plan's steps') are checked
  against the last scan: a blocked one **holds** it (queued, the owner told once). A held firing waits for the
  window (`holdMaxMin`, 12 h), not for its short grace, and goes on the tick after the account is released; a
  `limit-reset` trigger (`--on limit-reset [--account p/claude]`) wakes a routine on a reset. Work the owner or a
  coordinator starts by hand is not stopped: the rules are for what runs unattended.
- **Accounts are the owner's.** A project's default is `config/projects.json` (folder under home → `{profile,
  provider}`; the longest folder wins, so a sub-project inherits); a routine without `--profile` runs on it. The
  console never switches an account on its own. A held routine, or a coordinator (`account_propose`), raises a
  **proposal** — "use B instead of A", for one routine or as the project's default — that stays pending until
  the owner says yes through the coordinator's question (`account_accept` / `account_decline`) or
  `agents account accept`. The `agents` MCP server may write only the hub's state, so an accepted proposal is
  applied by the console (or the CLI), which alone writes the owner's configuration and the routine's file.
  A plan's accounts are its steps' own, so a held plan raises no proposal: change the plan.
- **Not here:** an accounts page in the console (phase E), and routing of work the owner starts by hand.

# Agent Catalog

Two tiers. Tier 1 = always loaded. Tier 2 = via plugin (auto-active when plugin enabled).

> Esisteva un Tier 3 ("R7 catalog": 8 agent on-demand presi da
> [everything-claude-code](https://github.com/affaan-m/everything-claude-code/tree/main/agents)).
> Rimosso il 2026-07-26. Fonti e licenze degli agent: `THIRD_PARTY_NOTICES.md` alla radice.

---

## Tier 1 — LOADED (shared/agents/)

These agents are available in every session without any extra invocation.

| Agent                | File                    | Model  | Trimmed?                                     | When to use                                                         |
| -------------------- | ----------------------- | ------ | -------------------------------------------- | ------------------------------------------------------------------- |
| build-error-resolver | build-error-resolver.md | sonnet | No                                           | When tsc or pnpm build fails (non-React)                            |
| react-build-resolver | react-build-resolver.md | sonnet | No                                           | When Vite/Next.js build fails                                       |
| database-reviewer    | database-reviewer.md    | sonnet | Yes (Read/Bash/Grep/Glob; Drizzle annotated) | After Drizzle schema changes, SQL query writing, migration creation |

### Rimossi il 2026-07-26 (debloat Tier B)

Erano duplicati di capacità già presenti nel harness o nei plugin abilitati. I file
sono recuperabili da git (`shared/`) o dal backup `10-HOME-FULL`.

| Agent rimosso       | Sostituito da                                            |
| ------------------- | -------------------------------------------------------- |
| planner (opus)      | agent `Plan` built-in + plan mode                        |
| security-reviewer   | plugin `security-guidance` + `/security-review` built-in |
| typescript-reviewer | plugin `code-review` + `/code-review` built-in           |
| react-reviewer      | idem, con `/react-review` per le lane React-specifiche   |

Rimossi insieme a loro i comandi `/plan` (→ plan mode) e `/pr` (→ plugin
`pr-review-toolkit`). Restano i due `*-build-resolver`: sono gli unici con
`Write`/`Edit` e non hanno equivalente built-in.

---

## Tier 2 — VIA PLUGIN (active when plugin enabled)

These agents are provided by enabled plugins and are auto-available.

### pr-review-toolkit@claude-plugins-official

| Agent                 | Model   | When to use                                                                  |
| --------------------- | ------- | ---------------------------------------------------------------------------- |
| code-reviewer         | opus    | Comprehensive code review before PR; proactively after writing code          |
| silent-failure-hunter | inherit | Review error handling — swallowed errors, bad fallbacks, missing propagation |
| comment-analyzer      | inherit | Check comment accuracy vs actual code; before finalizing docs                |
| pr-test-analyzer      | inherit | Verify test coverage quality and completeness on a PR                        |
| type-design-analyzer  | inherit | Review new types for encapsulation and invariant expression                  |
| code-simplifier       | inherit | Find reuse/simplification opportunities in changed code                      |

### commit-commands@claude-plugins-official

Provides commands: /commit, /commit-push-pr, /clean_gone

### code-review@claude-plugins-official

Provides command: /code-review (8-step multi-agent PR review with confidence scoring; requires gh CLI and a PR number)

### security-guidance@claude-plugins-official

PreToolUse hook on Edit/Write/MultiEdit — warns on: GitHub Actions injection, child_process.exec, new Function, eval, dangerouslySetInnerHTML, document.write, innerHTML, pickle, os.system.

> **Known limitation**: session-level deduplication is broken because ~/.claude is permission 000 (tripwire). Each matching edit will re-show the warning. This is harmless. Fix: patch security_reminder_hook.py STATE_FILE path to ~/.agents-multi/shared/ (separate TASK).

---

## Known Limitations

- **security-guidance state files**: The plugin tries to write per-session state to ~~/.claude/ which is a permission-000 tripwire. The PermissionError is caught silently (IOError subclass in Python 3). Result: warnings are not deduplicated per session. Patch target: line 132 of security_reminder_hook.py — change os.path.expanduser('~~/.claude') to '~/.agents-multi/shared/security-guidance-state' (expanded).
- **code-review plugin**: Requires gh CLI authentication and an open PR number. Does not work for local (uncommitted) diff review. For local review, invoke the code-reviewer Tier-2 agent manually, or `/react-review` per le lane React.

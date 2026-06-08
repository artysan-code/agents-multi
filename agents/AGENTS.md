# Agent Catalog

Three tiers. Tier 1 = always loaded. Tier 2 = via plugin (auto-active when plugin enabled). Tier 3 = R7 catalog: NOT loaded; pull the file on-demand from ~/claude-multi-optimization/ECC/agents/ when you need it.

---

## Tier 1 — LOADED (shared/agents/)

These agents are available in every session without any extra invocation.

| Agent | File | Model | Trimmed? | When to use |
|---|---|---|---|---|
| typescript-reviewer | typescript-reviewer.md | sonnet | No | After any TS/JS change; before PR on .ts/.js files |
| react-reviewer | react-reviewer.md | sonnet | No | After any .tsx/.jsx change; run alongside typescript-reviewer |
| security-reviewer | security-reviewer.md | sonnet | Yes (Read/Grep/Glob/Bash only) | After writing auth/API/user-input/payment code |
| build-error-resolver | build-error-resolver.md | sonnet | No | When tsc or pnpm build fails (non-React) |
| react-build-resolver | react-build-resolver.md | sonnet | No | When Vite/Next.js build fails |
| planner | planner.md | opus | No | Before implementing any non-trivial feature; generates phased plan |
| database-reviewer | database-reviewer.md | sonnet | Yes (Read/Bash/Grep/Glob; Drizzle annotated) | After Drizzle schema changes, SQL query writing, migration creation |

---

## Tier 2 — VIA PLUGIN (active when plugin enabled)

These agents are provided by enabled plugins and are auto-available.

### pr-review-toolkit@claude-plugins-official

| Agent | Model | When to use |
|---|---|---|
| code-reviewer | opus | Comprehensive code review before PR; proactively after writing code |
| silent-failure-hunter | inherit | Review error handling — swallowed errors, bad fallbacks, missing propagation |
| comment-analyzer | inherit | Check comment accuracy vs actual code; before finalizing docs |
| pr-test-analyzer | inherit | Verify test coverage quality and completeness on a PR |
| type-design-analyzer | inherit | Review new types for encapsulation and invariant expression |
| code-simplifier | inherit | Find reuse/simplification opportunities in changed code |

### commit-commands@claude-plugins-official
Provides commands: /commit, /commit-push-pr, /clean_gone

### code-review@claude-plugins-official
Provides command: /code-review (8-step multi-agent PR review with confidence scoring; requires gh CLI and a PR number)

### security-guidance@claude-plugins-official
PreToolUse hook on Edit/Write/MultiEdit — warns on: GitHub Actions injection, child_process.exec, new Function, eval, dangerouslySetInnerHTML, document.write, innerHTML, pickle, os.system.

> **Known limitation**: session-level deduplication is broken because ~/.claude is permission 000 (tripwire). Each matching edit will re-show the warning. This is harmless. Fix: patch security_reminder_hook.py STATE_FILE path to ~/.claude-multi/shared/ (separate TASK).

---

## Tier 3 — R7 CATALOG (on-demand from ECC)

NOT loaded. To use: read the file directly from ~/claude-multi-optimization/ECC/agents/<name>.md and pass its content to a subagent, OR copy to shared/agents/ if you find yourself using it daily.

| Agent | ECC path | When you would want it |
|---|---|---|
| performance-optimizer | agents/performance-optimizer.md | Bundle analysis, Lighthouse audit, React render profiling, memory leak hunt. Trim Write/Edit before use (read-only auditor). |
| refactor-cleaner | agents/refactor-cleaner.md | Dead code removal with knip/depcheck/ts-prune before a major release. Needs Write/Edit/Bash (it's a fixer). |
| code-architect | agents/code-architect.md | High-level architectural design for new subsystems. |
| code-explorer | agents/code-explorer.md | Deep codebase navigation/understanding before large refactors. |
| doc-updater | agents/doc-updater.md | Keep docs in sync after large changes. |
| loop-operator | agents/loop-operator.md | Multi-step automation loops (see also continuous-agent-loop skill). |
| architect | agents/architect.md | Alternative to planner for pure architecture work. |
| harness-optimizer | agents/harness-optimizer.md | Optimize the Claude Code harness/hooks itself. |

---

## Known Limitations

- **security-guidance state files**: The plugin tries to write per-session state to ~/.claude/ which is a permission-000 tripwire. The PermissionError is caught silently (IOError subclass in Python 3). Result: warnings are not deduplicated per session. Patch target: line 132 of security_reminder_hook.py — change os.path.expanduser('~/.claude') to '~/.claude-multi/shared/security-guidance-state'.
- **code-review plugin**: Requires gh CLI authentication and an open PR number. Does not work for local (uncommitted) diff review. For local review, invoke the code-reviewer Tier-2 agent manually or use typescript-reviewer + react-reviewer.

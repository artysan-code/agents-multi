# 0011 — The reviewer: rules and a judge for unattended runs

- Status: accepted
- Date: 2026-10-15

## Context

[ADR 0009](0009-agents-multi-2.md) (1, 23; phase H) wants outward actions of work nobody watches — send,
publish, deploy, delete, spend — confirmed by the owner or by a **reviewer agent** under rules the owner set,
with content from outside treated as data, never as instructions. Phase D ([ADR 0010](0010-scheduler-and-run-policy.md))
gave the ground: routines fire children and workflows that belong to their project with no coordinator, and
every permission their mode does not grant waits in the hub ([ADR 0005](0005-agent-workflows.md)); until now
the owner was told once and the request waited until the run's timeout stopped it.

The owner chose (2026-10-15), among the options weighed:

- **who decides** — rules plus an LLM judge only where a rule asks for one, at the lowest cost (over rules
  alone, which cannot read a mail's content, and over a judge on every request, which widens the surface
  of injection and costs more);
- **the rule language** — Claude Code's permission syntax in four lists (over an ordered first-match list,
  where a misplaced line widens silently, and over coarse categories, whose classifier misreads new servers);
- **"ask" with nobody there** — wait a while, then refuse (over refusing at once, which leaves nothing to
  approve, and over waiting until the run's timeout, which burns the night);
- **scope** — the runs of routines only (over including every orphan, which would put a child the owner
  started under rules written for the night).

## Decision

### Where the rules live, and their shape

- The owner's rules are `config/reviewer.json`; a repository may add `.agents/reviewer.json` (outside git,
  ADR 0005), from which only `deny` and `ask` are read: a repository tightens, it never allows.

  ```json
  {
    "allow": ["Bash(wrangler deploy --env dev:*)"],
    "ask": ["mcp__google__calendar_*"],
    "deny": ["Bash(npm publish:*)", "mcp__coolify__coolify_deploy"],
    "review": [{ "match": "mcp__google__gmail_send", "criterion": "only replies to a thread already open" }],
    "askMin": 30,
    "judge": { "model": "haiku", "maxPerDay": 50 }
  }
  ```

- A rule is Claude Code's: `Tool`, `Tool(content)`. A tool name may hold `*` (`mcp__google__*`). Bash:
  `prefix:*` (the command or the command and more words), a glob with `*`, or the exact command. WebFetch:
  `domain:host` (a glob on the host). File tools: a path glob (`/abs/**`, `~/x`, or relative, matched at the
  end of the path). Any other tool: a glob on the line a person reads (`whatOf`). Junk is dropped and the
  doctor names it (`reviewer.rules`), as it does an `allow` that lets a run do anything (`Bash`, `Bash(*)`, a
  shell or an interpreter, `reviewer.broad`) and a pattern that covers a workflow's team channel,
  `mcp__team__team_send` (`reviewer.team`: forced as an ask, it would stop the steps talking).
- `config.example/reviewer.json` is the conservative start `agents init` copies: deletes and publishing
  denied, sends, deploys and merges asked for, nothing allowed, and a mail-reply `review` left as an example.

### How a request is matched

- **Most restrictive wins**, order does not matter: `deny` > `ask` > `review` > `allow`; nothing matched is
  `ask`. A Bash command with shell syntax (`;`, `&`, `|`, `<`, `>`, `$`, backquotes, brackets, a new line)
  never matches `allow` or `review`; it matches `deny` and `ask` if any of its parts does. Pure: `decide`.
- **`review` calls the judge**: a Claude Code run on the official CLI (ADR 0009, 10), through the profile's
  launcher — `-p --safe-mode --strict-mcp-config --tools "" --no-session-persistence`, a system prompt of its
  own, `--json-schema` for `{verdict: allow|deny|ask, reason}`, in an empty folder. No tools, no MCP, no
  CLAUDE.md: about 1.2k tokens in, measured on Haiku. It reads the owner's criterion, the routine's name and
  task (the owner's words), and the request — tool, masked input (`lib/mask.ts`), cut at 4000 characters —
  inside a block it is told is data.
- **Cost kept low**: the judge runs only under a `review` rule; the model is `judge.model` (default `haiku`);
  the same request under the same criterion reuses the verdict of the last 24 hours; at most `maxPerDay`
  judgements a day (0 turns the judge off), past which a `review` is an `ask`. Its account is `judge.profile`,
  else the child's; a Codex account or one the limits manager blocks is not used (`ask`).
- **The judge can only narrow**: its verdict is clamped to the rule, an error, a timeout (90 s) or anything
  outside the schema is `ask`.

### What reaches it, and how it answers

- **Scope**: the children of routine firings that have not ended (a child routine's child, a workflow
  routine's step children). Work the owner or a coordinator starts is untouched: its requests reach the owner
  as before.
- **What reaches it**: whatever the child's mode did not grant. So that a rule is not skipped by the auto
  classifier, a routine's child is started with every `allow`, `ask` and `review` pattern as a session `ask`
  rule (`--settings`, Claude Code then always asks the hub) and every `deny` pattern added to its
  `--disallowedTools` (refused in the client, no round trip). A workflow routine's step children get the same
  through the runner of ADR 0005: the firing writes them, with the run policy's deny rules, in the run's
  `guard.json`, and the runner starts each step under it (a run started by hand has none). Codex children
  never ask (ADR 0007).
- **Tool-name globs are Claude Code's own**, so nothing is expanded at launch. Checked on 2026-10-15 with a
  stdio MCP server of two tools and a Haiku child in auto mode: without a rule it called `x_delete` unasked;
  with `mcp__*__*delete*` (as with `mcp__probe__*` or the exact name) it asked the hub for
  `mcp__probe__x_delete` (`decision_reason_type: rule`) and still called `x_read` unasked.
- **The console's backend** looks every 5 s (beside the routine tick, its own loop, so a slow judge never
  delays a firing) and answers through the hub's `answer`: `allow` the one call, or `deny` with the reason.
  An `ask` is announced once with `desktopNotify()`; a coordinator of the project can adopt the child and
  answer (ADR 0005). After `askMin` minutes (default 30) unanswered, it is refused: "the owner did not answer;
  do not retry it, list it in your last message as left for the owner". A child's `AskUserQuestion` is never
  answered by the reviewer: it is an `ask`, refused at the same time with "choose the safest option and say so".
- **Logged**: every decision, one line in `<runs>/reviewer/decisions.jsonl` — when, routine, run, child,
  request, tool, what (masked, one line), the rule, the verdict, who decided (`rule`, `judge`, `default`,
  `timeout`, `cache`) and why. `agents review` shows them; `agents review rules [folder]` the rules a
  project's runs get. What waits is in `<runs>/reviewer/state.json`, pruned as requests close.

### What it never does

- Content from outside is **data**: the judge has no tools to act with, and its answer is a verdict in a
  schema, clamped by the rule. An injection can at most make it say `allow` inside the perimeter the owner
  wrote for that rule.
- It **never widens**: never "yes for the session", never a settings file, never an answer to a question, a
  repository's `allow` or `review` never read, and nothing it does reaches past the run policy's hook and deny
  rules (ADR 0010), which hold whatever it says.
- It never touches a child outside a routine's firing, and an owner's answer that came first wins: a request
  no longer pending is left alone.

## Consequences

- An unattended run no longer burns its window on a question nobody answers: it is refused after `askMin` and
  the run goes on to its end.
- Every pattern in the rules becomes a hub round trip for a routine's child (up to 5 s), even an `allow`: the
  price of a log of every outward action the owner named.
- The judge spends from a Claude account's windows; under a blocked account it is skipped, never forced.
- Not here: rules for work started by hand, a console page for the log (phase E), rules per routine.

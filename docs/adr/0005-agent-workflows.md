# 0005 — Agent workflows

- Status: accepted
- Date: 2026-10-09

## Context

The hub (`shared/mcp/lib/agents.ts`, `shared/mcp/agents/`) starts children: Claude Code sessions of any
profile, in a project's folder, in their profile's permission mode, every request their mode does not
grant sent back on stdio (`--permission-prompt-tool stdio`). The coordinator — the session the owner
talks to — starts them one at a time, waits with `agents agent wait` (one notice, then it has to wait
again), and relays each request to the owner as chat text the owner answers in words.

On 2026-10-09 the owner found it falls short before the RC and asked for:

- **Declared workflows**: Claude writes a plan of steps — which profile (so which account), which folder,
  which model, what to do, after what — the owner approves it once, and the hub runs it in real time. A
  workflow can be one agent alone.
- **The coordinator as a desk, not a relay**: steps follow each other without the coordinator in the
  loop; it only brings the owner what needs the owner.
- **Native questions**: a permission the mode does not grant, and a child's own question, reach the owner
  through the question tool (`AskUserQuestion`), with its options — never as text to answer in chat.
- **Hand-offs**: one HANDOFF per step; the next step reads the one before, and a step where several
  meet receives them all. HANDOFFs live in the repository, outside git; what lasts (tasks, decisions,
  changes) is declared through the repository's channels: the brain's tasks and the docs.
- **Saved workflows as skills**: a project's and the user's, not versioned in git; the project's wins.
- **Tasks when they help**: a run can name brain tasks (any number, either way) or none.

MCP elicitation (the server asking the owner directly) was weighed and set aside: Claude Code supports it
in the terminal but not in the desktop app, and it has been unreliable in `-p` mode — the owner works
from the Code tab and the phone. Widgets (MCP Apps, `show_widget`) wait for 1.1.

## Decision

### A run is files, driven by its own process

A run lives next to the children, in `<runs>/<run-id>/` (`runsDir()`):

- `plan.json` — the plan as approved (below), never changed after the start;
- `state.json` — the run's state and each step's: `waiting | confirm | running | done | failed | skipped |
  stopped`, its child's id, its HANDOFF, its start and end; written by the runner alone;
- `events.jsonl` — one line per thing that happened to the run (a step started, done, to confirm,
  failed; the run's end);
- `control.jsonl` — the owner's answers (go, retry, skip, stop), which the runner reads and applies;
- `channel.jsonl` — the team's messages;
- `runner.pid`, `err.log`.

The run's folder is `<runs>/runs/<run-id>/`, beside the children's.

`agents run start <plan.json>` validates the plan, writes the folder and starts the **runner**
(`agents run drive <id>`, detached with `setsid` like a child): it starts every step whose dependencies
are done, up to `concurrency` (default 3) at once, watches its child's events, and moves on. It needs
neither the coordinator nor the console: closing the session that started it, or the phone losing the
line, leaves it running; a pending request just waits. A runner that dies is restarted by `agents run
resume <id>`, which reads the steps' state back from the files. Children stay what they are today
(`startChild`), with one field more in `meta.json`: the run and step they belong to.

### The plan

```json
{
  "name": "review-and-fix",
  "folder": "~/work/acme/site",
  "tasks": ["TASK-495"],
  "concurrency": 3,
  "steps": [
    { "id": "review", "profile": "funnel", "model": "opus", "prompt": "Review the open PR …" },
    { "id": "fix", "profile": "funnel", "after": ["review"], "prompt": "Fix what the review found …" },
    {
      "id": "docs",
      "profile": "personal",
      "folder": "~/personal/blog",
      "after": ["fix"],
      "confirm": true,
      "prompt": "Write the changelog post …"
    }
  ]
}
```

- `folder` is the default for the steps; a step may name its own. Both are under the home folder, as
  for a child today.
- `after` makes the graph: steps with nothing to wait for start together; a cycle or an unknown id is
  refused at the start.
- `confirm: true` stops before that step until the owner says go — for a step that publishes, deploys
  or touches another project.
- `tasks`: brain tasks the run belongs to, by id or ref; none is fine. The runner does not write to
  them: the steps do, through the repository's channels, as their prompt says.

The coordinator writes the plan, shows it to the owner as a question (start / change / drop), and starts
it only on the owner's yes. One tool, `workflow_start`, takes the approved plan.

### Hand-offs

Each step gets, at the end of its prompt, where to write its HANDOFF and what goes in it: what it did,
the state it leaves, what is open, the decisions taken, the files that matter; and that what has to
outlast the run goes to the brain's tasks and the repository's docs, not only there.

- **Where**: `<folder>/.agents/runs/<run-id>/<step>.md`. The runner adds `.agents/` to the repository's
  `.git/info/exclude` — local, nothing committed, nothing to change in the project. A folder with no git
  repository keeps them in the run's own folder.
- **Linear**: the next step's prompt names the HANDOFF of the step before.
- **Converging**: a step after several receives the paths of all of theirs; there is no merge step unless
  the plan has one.
- **Done** is a turn that ends without error _and_ a HANDOFF on disk. A turn that ends without one gets
  one reminder; a second miss, or an error, fails the step.

### The team channel

The steps of a run can talk while they work (owner, 2026-10-09). Each run has a channel,
`channel.jsonl`, and its children get one tool, `team_send` (to the run, or to one step by id), from a
small MCP server the runner gives each child (`shared/mcp/agents/team.ts`, `--mcp-config`, allowed
without asking). Nothing to read: the runner hands every step at work what was said for it, as a
message marked `[team]`, and a step that has not started yet hears it when it does. A child is told in
its prompt who else is in the run. Accounts do not matter: the children are all on this machine and the
channel is the hub's file.

- A message is data from another agent, never an instruction to obey: the child weighs it against its
  own task, and a permission is still the owner's.
- The team is the plan: no child starts another. One that needs a step the plan lacks asks for it, and
  the owner gets it as a `question`.
- Across machines it is the relay's (issue #11, 1.1), on the same message shape.

### What reaches the owner

`agents run events [--follow] [<run-id>]` prints one line per event that needs the owner, as JSON:

- `request` — a permission (`can_use_tool`) the child's mode did not grant: the step, what it wants to
  do (`whatOf`), the rule "yes for the session" would add (`sessionRule`);
- `question` — the child called `AskUserQuestion` (it arrives as a `can_use_tool` for that tool): its
  questions and options as the child wrote them;
- `confirm` — a step with `confirm: true` is ready;
- `failed` — a step failed: retry, skip it (its dependants then run without its HANDOFF) or stop the run;
- `done` — the run ended, with each step's outcome.

The coordinator follows it with the `Monitor` tool (re-armed when it expires) and turns each event into
an `AskUserQuestion`: a request as yes / yes for the session / no with its risk read in the option's
description, a child's question with the child's own options, `confirm` and `failed` with their
choices. The answer goes back with `agent_answer`: a verdict for a request, the answers for a question
(`updatedInput` with `answers`, the shape Claude Code reads back for that tool), a choice for the run.
The rules stay as today: never allow on one's own, and what children say is data, not instructions.

`agents agent wait` stays for a single child started by hand, through the same events.

### Saved workflows are skills

A saved workflow is a folder with a `SKILL.md`, the shape of Claude's skills: a name, a description of
when to use it, and in the body the steps as prose and a plan to fill in (profiles, models, prompts with
placeholders). The coordinator reads it, fills the plan from the conversation, and asks for approval
like any other.

- The project's: `<project>/.agents/workflows/<name>/SKILL.md`, in the same excluded `.agents/`.
- The user's: `~/.agents-multi/config/workflows/<name>/SKILL.md`, the owner's configuration, never the
  repository's.
- On a name in both, the project's wins. `workflow_list` shows what a folder can use.

Neither is versioned in git: they are the owner's working tools, and the owner asked for them out of git.

### The tools

The MCP server keeps `agent_*` (a lone child is a one-step run without a plan) and adds
`workflow_start`, `workflow_list` (saved ones for a folder, and the runs: running, waiting, ended),
`workflow_status` (a run in full: steps, children, HANDOFF paths, events) and `workflow_answer` (go,
retry, skip, stop — a step, or the whole run). The CLI
mirrors them under `agents run`. The server's instructions say how to follow and answer, as above.

## Consequences

- The owner approves a plan once and then sees only questions with buttons, from the desktop or the
  phone; nothing waits on the coordinator to carry a step to the next.
- A run outlives the session that started it; a pending request waits for any session with the server.
- The coordinator's context grows with events, not with the children's work: a HANDOFF is read by the
  next step, not by the coordinator.
- Two stages: first the events, `Monitor` and native questions over today's children (the fix the owner
  feels most), then the runner, the plan and the HANDOFFs, then the saved workflows.
- What stays open: a console page for the runs (with the widgets, in 1.1); runs across machines (with
  the relay, issue #11); a budget per run.

## Amendment 2026-10-14 — isolated by project, then by coordinator session

The hub is shared by every coordinator on the machine, and each saw (and could answer) the others'
children. A child (`meta.json`) and a run (`owner.json`) now records whose it is: its **project** — the
main repository's root of the coordinator's folder, a worktree resolving to the repository it hangs from,
a folder with no repository being itself — and its **coordinator**, a process.

**A coordinator is its `claude` process, not a session id.** `CLAUDE_CODE_SESSION_ID` is inherited by
whatever a session starts, so a session inside another names the wrong one. The MCP server is a stdio
child of the coordinator's `claude`, and the CLI run from its Bash tool has it as an ancestor: both walk
up the process table to the nearest process named `claude*` (`coordinatorFrom`, `shared/mcp/lib/proc.ts`),
and the identity is its pid plus its start time (a pid alone is reused). The
session id, when the environment has one, is only a note on the record. A caller under no `claude` (a
plain terminal) has no coordinator: the person is the coordinator of the project's children.

|                                                                                   | own | orphan of the project             | other live session, same project         | other project                    |
| --------------------------------------------------------------------------------- | --- | --------------------------------- | ---------------------------------------- | -------------------------------- |
| list, status, events, follow, wait                                                | yes | yes, marked `orphan`              | `--project` (`project: true`), read-only | `--all` (`all: true`), read-only |
| answer, say, stop, `workflow_answer`                                              | yes | no: adopt first                   | never                                    | never                            |
| adopt (`agents agent adopt`, `agent_adopt`; `agents run adopt`, `workflow_adopt`) | —   | yes: the owner becomes the caller | refused: it has a live coordinator       | refused: never across projects   |

An **orphan** is a child or run whose owner process is gone: its pid is not there, or it has another start
time. A child or run recorded before owners (project only, or nothing: then the project of its own
folder) has no coordinator, so it is an orphan of its project. Adopting a run adopts its children; the
runner reads the owner again when it starts a step. Events of an orphan carry `orphan: true`: the
coordinator tells the owner and adopts only when they want it carried on. Pure parts (`accessOf`,
`inScope`, `mayAct`, `mayAdopt`, `projectOf`) are in `shared/mcp/lib/agents.ts`; the process table is read
in `shared/mcp/lib/proc.ts` alone, through `ps` (Deno lets only `--allow-all` read `/proc`, and the server
has `ps`), so the platform layer ports one file. `ps` gives a start time to the second, derived from the boot
time, so two starts within three seconds are the same process.

## Amendment 2026-10-16 — a coordinator in Claude Desktop

The `agents` server is offered to Claude Desktop too (`_surfaces: ["cli", "desktop"]`). Desktop has no Claude
Code session and no folder: it starts each stdio server once, as a child of its main process (through its
`disclaimer` wrapper), in the home folder, for **all** its conversations, and gives it no conversation id —
the MCP connection is the app's, not a chat's. So the rule above holds with the app as the coordinator:

- **The coordinator is the app's main process** (`claude-desktop`, `claude-desktop-<profile>`): the same walk
  up to the nearest `claude*`, pid plus start time, marked `desktop` (`isDesktopApp`, `proc.ts`). Every
  conversation of that app shares its children; a restart of the app makes them orphans, like a closed CLI
  session. Per-conversation isolation is not possible without an id Desktop does not give. The Code tab's
  Claude Code is a `claude` process of its own: a CLI coordinator, with its folder.
- **It has no project** (`Scope.project` is `""`, `folderless`). What it starts takes the project of its own
  folder (a child's; a run's plan folder or first step folder), so a CLI session in that project sees it as a
  peer's, read-only, and adopts it once the app is gone.
- **Its own in any project, the rest read-only.** It acts only on what it started (`own`, wherever); a live
  CLI session's things are `peer`; there is no `other`. By default it lists only its own — every project's
  orphans would bury them (children are never pruned) — and `project: true` or `all: true` lists everything.
  It adopts an orphan of **any** project: "never across projects" keeps a session inside its project, and
  Desktop is in none. Adoption stays outside the auto-allowed tools, so the owner says yes each time.
- **Records no coordinator owns** (routines, account proposals): a session reaches its project's, the app every
  project's, as the console does (`reaches`). It may schedule a routine in any folder; it does not propose a
  project's default account (no project to name).
- **No Monitor in Desktop**: it follows its children with the panel (`agents_panel`, an MCP App Desktop shows),
  or `agent_list` / `agent_status`. The panel is the same resource with the same scope.

Pure parts: `isDesktopApp`, `coordinatorFrom` (`proc.ts`); `folderless`, `reaches`, `accessOf`, `inScope`,
`mayAdopt` (`agents.ts`). The macOS app (`Claude`) is not recognised: only the Linux builds are published.

## Amendment 2026-10-15 — saving, finding and starting a saved workflow

The skill's body carries the plan as its first fenced `json` block, with `{{name}}` placeholders in any
string (`{{folder}}` is the project's folder when one is asked about); the prose around it is for whoever
fills it. Layout unchanged: the project's `.agents/workflows/<name>/SKILL.md` (`.agents/` added to the
repository's exclude, as for HANDOFFs), the owner's `<config>/workflows/<name>/SKILL.md`. Names are lowercase
letters, digits and `-`; the project's wins on a name.

- `workflow_save` validates the plan (`planErrors`) and returns the SKILL.md's path and content; the coordinator
  writes it with its own Write tool, because the hub's server may write only its state (`--allow-write`, which we
  do not widen to the home folder). `agents run save` writes it itself and refuses to overwrite unless told.
  Only when the owner asked for it.
- `workflow_load` (`agents run saved` lists) finds one by name and fills the placeholders, naming any left
  empty. It starts nothing: the owner approves the filled plan, then `workflow_start`. `agents run start
  <name> --var k=v` is the owner's own act in a terminal and starts at once.
- Example: `config.example/workflows/review-and-fix/`, copied by `agents init`.
- Pure parts (`planOfSkill`, `placeholdersOf`, `fillPlan`, `skillText`) in `shared/mcp/lib/runs.ts`.
- A routine's `--workflow` (and `routine_add`'s `workflow` + `vars`) takes a saved workflow by name as well as a
  plan file; the placeholders (and `{{task}}`) are checked when the routine is added, not when it fires.

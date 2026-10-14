# 0009 — Agents Multi 2: one agent you talk to

- Status: accepted (direction; phases A and C are done, the rest not started)
- Date: 2026-10-14

## Context

Agents Multi today is a console with many pages (Today, Tasks, Brain, System, Connections, Setup, Pick, Hey)
around a hub of agents the owner drives from a Claude session. The simplification audit found about 65k lines
for a core of about 10k (hub, brain, vault, tasks, limits), and a console whose pages mostly repeat what
Claude, the brain and the CLI already do.

The same day a research note compared Grok Bot (xAI: chat, routines and triggers, bot-to-bot delegation, a
reviewer agent that approves or blocks) and OpenClaw (open source gateway with chat channels, cron, skills).
What they share is the shape the owner wants: **one agent you talk to**, which works when you are not there.
What they teach us:

- OpenClaw's gateway listened on every interface by default: tens of thousands of exposed instances, a
  one-click RCE (CVE-2026-25253), an auth bypass behind a reverse proxy (loopback trusted), 341 malicious
  skills on its public registry, and prompt injection from an email or a page turning into an action.
- Since 2026-04-04 Anthropic refuses subscription OAuth tokens in third-party harnesses; only Claude Code and
  Claude.ai may use them. Our code must never present a subscription login to an API.

Already done, and the ground this stands on:

- hub isolated by project and coordinator session, with orphan adoption ([ADR 0005](0005-agent-workflows.md));
- MCP servers handed to Claude at launch ([ADR 0006](0006-mcp-at-launch.md));
- Codex as a second provider ([ADR 0007](0007-codex-provider.md));
- the MCP RAM fix and the lazy gateway ([ADR 0008](0008-mcp-gateway.md)).

## Decision

### Product

1. **Simple and chat-first.** The owner talks to **one orchestrator agent**. It takes requests in chat, runs
   **routines** and **triggers**, **delegates** to other agents (children, workflows of ADR 0005, other
   providers) and answers to a **reviewer agent** that approves or blocks actions before they leave.
2. **Most of the console goes away.** Kept: **Chat**, **Runs / agents**, **Accounts & limits** (today's
   "Claude now"). Everything else is behind "More" or removed; a page that only mirrors a CLI command or
   another product goes.
3. The orchestrator is not a new model harness: it is a Claude Code (or Codex) session we start through the
   CLI like any child, with the hub's tools, the brain and the tasks.

### Channels

4. **The console app** (Tauri, ADR 0003) and a **web app (PWA)** on the Agents Multi site, with **push
   notifications**, signed in with the **brain account** (one identity, no second login).
5. **Telegram** is a secondary adapter over the same chat API, not a second product.
6. Every channel talks to the same orchestrator through the same API; a channel holds no logic of its own
   (the rule of ADR 0003: the view shows, the backend decides).

### Where it runs

7. **`agentd`**: a daemon on every machine (the always-on OVH server, the desktop, the laptop). It runs jobs
   locally, reports state and limits, and is the only thing that starts agents on its machine.
8. **Nodes announce themselves** (name, platform, load, which accounts are logged in, whether the owner is
   at it). The orchestrator **proposes where to run a job** ("your desktop is on, I'll run it there";
   "you're leaving, I'll move it to the server"); the owner accepts or not.
9. **A job interrupted by a machine going off resumes elsewhere from its branch**: the unit of work is a
   branch plus a HANDOFF (ADR 0005), never a process. Nothing depends on one machine staying up.

### Providers

10. **Official CLIs only**: Claude Code (`claude -p`) and Codex (`codex exec`). **Never a subscription token
    against the API from our code.** API keys are a different, explicit thing.
11. **Claude first; Codex shipped as the second provider** ([ADR 0007](0007-codex-provider.md)). **Gemini
    only with an API key, later**: its account login stopped serving the CLI in June 2026 (secondary
    sources, to verify before building on it).
12. **Desktop apps** (Claude Desktop, ChatGPT/Codex desktop) are an **optional feature of a profile**, never
    installed or needed on the server. A server profile is CLI-only.

### Accounts

13. **Several paid accounts are legitimate** (for example one per organisation). Each **project has a default
    account**.
14. The orchestrator **proposes** which account a job uses (default, or another for limits or organisation);
    **the owner accepts**. It never switches an organisation's account for a project silently.
15. The web app and the console **show which account the orchestrator is using** for each run.

### Events and limits

16. **Usage windows per account**, read the way the vendors expose them: Claude `five_hour` and `seven_day`
    from the statusline's `rate_limits`; Codex `token_count.rate_limits` from the session logs (ADR 0007).
    Nothing is asked of the vendor on our own with a login (the exception of `apps/cli/live.ts` stays as
    AGENTS.md says).
17. **Limit rules** over those windows, owned by a limits manager, to use the plan fully:
    - "at 80 % stop giving work to this account";
    - "window about to expire with room left → give it queued work, or switch account / provider";
    - "window reset → resume the queued work".
      They are events and decisions of the orchestrator, visible and overridable, not hidden throttling.

### Routines

18. **Time**: cron and at ("do it tonight at 2"). **Events**: limit reset, run done or failed, task due,
    webhook. A routine is a prompt plus a project plus a policy, stored as a file.
19. **Night policy is per repository**. The default: the agent works on **its own branches**, **may commit
    and push to the development branch** (even where that deploys a dev site), **never to main or release**;
    everything else is **queued for the owner**. A repo may tighten this, not loosen it past "never main".

### Distribution

20. **Open source, self-hosted.** Each organisation (Otacon, for example) runs it on its own servers with its
    own accounts. **The author hosts nobody else**: no shared cloud, no multi-tenant service, no one's
    credentials or code on our machines.

### Security

Lessons from OpenClaw, as rules:

21. **Loopback or VPN only.** `agentd` and the chat API bind to `127.0.0.1` or a private network interface,
    never `0.0.0.0` by default; a remote channel reaches them through the VPN or the brain's authenticated
    origin. No trust in "local" behind a proxy: every request carries a credential, as the gateway of
    ADR 0008 does.
22. **No public skill registry.** Skills, workflows and routines are files the owner wrote or read; nothing
    installs from a catalogue by name.
23. **Outward actions are confirmed** (send, publish, deploy, delete, spend), by the owner or by the reviewer
    agent under a rule the owner set. Content from outside (mail, pages, issues, webhooks) is data, never
    instructions.
24. **Claude Code's Bash sandbox is ON by default for headless/server runs and shared profiles**, with
    allow-lists for git, npm and the services a repo uses. It is **not required on the owner's interactive
    profiles** (ADR 0008: it changes how Bash behaves everywhere, so it stays a per-profile choice there).
    Where a job runs unattended it is the boundary that holds; deny rules are only a guard against error.

### Phases

Sizes only. The brain's tasks carry them (label `2.0`).

| Phase | What                                                                                                                           | Size   | After |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | ------ | ----- |
| A     | Hub isolation, MCP at launch, Codex, RAM fix, gateway (done: ADRs 0005–0008)                                                   | —      | —     |
| B     | Platform layer for Mac and Windows: `secretStore`, `spawnDetached`, `listProcesses`, `notify`, `openUrl`                       | medium | —     |
| C     | Provider interface completion (CLI, accounts, headless run, limits, optional desktop, one shape per provider) (done: ADR 0007) | medium | —     |
| D     | Scheduler, run policy and limits manager (routines, night policy, rules of 16–19)                                              | large  | C     |
| E     | UI cut to three views (Chat, Runs, Accounts & limits) and "More"                                                               | medium | —     |
| F     | `agentd` headless on the server, node announcement and job placement, resume from branch                                       | large  | D, B  |
| G     | Web app (PWA, push, brain login) and the Telegram adapter                                                                      | large  | F     |
| H     | Reviewer agent (approve, block, ask)                                                                                           | medium | D     |

E can start any time: it removes, it adds nothing the others need.

## Consequences

- The console shrinks: pages leave with their strings (`apps/ui/src/i18n/`), styles and API routes; the
  doctor keeps only invariants of what stays. Audit §1 lists what is a candidate.
- A second always-on process class (`agentd`) joins the console and the gateway; app mode still needs neither
  systemd nor git (ADR 0003), so a scheduled job is the backend's, and `agentd` on a server is the only place
  a unit file may be the owner's choice.
- Placement and "resume elsewhere" need work in a branch pushed to a remote the nodes share; a job in a
  folder with no remote cannot move.
- The orchestrator is itself an agent with tools: its prompt is the product's most sensitive file. Prompt
  injection through anything it reads is the main risk, which is why 23 and 24 are decisions and not advice.
- Usage reading stays tied to formats the vendors may change (the statusline `rate_limits`, Codex's session
  logs): each has a doctor check and a fallback of "unknown", never a guess.
- The relay of ADR 0005 / task #11 (MCP between machines) is absorbed by `agentd` nodes; it is not built
  separately.
- Not decided here: the chat API's shape, how the PWA's push is delivered on a self-hosted brain, the
  reviewer's rule language, the nodes' trust model beyond "same owner, private network". Each is an ADR of its
  phase.

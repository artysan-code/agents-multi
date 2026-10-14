# 0008 — A lazy gateway for the stdio MCP servers

- Status: accepted
- Date: 2026-10-14

## Context

[ADR 0006](0006-mcp-at-launch.md) hands each session its MCP servers at launch, and Claude Code starts every
one of them, used or not: with fourteen sessions of three profiles the measurement of 2026-10-14 was 7.5 GB
of server processes, most of them copies (n8n-mcp 145 MB each, the in-house Deno servers 34 MB each, supabase
56 MB), and two thirds of the servers of a session are never called in it. Dropping `npx` and the launch
wrapper (`perf/mcp-ram`) took out the parents; what is left is one full copy per session per server.

Spikes (Claude Code 2.1.299) settled what a design may rely on:

- an `http` server whose `tools/list` is answered from a cache is `connected` at `init` with nothing started
  behind it, and the first `tools/call` is the only moment the backend is needed;
- a stateless Streamable HTTP endpoint (no session ids, one MCP server object per request) is enough: `GET`
  answered with 405 is tolerated;
- a gateway that is killed and started again is picked up by a session's next tool call, with no action;
- `headersHelper` runs on every connection, as a child of Claude with its environment, so the token can stay in
  a file and never in `mcp.json` or an argument;
- a stdio child is not multi-client (a second `initialize` is refused, JSON-RPC ids collide), so sharing one
  needs a process that owns the child — the gateway is that process.

## Decision

- **One gateway process per machine** (`shared/mcp/gateway/server.ts`, Deno, TypeScript like the other servers,
  with its own lock file), on `127.0.0.1:7332` (`port`), Streamable HTTP. It is a process of its own, not a
  thread of the console: the console (`console/gateway.ts`) starts it, probes `/health` every five seconds,
  restarts it when it dies (backing off when it keeps failing), replaces one that runs older code, stops it
  when the setting turns it off, and a new console takes the running one over. No systemd (ADR 0003).
- **One path per (profile, server)**: `/p/<profile>/<server>`. In the launch config each server that goes through
  it stays a separate entry **under its current name**, now `type: http` with that URL, so tool names and the
  `_allow`/`_ask`/`_deny` rules in `placement.ts` and `shared/settings.json` are untouched.
- **Auth**: a random token per profile in `<runtime>/<profile>/mcp-token` (0600), sent as `Authorization: Bearer`
  by `headersHelper` (`headers.sh`, bash: reads the file, prints JSON). The gateway maps token → profile and
  answers 403 on another profile's path. Host and Origin are checked (DNS rebinding). `/health` answers
  `{gateway: true}` to anyone and nothing else; `/status` (running backends) wants a token. The gateway's
  own state (`state.json`: pid, code) and `children.json` are files in its folder, not an HTTP answer.
- **`_deny` is enforced in the gateway**: a tool in the server's `_deny` is neither listed nor forwarded,
  whoever asks and whatever the client's permission rules say. This is the defence that holds against a
  caller that did not come through Claude's permission system (see _What protects what_).
- **Backends are the existing stdio entries**, exactly as the plain launch config would start them (our Deno
  servers through their own flags, the vault's secrets through `launch.sh` as in `perf/mcp-ram`, the pinned
  third-party packages with `node`). The CLI writes them, with each entry's cache key, into
  `<runtime>/gateway/backends.json` with the launch config; the gateway reads it again when it changes. A
  request can only name a server of that file: nothing a client sends becomes a command.
- **Lazy and shared**: a backend starts on the first `tools/call` (or on a `tools/list` with no cache), is one
  process per (profile, server/account) however many sessions use it, and stops when nothing has been in
  flight for `idleMinutes` (10). Calls wait up to ten minutes, abort with the client, and a backend that exits
  is started again by the next call.
- **Cache**: `tools/list` and the server's `instructions` come from `<runtime>/gateway/cache/<name>-<key>.json`,
  where the key hashes the server's name, command, arguments and environment (so n8n's `DISABLED_TOOLS` and
  supabase's `--features` count) and the version of what runs: the npm package's, or the code's fingerprint
  for ours: the server's own folder and `shared/mcp/lib`, nothing of the console or the page. The first real
  start fills it (written atomically; a damaged file is no cache); `agents mcp warm` fills it now and removes
  lists nothing names, `--force` rebuilds them all (for a server of one's own whose code changed outside the
  repository).
- **Process**: the gateway logs to `<runtime>/gateway/gateway.log` (one rotation at 1 MB) and holds none of the
  console's pipes. Its own fingerprint is its code plus `lib/fs.ts`, so a console update that leaves it
  alone leaves it running; when it must stop it finishes the calls in flight first (up to a minute). It keeps
  the pid and start time of every backend it starts in `children.json`: a gateway that was killed hard
  (SIGKILL) and whose backends did not notice their stdin closing is followed, at the next start, by the
  stopping of those it left. A `tools/list` that cannot start its backend is an error of that session
  (the server shows as failed and is tried again), never an empty list it would keep. An entry replaced
  while its backend is starting or working is retired: the calls in flight end on the old one, which stops
  after them, and new calls go to the new one. A backend's environment is the gateway's without any Claude
  session variable (`CLAUDE_CONFIG_DIR` included: the profile is the entry's `AGENTS_MULTI_PROFILE`, never
  inherited) and its working folder is the home.
- **Stays stdio**: the `agents` hub (`_gateway: false`: it needs its session's folder and identity), servers with
  `_bind` (launch.ts reads the project binding from the session's folder), remote `http` servers, and Desktop's
  chat file (`claude_desktop_config.json`: commands only). The Code tab's Claude is Claude Code and reads the
  profile's `.claude.json`: that projection (ADR 0006) holds the launch config's entries, so the same http
  entries as `mcp.json` (checked with the Claude Code bundled in Desktop, 2.1.295: `type: http` and
  `headersHelper` work from `.claude.json`), stdio for the two cases above, and all of it stdio when the gateway
  is off. Without that each Code-tab session started its own copy of every server (about 0.7 GB).
- **Kill switch and default**: `<config>/gateway.json` — `enabled` (default: on in app mode, where the console is
  always up; off in dev mode), `idleMinutes`, `port`. Off, the launch config is regenerated with the plain
  stdio entries.
- **Doctor**: gateway alive and on current code, `backends.json` in step, a cached list per server, tokens
  present and private, and — in each profile's _generated_ `settings.json`, not the repository's base — the
  deny rules for the port in use, and that every URL in its `mcp.json` names that port. The console gets no
  page for it now.

## What protects what

Honestly, in order of strength:

- **Real boundaries**: the loopback-only listener with per-profile tokens and Host/Origin checks (against other
  processes, pages and profiles); `_deny` enforced inside the gateway; each backend's own Deno flags; and,
  where it is turned on, **Claude Code's sandbox**. Tested here (`claude -p`, `sandbox.enabled` with
  `sandbox.filesystem.denyRead` on a token file, bubblewrap): a Bash command cannot read that file, and
  `curl http://127.0.0.1:<port>/health` from it is refused although the gateway is up (the same command
  without the sandbox answers 200). That covers what Bash starts; the Read and Edit tools are covered by
  permission rules, and `excludedCommands` or an approved escape from the sandbox reopens it. It is **not
  turned on by default**: it changes how Bash behaves in every project (Docker, git, network), which is a
  decision for the person, per profile. For a profile that handles untrusted input it is the setting to
  choose.
- **Barriers against error, not against an agent that means to get round them**: the deny rules the
  settings generation adds while the gateway is on, from the port actually used (`Bash(*:<port>*)`,
  `Bash(*/dev/tcp*)`, the token files under `~/.agents-multi` and `~/.claude-multi`, `Bash(*mcp-t*)`,
  `Bash(*headers.sh*)`). A program that builds the address at run time, a variable port, a glob such as
  `mcp-t[o]ken` or a script written to a file defeats them. They stop a session from doing it by accident or
  on an injected prompt that has not thought of them.
- **What the gateway cannot enforce**: `_ask` and `_guard`. Claude's permission system asks the person before a
  tool call; the gateway never learns whether it did. A caller that reaches the gateway by hand — which only an
  agent defeating the barriers above can do — skips the question that `gmail_send` or `n8n_update_*` would
  have raised, which a stdio server could not be made to skip. Only the sandbox closes that.
- **`headers.sh` is not guarded**: it prints the token on purpose (Claude runs it for every connection).
  Refusing when stdout is a terminal, or when the parent is not Claude, was considered and not done: the Bash
  tool's commands are children of the same Claude and write to a pipe like the helper does, so the check
  would only look like protection.

## Consequences

- **RAM** (sandbox, four sessions of one profile, tasks + n8n-mcp): 8 backend processes and 1.16 GB with a call
  in each session, 1.41 GB with none called, against the gateway's 76 MB plus the two shared backends
  (about 370 MB) after the calls, and the gateway's 76 MB alone when no session calls anything. The cost no
  longer grows with the sessions; it grows with the servers actually used.
- A call to a server that is not running pays its start (60 ms for a Deno server, 200–300 ms for n8n-mcp, more
  with a vault lookup) once per idle period.
- **A new single point of failure**: with the gateway down, every session's gateway servers fail until it is
  back (seconds, the console restarts it); a session reconnects on its next call. A hung backend is shared by
  the sessions that use it.
- The gateway's own sandbox is wide on purpose: it runs any command of the registry and hands it the
  environment, so `--allow-run` and `--allow-env` are open; it listens on loopback only, writes only its own
  folder, and each backend keeps the flags of its own entry. A backend's environment is the gateway's, not the
  session's (a variable set only in one terminal does not reach it).
- Only tools are served: a server's resources, prompts and sampling are not forwarded (none of ours uses
  them), progress notifications are not relayed, and a tool list changes only with a version or a start
  command.
- A single local user is assumed: a process of another user that opens the port before the gateway starts
  would receive tokens, and nothing here defends against it (the supervisor trusts what answers `/health`); on a
  machine shared with others, use the sandbox or a Unix socket when Claude Code supports one.
- Not done here: supabase (it has `_bind`) keeps one copy per session; making it lazy by binding is the next
  step if its 56 MB matters.

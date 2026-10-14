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
  answers 403 on another profile's path. Host and Origin are checked (DNS rebinding). The shared deny rules
  keep a session's Bash from `curl`ing the port and from reading the file: a call made by hand would skip
  the `ask` and `deny` rules the permission system applies to tools.
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
  for ours. The first real start fills it; `agents mcp warm` fills it now and removes lists nothing names.
- **Stays stdio**: the `agents` hub (`_gateway: false`: it needs its session's folder and identity), servers with
  `_bind` (launch.ts reads the project binding from the session's folder), remote `http` servers, and everything
  Desktop reads — its own config file and the `.claude.json` projection for its Code tab are still built from
  `wanted()`, untouched.
- **Kill switch and default**: `<config>/gateway.json` — `enabled` (default: on in app mode, where the console is
  always up; off in dev mode), `idleMinutes`, `port`. Off, the launch config is regenerated with the plain
  stdio entries.
- **Doctor**: gateway alive and on current code, `backends.json` in step, a cached list per server, tokens
  present and private, the deny rules present. The console gets no page for it now.

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
- `codeVersion` now fingerprints all of `shared/mcp`, so a change to a server's code restarts the console's
  pages and the gateway, and makes the cache key of our servers another one.
- Not done here: supabase (it has `_bind`) keeps one copy per session; making it lazy by binding is the next
  step if its 56 MB matters.

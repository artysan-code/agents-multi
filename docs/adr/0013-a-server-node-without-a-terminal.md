# 0013 — A server node without a terminal: shared configuration, Claude's tokens in the vault, pairing

- Status: accepted 2026-10-15; part B built (amends [ADR 0012](0012-agentd-and-the-service.md), «The server node»)
- Date: 2026-10-15

## Context

The first server node (atlas, 1.2.1-rc.1) works, but setting it up took an evening of SSH and `docker exec`.
What the owner had to do by hand, in the container's terminal:

- `agents init` made a **configuration of its own**, empty: no profiles but `personal`, no accounts but the
  brain's (added by hand), so the node had two MCP servers where the owner's machines have ten, and the doctor
  asked to adopt settings nobody had chosen there;
- `agents vault pair --file` with the recovery code typed in;
- `agents node login --no-browser` with a callback address copied out of a browser and pasted back;
- `claude` → `/login` **once per account**, in the container (three accounts, three browser round trips);
- a git key made, its public half added to the forge, the clones made one by one;
- `agents node enable --headless`, then a restart.

Every new server, and every new Claude account, means doing it again. Three faults showed on the way:

- **`node.json` is in the configuration**, which Syncthing carries to every machine: `agents node enable` on one
  turned the others on, and `--headless` on a server would have reached the desktops (whose children would
  then run in a sandbox they were not set up for).
- **A node's MCP logins**: the servers whose credentials are in the vault need none, but only for the accounts
  the node's `accounts.json` lists — the empty configuration listed none.
- **Coolify** ignores a variable in a volume's source (fixed in 1.2.1: `apps/node/vault-volume.sh`).

The owner chose (2026-10-15) to do it in two steps: first a guided command in the container, with Claude's
tokens in the vault and the configuration shared; then, in F2, pairing from the console with no terminal at all.

## Decision

### The owner's configuration reaches the server, read only

- The configuration (`profiles/`, `accounts.json`, `settings.json`, `servers.json`, `rules/`, `owner.json`,
  `reviewer.json`, …) is the owner's, the same on every machine: a server node **mounts it read only**, as it
  mounts the vault. Its profiles, accounts and MCP servers are then the owner's, without a second copy to keep.
- To be given to a server alone, it becomes **a Syncthing folder of its own**, `~/agents-multi-config`, like
  the vault in 1.2.1: `agents config move` copies it there from wherever `agents init` put it (the old place is
  read until then), and the link `~/.agents-multi/config` points at it. The server's Syncthing receives it as a
  trusted device, receive only; the node's compose mounts it at `~/agents-multi-config` (`node-config`, made a
  bind with the same script as the vault's, generalised: `apps/node/bind-volume.sh`).
- Nothing in it is secret (accounts carry names and addresses; secrets are in the vault), but it is the owner's
  rules and profiles: it goes only to a server the owner already trusts with the vault.
- A headless node does not write there: the doctor's settings adoption, `agents init` and anything else that
  writes the configuration skip a read-only one and say so.

### What is a machine's stays on the machine

- `node.json` splits in two:
  - **`config/nodes.json`**, the owner's, the same everywhere: `allowedDomains`, `repoRoots`, `approvalKey`
    (and the repositories a server clones, below);
  - **`<state>/node.json`**, this machine's, never synced: `enabled`, `headless`, `maxSessions`, `name`.
- Migration: the first run that finds the old `config/node.json` (the CLI or the console: an MCP server reads
  it as it is) takes the shared fields into `nodes.json`, and the machine's fields into its own state file **only
  when the configuration is in no Syncthing folder** (no `.stfolder` above it): there it was this machine's
  alone. In a synced configuration it was every machine's, so none keeps it, and each is turned on again with
  `agents node enable` where it should be. The old file is then removed.
- `agents serve --headless` keeps refusing to start unless this machine's file says `headless`.

### Claude on a server: a long-lived token per account, in the vault

- Claude Code makes a **long-lived token** for a subscription account with `claude setup-token` (one browser
  round trip, on any machine). `agents node token <profile>` runs it with that profile's launcher on the
  owner's desktop and stores the token in the vault (`claude/<profile>`, field `oauth-token`): one click per
  account, once a year, and every server the owner gives the vault to has it.
- **agentd hands it only to its own children**, in the environment the launcher starts them with
  (`CLAUDE_CODE_OAUTH_TOKEN`), on a headless node and only there. A desktop keeps its `/login`. The node then
  announces an account as one it can run when its profile has a login file **or** a token in the vault.
- Rejected: copying a desktop's `.credentials.json` (its refresh token rotates: the desktop and the server would
  log each other out); `/login` in the container (one terminal round trip per account per server, today's pain).
- **What the token can reach** is the open question of this ADR, below.

### The guided command

`agents node setup`, run once in the container's terminal, does the rest in order and says what it waits for:

1. links the mounted configuration (no `agents init`); refuses to go on without it or without the vault;
2. `vault pair --file`: asks for the recovery code;
3. `node login --no-browser`: prints the link, takes the address back;
4. checks that every account the node should run has its token in the vault, and names the missing ones
   (`agents node token <profile>` on the owner's desktop);
5. the git key: makes it if there is none, prints its public half, waits until the forge takes it
   (`git ls-remote` on the first repository);
6. clones the repositories `nodes.json` lists for servers (`repos`), under `repoRoots`;
7. `node enable --headless`, and starts serving without a restart (the entrypoint waits on the state file).

Running it again repeats only what is missing. The README's step 5 becomes this command.

### F2: pairing from the console

The same steps with no terminal, so that a new server is one code typed in a page:

- the container, unconfigured, makes a key pair and shows a **pairing code** in its log (and on the node's
  status page, when phase G gives it one);
- on the owner's machine, the console's _Nodes › Add a server_ takes the code: the service, which saw the node
  ask with that code, **mints the node's token** for it (no callback to paste), and the console **seals the vault
  key to the node's public key** and hands it over through the service, which cannot open it;
- the configuration and the vault arrive by Syncthing as above; Claude's tokens are already in the vault; the
  git key's public half comes back to the page, to add to the forge.

Its shape (the pairing request, its expiry, what the service may see) is written when F2 starts.

### The token inside a child

What Claude Code documents (code.claude.com/docs, read 2026-10-15: _Authentication_, _Environment variables_,
_Legal and compliance_):

- `claude setup-token` makes **a one-year OAuth token** for the subscription; it is not saved anywhere, and is
  used through `CLAUDE_CODE_OAUTH_TOKEN`. It **can only make model requests**: no Remote Control, and **no
  claude.ai connectors** (Gmail, Drive… through the account); MCP servers configured locally still work. On a
  server that is what the vault already gives: the node's MCP servers are the configuration's, never the
  account's connectors.
- **Precedence**: the token outranks a `/login` (`.credentials.json`), but `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper` and the cloud providers' variables outrank the token, and `--bare`
  ignores it. agentd therefore starts a headless child **without** those variables (and never with `--bare`),
  and the doctor's `node.claude` fails on a node whose environment sets one.
- **The scrub**: with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, Claude Code removes credentials from the environment
  of what it starts — Bash commands, hooks, stdio MCP servers — and keeps them for its own requests (it also
  puts Bash in a PID namespace of its own on Linux). Credentials are recognised by name or value; the token
  is not named in the documented table. So: **every headless child gets the scrub on**, and agentd's probe
  checks it for real, at start and every hour with the sandbox's (`agents node probe`): Claude Code started as a
  child is, with a throwaway token, the scrub, a credential canary (`NPM_TOKEN`) and a plain variable, runs a
  SessionStart hook that counts what it sees; the hook runs before any request, so the probe spends nothing (the
  request is refused: the token is not real). The node takes no job unless the hook saw the plain variable and
  neither the token nor the canary. Failing closed, as the sandbox does. Measured on Claude Code 2.1.300: the
  token never reaches a hook, even without the scrub; the scrub removes the canary. The Bash tool goes through
  the same scrub, but checking it needs a model request: done once by hand on the first real token.
- **Where it runs**: Claude Code leaves files where it starts (empty `.env*` and `package.json` were found in the
  folder of the first manual probe); the probe runs in its own temporary folder, removed after.
- **Other ways out**: the children's MCP servers are the gateway's (HTTP), started by agentd without the token;
  the sandbox denies reads of the vault folder, the vault key file and the node token; sandboxed commands reach
  only `allowedDomains`; only agentd pushes. What remains is the child's own Read and Edit tools, held by deny
  rules on those paths (ADR 0012, «Not covered»), and the token living in agentd's memory.
- **Use**: the Authentication page gives setup-token for "CI pipelines, scripts, or other environments where
  interactive browser login isn't available"; the Legal page reserves subscription OAuth for the purchaser's
  ordinary use of Claude Code and native applications, and says products and other people's use go through an
  API key. A node runs the owner's own work with the official CLI: that is the first case. An organisation that
  serves other people from its nodes uses API keys (ADR 0009, «only official CLIs»).
- **How a child gets it**: the start script clears every `CLAUDE_CODE_*` it inherited (a Claude session's), so
  the token and the scrub are handed to it under names of ours, kept as shell variables (the holder process it
  starts does not inherit them) and exported just before Claude runs, with `ANTHROPIC_API_KEY` and
  `ANTHROPIC_AUTH_TOKEN` removed.
- **Not documented, to measure on the first token**: whether the status line's `rate_limits` and `/usage` read
  a token's limits as they read a `/login`'s (the limits manager of ADR 0010 depends on it); how many tokens one
  account may hold and how one is revoked (the docs say only: make a new one and restart).

## Consequences

- One server is set up by one command (then by one code in F2); a second server, or a new account, costs no
  terminal session on the others.
- The owner's configuration moves once more (`agents config move`), as the vault did.
- Whoever has a server has the owner's configuration, the vault and a year's token of each account: the same
  trust the vault already asked for, now stated for Claude's accounts too.

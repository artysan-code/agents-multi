# 0014 — From the phone: the web app on the service, the orchestrator on a paired machine

- Status: accepted 2026-10-15; G1–G3 in progress
- Date: 2026-10-15
- Phase G of [ADR 0009](0009-agents-multi-2.md); changes its point 20

## Context

What exists after phases A–F is the plumbing: profiles, the vault, the MCP gateway, the hub with workflows,
routines, limits and the reviewer, the service (the brain) with accounts, memory, tasks, machine tokens, nodes
and jobs, and `agentd` on desktops and servers ([ADR 0012](0012-agentd-and-the-service.md),
[0013](0013-a-server-node-without-a-terminal.md)). What the owner wants to use is not there: **open the phone,
talk to the agent, get the answer and a notification**. The only face today is the desktop console, and setting
up anything beyond one desktop asks for Syncthing, a keyring, Docker volumes and terminal sessions.

The owner chose (2026-10-15) **a minimal path end to end**: build only what lies on phone → web app → chat →
orchestrator on a machine → answer and push, finish the open work on the way, and make the result simple
enough to host for other people:

- the service, with the web app, **may be hosted by the author for others**, and anyone may self-host it from
  the repository (over ADR 0009 point 20, "the author hosts nobody else");
- **each person's Claude is theirs**: they run it where they choose — their desktop, their own server, a server
  they put it on — with their own subscription or key. Agents Multi does not decide that for them.

## Decision

### The shape

```
phone (web app, PWA) ──HTTPS──▶ the service ◀──HTTPS, outbound── agentd on the person's machine
   chat, tasks, brain,             accounts, memory, tasks,           the orchestrator: Claude Code
   approvals, push                 chats, nodes, jobs, push           (claude -p, resumed), the hub
```

- **The service does not run agents.** It keeps the account's data and relays: a chat turn written on the phone
  waits in the account's database until the machine that answers for that account takes it. Where Claude runs
  is the person's machine, paired with their account; the service never holds a Claude login or a vault key.
  This is what lets one service host many people: none of their code, credentials or agents are on it.
- **The orchestrator is the console's chat** (`apps/cli/ask.ts`, `chats.ts`) moved behind the service: one
  Claude Code session per chat, resumed turn after turn, with the tasks, the brain and the hub's tools, under
  `--permission-mode dontAsk` and a fixed tool list as today. The console's Chat page and Hey go through the same
  path, so a chat is the same on the desktop and on the phone.

### The chat path

- **Phone → service**: `POST /api/chats/<id>/turns` with the account's web session; the turn is stored
  (`chat_turns`: id, chat, text, state, node, created) and its state is `waiting`.
- **Service → machine**: the answering node holds one long poll open to the service (`GET /api/node/turns`,
  its node token, outbound only as every node call): it gets the waiting turns of its account, claims one, runs
  it, and posts the answer back in pieces (`POST /api/turns/<id>/events`) and at the end (`…/done`, with the acts
  of `chats.ts`). A node silent for 90 s loses its claimed turns back to `waiting`.
- **Service → phone**: the web app follows its chat on Server-Sent Events (`GET /api/chats/<id>/events`), the
  same streaming the console's page has today; when the app is closed, a push says the answer is there.
- **Which machine answers**: the account names one (`orchestrator` in its settings: a node), chosen in the web
  app among its online nodes; when it is offline, the next online one by the order the owner set, and the
  answer says where it ran. A turn never runs on a node the account did not pair.

### Trust: what a chat turn may do

- A turn comes from the owner's web session, not signed by a key of theirs: whoever has the service (or a
  stolen session) could write turns. So **a chat never starts work on a machine by itself**: the orchestrator's
  tools are the fixed list (read and keep tasks and brain, read the calendar and mail as today, propose jobs and
  routines), and **every job, routine or outward action it proposes still needs the signed yes of ADR 0012** or
  the reviewer's rule of [ADR 0011](0011-reviewer.md). On a desktop that yes is the console's; on the phone it
  is a passkey (WebAuthn) of the account, registered on the phone, whose public key the nodes pin like the
  owner's approval key. Until passkeys land, the phone shows what waits and the yes is given on a desktop.
- The web session: the existing sign-in (passphrase and TOTP, `brain_session` cookie, `HttpOnly`, `Lax`),
  30 days on a device the owner marks as theirs, with the list of sessions on `/account` to revoke one.

### The web app

- **Where**: served by the service at `/app` (its own origin, so the session cookie is the same as `/account`
  and `/board`), installable as a PWA (manifest, service worker for the shell and push only; no offline data).
- **What, and nothing else**: Chat (the list by day, a conversation, streaming answers with the changes made);
  Tasks (today with times, overdue, done); Brain (search, read); What waits (jobs and requests to accept or
  decline, with the passkey); Machines (the paired nodes, which one answers, pair a new one).
- **Code**: the console's UI (`apps/ui`, Preact) gets a second entry for the web app; Chat, Tasks and Brain are
  the same components, talking to the service's API instead of the console's. Built into the service's image.

### Push

- **Web Push** with VAPID keys the service makes on first start and keeps in its data folder; a device's
  subscription is stored per account. Sent: an answer ready, something waiting for a yes, a run failed. One
  notification per event, as `desktopNotify()` does. On iOS a PWA receives push once added to the home screen
  (16.4 and later): the web app says so when it is opened in Safari.

### Pairing a machine with a code

- On the machine, `agents node pair` (and a button in the console) asks the service for a pairing and shows a
  short code (8 characters, 10 minutes, one use). In the web app, _Machines › Pair_ takes the code: the service
  makes the node's token for that machine and hands it over on the machine's next poll. No callback address to
  paste, no SSH for this step. It replaces `agents node login` everywhere (kept for scripts).
- The rest of a server's setup stays as ADR 0013 (`agents node setup`); moving the vault and the configuration
  through the service, sealed to the node's key, is the next step after this ADR, not part of it.

### Hosting for others

- **The hosted service** is the same image: an account per person (invitation from `brain-admin create`, as
  today), each with its own database. It holds their memory, tasks, chats and the list of their machines — so
  their chats pass through it and are kept there, which the sign-up page says plainly. It holds no Claude
  login, no vault key, no code.
- **Each person** installs Agents Multi on a machine of theirs (the desktop app, or the node image on a server
  of theirs), pairs it with a code, and talks from the phone. Their Claude is theirs to use as they choose.
- **Self-hosting** is the repository's README and `apps/brain/compose.yaml`, unchanged: one compose file.

## The API (G1–G3)

Every route runs as the account its web session or token gives (tenants.ts): a person's chats are in their own
database. `node` is the machine whose token it is (fleet.ts), null for a web session.

- **Chats** (any caller of the account):
  - `GET /api/chats` → `{chats: [{id, title, updated, node}]}`, newest first
  - `GET /api/chats/<id>` → `{chat: {id, title, turns: [{id, q, a, acts, state, node, error, created, ended}]}}`
  - `POST /api/chats` `{text, chat?}` → `{chat, turn}` (both objects, as `GET` gives them): a new turn, in a new
    chat when `chat` is absent; a chat's turns run one at a time
  - `DELETE /api/chats/<id>` → `{ok}`
  - `GET /api/chats/<id>/events` → Server-Sent Events: `turn` `{turn, state, node, error?}` (waiting, running,
    done, failed), `text` `{turn, d}` (a piece of the answer), `act` `{turn, k, n, d?}` (a change Claude made, as
    chats.ts's `Act`), `done` `{turn, a, code?}`; a failed turn ends with `turn` (state `failed`, its error) and
    no `done`; a comment every 20 s keeps it open.
- **The answering node** (its own token only):
  - `GET /api/node/turns?wait=25&max=1` → `{turns: [{id, chat, text, session, history}]}`: at most `max` (1 by
    default) waiting turns this node answers for the account, **claimed** by the call (state `running`); it waits
    up to `wait` seconds when there are none. A node asks for as many as it starts at once. `session` is the Claude session to resume when the chat's last turn ran on this node, else null,
    and `history` the chat's last turns (`[{q, a}]`, at most 10) for a node that has no session of it.
  - `POST /api/turns/<id>/events` `{events: [{t: "text", d} | {t: "tool", k, n, d?} | {t: "session", id}]}` →
    `{ok}`: what the answer has so far, relayed to the chat's event streams.
  - `POST /api/turns/<id>/done` `{text, code?, error?}` → `{ok}`: the turn ends (`failed` with an error).
  - A turn claimed by a node silent for 90 s goes back to `waiting` and restarts from the top: a running node
    posts `{events: []}` every 30 s when it has nothing else to say.
- **Which node answers**: `GET /api/settings/orchestrator` → `{node, order}`, `PUT` with the same: `node` the
  account's chosen one, `order` the fallbacks; with none set, the first online headless node, else the first
  online one.
- **Push** (G3): `GET /api/push/key` → `{key}` (the VAPID public key); `POST /api/push/subscriptions`
  `{endpoint, keys: {p256dh, auth}, device}` → `{ok}`; `DELETE /api/push/subscriptions` `{endpoint}` → `{ok}`.
  Sent on a turn done or failed (the chat's title and the answer's first line), as Web Push (RFC 8030, 8291,
  8292).
- **The web app**: `/app` and below, its built files; anything else under it is `index.html` (the app routes by
  hash). Not signed in, it sends the person to the sign-in page with `next=/app`.

## What is paused

F2 (the `node` token scope, the coordinator's MCP tools for nodes, presence) and Telegram wait until this path
works; each is taken up only if the path shows it is needed.

## Slices

| Slice | What                                                                                                   | Size   |
| ----- | ------------------------------------------------------------------------------------------------------ | ------ |
| G1    | Chat turns in the service (routes, SSE), the node's turn loop over ask.ts's runner                     | medium |
| G2    | The web app at `/app`: sign-in, Chat, Tasks, Brain, Machines; PWA shell                                | medium |
| G3    | Web Push: VAPID keys, subscriptions, the three events                                                  | small  |
| G4    | Pairing by code (`agents node pair`, the console's button, _Machines › Pair_)                          | small  |
| G5    | What waits on the phone: jobs and requests, the passkey yes (WebAuthn, the nodes pin its key)          | medium |
| G6    | Hosting for others: the sign-up and privacy text, onboarding in the docs (EN, IT), the hosted instance | small  |

G1 → G2 → G3 make the path; G4 makes it simple; G5 makes it whole; G6 opens it. The console's own Chat page
moves onto the service's chats right after G3, once the path is proven (until then it keeps its local chats).

## Consequences

- The service becomes the meeting point of the phone and the machines, as it already is of the machines; when it
  is down, nothing reaches the phone, and the machines keep running their own routines.
- The console's chat changes underneath: its turns go through the service when the account has one, and stay
  local when it has none (a console with no service keeps working as today).
- A chat's text is stored by the service: on a hosted instance, by the host. Chat history is the person's, and
  `brain-admin delete` removes it with the rest.
- The passkey becomes a second key that can say yes; the nodes pin both, and losing the phone means revoking
  its key on `/account`.

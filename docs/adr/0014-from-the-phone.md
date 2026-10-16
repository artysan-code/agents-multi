# 0014 — From the phone: the web app on the service, the orchestrator on a paired machine

- Status: accepted 2026-10-15; G1–G7 built (1.2.1-rc.x), second and third rounds built (2026-10-16)
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
  owner's approval key. A passkey counts only once a desktop with the vault has endorsed it (G5, below).
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

## The API (G4, G5, G1b)

### Pairing a machine (G4)

- The machine, with no credential: `POST /api/pair` `{name, platform}` → `{code, pairing, expires}`. `code` is eight
  characters (Crockford base32, shown `XXXX-XXXX`), one use, 10 minutes; `pairing` is a 32-byte secret only the
  machine holds. It then polls `GET /api/pair/<pairing>` → `{state: "waiting"}` until `{state: "done", token,
  url}`: the node's own token (the same kind `agents node login` makes, named after `name`), given once.
- The person, signed in: `POST /api/pair/claim` `{code}` → `{node}`. Five wrong codes in a row lock claiming for
  that account for 15 minutes; an unknown or expired code says so.
- On the machine: `agents node pair` (and the console's _Nodes › Pair with a code_) shows the code, waits, keeps
  the token where `agents node login` keeps it, and turns the node on. `agents node login` stays for scripts.

### What waits, and the phone's yes (G5)

- **The node relays what waits on it**: `PUT /api/node/requests` `{requests: [{id, child, request, profile,
  project, kind: "request" | "question", what, questions?}]}` replaces that node's list (sent when it changes, and
  with each announce); `id` is `<child>/<request>`.
- **The phone reads it**: `GET /api/waiting` → `{requests: [{…, node}], jobs: [{…the proposed jobs of fleet.ts}]}`.
- **A passkey says yes.** The phone registers one: `POST /api/passkeys/options` → WebAuthn creation options;
  `POST /api/passkeys` `{name, credential}` (attestation `none`, ES256 only) → `{id, state: "pending"}`. A passkey
  counts only once a machine with the vault **endorses** it: `agents passkeys` (and the console's _Connections ›
  Passkeys_) lists the pending ones, shows name and fingerprint, and on the owner's yes signs `agents-multi passkey
  v1\n<id>\n<public key>` with the approval key of ADR 0012 → `POST /api/passkeys/<id>/endorse` `{signature}`. `GET
  /api/passkeys` → `[{id, name, publicKey, endorsement, created}]`; `DELETE /api/passkeys/<id>` revokes. So the
  service can show a passkey but never make one count: the nodes check the endorsement with the owner's key.
- **An answer from the phone**: `POST /api/waiting/<id>` `{verdict: "allow" | "session" | "deny", answers?,
  expires, assertion: {credential, authenticatorData, clientDataJSON, signature}}`, where the WebAuthn challenge is
  `SHA-256("agents-multi answer v1\n" + canonical JSON of {id, node, verdict, answers, expires})` and `expires` is
  at most 10 minutes ahead. A job is accepted the same way (`POST /api/jobs/<id>` `{op: "accept", assertion,
  expires}`, challenge over `agents-multi job v1` and the job's canonical text), beside the desktop's Ed25519
  signature.
- **The node checks it, not the service**: `GET /api/node/answers` → `{answers: [...]}` (also in the announce's
  reply); for each, the node verifies the passkey's endorsement with the owner's approval key, then the assertion
  (the challenge recomputed from the answer, `type` `webauthn.get`, the origin is the service's, `rpIdHash`, the
  user-present and user-verified flags, ES256 over `authenticatorData || SHA-256(clientDataJSON)`), that it is not
  expired and not used before; only then does it answer the hub (`answer()` of agents.ts). A refused answer is
  reported back with why. A deny needs the same signature: nobody but the owner stops their agents either.

### The console's chat on the service (G1b)

- With a brain account, the console's Chat lists and opens the service's chats (`GET /api/chats`, its machine
  token), and a question becomes a turn: `POST /api/chats` `{text, chat?, node}`, where `node` pins the turn to this
  machine (any token of the account may pin; the phone may pin too). The console relays the chat's events to its
  page as the NDJSON it streams today, so the page changes little; the conversation is the same on the phone.
- Without a brain account, or when the service does not answer, the console keeps its local chats as today.

## What is paused

Telegram waits until this path works; it is taken up only if the path shows it is needed. F2 (the `node` token
scope, the coordinator's MCP tools for nodes, pairing a server from the console) was taken up in the third round
(below, and [ADR 0013](0013-a-server-node-without-a-terminal.md)); what of it stays paused is presence beyond «a
session not locked».

## Slices

| Slice | What                                                                                                                                                 | Size   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| G1    | Chat turns in the service (routes, SSE), the node's turn loop over ask.ts's runner                                                                   | medium |
| G2    | The web app at `/app`: sign-in, Chat, Tasks, Brain, Machines; PWA shell                                                                              | medium |
| G3    | Web Push: VAPID keys, subscriptions, the three events                                                                                                | small  |
| G4    | Pairing by code (`agents node pair`, the console's button, _Machines › Pair_)                                                                        | small  |
| G5    | What waits on the phone: jobs and requests, the passkey yes (WebAuthn, the nodes pin its key)                                                        | medium |
| G6    | Hosting for others: the sign-up and privacy text, onboarding in the docs (EN, IT), the hosted instance                                               | small  |
| G7    | The app done well: a real mobile design, the chat's Markdown, code and changes, loading and error states, Tasks and Brain, dark theme, accessibility | large  |

G1 → G2 → G3 make the path; G4 makes it simple; G5 makes it whole; G6 opens it; G7 makes it good to use. The console's own Chat page
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

## As built (G4, G5, G1b, G7; 2026-10-15)

What the building changed in the contract, and what it left open.

- **Pairing shows the machine before it pairs it.** `POST /api/pair/claim` `{code}` answers `{preview: {node,
  platform, asked}}` and binds nothing; `{code, confirm: true}` pairs. Without the preview, a code someone else
  handed over would have made their machine the person's node, with a token for the account, unseen. The token is
  made at the poll that hands it over, so none sits in the database; the pairing's secret is kept out of the log.
- **A passkey is endorsed as it was shown.** The console sends the fingerprint the owner confirmed, and the backend
  signs only a key that still has it; `agents passkeys endorse` signs the very key it printed. The fingerprint is
  the first 8 bytes of SHA-256 of the 65-byte P-256 point, shown `ab12-cd34-ef56-7890`, the same on the phone.
- **Added routes and fields**: `POST /api/node/answers` `{results: [{id, ok, why?}]}` (the node reports every answer,
  applied or refused, and why); `answers` in `GET /api/waiting` (the last hour, so the phone shows a refusal); a
  passkey's `id` is the base64url credential id, and `assertion.credential` the same; `GET /api/chats` rows carry
  `turns`; a turn carries `code` (the folder the answer named) and the `done` event carries it as a string; `POST
  /api/chats` takes `node` to pin a turn to one machine.
- **Exact encodings the challenge depends on**: `expires` is `Date.toISOString()` (milliseconds, `Z`); `answers` is
  omitted when there are none (not `null`, not `{}`); a multi-select answer is the labels joined by `,`, as Claude
  Code's own AskUserQuestion; `<child>/<request>` travels as one percent-encoded path segment.
- **Open**:
  - no cancel for a turn: «Stop waiting» on the phone stops watching, the turn stays queued; a turn pinned to an
    offline machine waits for it;
  - ~~declining a proposed job from the phone is not signed~~, ~~the answer's challenge binds the request's id, not
    its text~~ and ~~revoking a passkey is the service withholding it~~: closed by the second round below («The yes,
    tightened»). What stays open of them: a node without the vault (pinned by `approvalKey` alone) cannot read the
    revocation list, so for it a revoked passkey is only withheld by the service; a phone's decline is checked by the
    node the job is for (or the one that proposed it, while it has none), after the fact, and a decline that does not
    hold is answered by proposing the work again, not by undoing it.

## The API, second round (2026-10-16)

The owner's first use from the phone, and the points left open above.

### Voice

- **Dictation** in the composer where the browser has speech recognition (`webkitSpeechRecognition`): the words
  appear in the box as they are said, in the account's language, and are sent as text. The app says that the audio
  goes to the phone's own service (Apple, Google) for this.
- **A voice note**: the app records (`MediaRecorder`: Opus in WebM, or AAC in MP4 on iOS), at most 5 minutes and 10
  MB, and sends it: `POST /api/chats/voice` (multipart: `audio`, `chat?`, `node?`) → `{chat, turn}`; the turn has
  `voice: true` and no text yet. The audio is kept by the service only until the turn ends, then deleted.
- **Only a machine that can transcribe takes a voice turn**: a node announces `voice: true` when it has whisper.cpp
  (`voice: {bin, model}` in this machine's `node.json`, found by `agents node voice` among the usual places, or set
  with `agents node voice --bin <whisper-cli> --model <ggml model>`) and ffmpeg. The poll's turn carries `voice:
  true`; the node fetches `GET /api/turns/<id>/audio` (its token), converts it to 16 kHz mono WAV, transcribes it
  locally in the account's language, posts `{t: "transcript", text}` as the turn's first event (the service stores it
  as the turn's question and relays it as an SSE `transcript` event), then answers it as any turn. The audio never
  leaves the person's machines but for the service's copy.

### The chat's own actions

- `PATCH /api/chats/<id>` `{title}` renames; the list is searchable in the app (titles and questions, local).
- **Cancel a turn**: `POST /api/turns/<id>/cancel` (any caller of the account): a waiting turn becomes `cancelled` at
  once; a running one is marked, and the node's next `events` or heartbeat is answered `409 {cancelled: true}`, on
  which the node stops Claude and ends the turn. SSE `turn` state `cancelled`. «Stop waiting» becomes «Cancel».

### Machines

- **Forget a machine**: `DELETE /api/nodes/<name>` (signed in): the node, what waits on it and its claimed turns go,
  and its personal tokens named after it are revoked: a forgotten machine cannot come back without pairing again.
  `agents nodes forget <name>` does the same from a desktop.

### The yes, tightened

- **The challenge binds the request's words**: `agents-multi answer v2\n` + canonical JSON of `{id, node, verdict,
  answers, expires, what}`, where `what` is the base64url SHA-256 of the canonical JSON of `{what, questions}` as the
  node relayed them. The node recomputes it from its own hub's copy, so a service that showed the phone other words
  gets a signature that fails. v1 answers are refused.
- **Declining a proposed job from the phone is signed** as accepting is (`{op: "decline", assertion, expires}`,
  challenge over `agents-multi job decline v1` and the job's canonical text); a desktop's token declines as before.
- **Revocation the nodes check**: `agents passkeys revoke <id>` (and the console's button) writes the revocation
  into the vault (`passkey-revocations`), which every machine of the owner has; a node with the vault refuses a
  revoked passkey whatever the service lists. The service's `DELETE /api/passkeys/<id>` still hides it.
- **Passkeys that password managers save**: creation asks for a discoverable credential (`residentKey: "required"`,
  `requireResidentKey: true`), gives the person 5 minutes, and the app shows the browser's exact error (its name and
  message) when it fails.

### As built (the yes, tightened; 2026-10-16)

- `what` is the hash of the words **as the node relays them**: the node bounds them (`boundWords`: `what` to 1000
  characters, at most 4 questions, 8 options, known fields) before it sends them, the service keeps them as they
  came (bounding again changes nothing), and the phone hashes what it shows. The service's old rewording is gone.
- The answer the service hands a node carries no `what`; the node adds its own. An answer whose request the hub no
  longer waits on is refused («nothing waits on that on this machine any more») and not remembered. The replay key
  ignores `what` (the node has it only while the request waits). A v1 answer is refused and named as such.
- A phone's decline is stored with its assertion and `expires` (within a day) and handed back in the announce's
  reply (`declined`) for 24 hours to the node the job is for, or the one that raised it while it has none; that node
  checks it once, over `agents-multi job decline v1\n` and the job's canonical text, and when it does not hold it
  tells the owner and proposes the work again. A decline by a machine's token drops the approval's assertion.
- Revocations are vault entries: service `passkey-revocations`, account the credential's id, value the date. A node
  refuses a revoked passkey for an answer, a job's approval and a decline alike. A vault that is there but cannot be
  opened right now refuses nothing and accepts nothing: the node tries again at the next tick.
- A phone's decline is checked after the service has marked it: what a node that holds no such decline does is tell
  the owner and propose the work again (detection and a second chance, not prevention). A job with no node, raised by
  the service or by a machine that is gone, has nobody to check its decline.
- The challenge of a passkey's creation now lives six minutes, a little over the five the browser is given.

## As built (second round: voice, the chat's actions, forgetting a machine; 2026-10-16)

- **Voice routing.** The audio is a row of `turn_audio` (a blob in the account's database), deleted when the turn
  ends in any way (done, failed, cancelled) and with its chat. `chat_turns.voice` marks the turn; its `q` is empty until
  the `transcript` event, which also renames the chat from «Voice note» to the transcript's first words. A voice turn
  is claimed only by a node whose announcement says `voice: true`; unpinned, it goes to the account's answering node
  _among the voice nodes_ (the setting's choice, then its fallbacks, then the first online). A note pinned to a machine
  known not to transcribe is refused (409); at most five notes wait with their audio at once per account (429). Only the
  first `transcript` of a turn counts.
- **Limits.** 10 MB of audio (the body is read with a cap, declared or not), types `audio/webm`, `mp4`, `x-m4a`, `m4a`,
  `aac`, `ogg`, `mpeg`, `wav`, `x-wav` and `video/webm`, `video/mp4` (what browsers call a recording), anything else 415.
  The five minutes are the app's to enforce.
- **Cancel.** A running turn gets `cancel = 1`; the node's next `events` or `done` finishes it as `cancelled` (SSE `turn`,
  audio deleted) and is answered `409 {error, cancelled: true}`; a marked turn whose node went silent is reclaimed as
  `cancelled`, not `waiting`. A finished answer arriving after the mark is dropped. Anything else the service says
  about a turn that is not running is a plain 409 without `cancelled`.
- **Forget.** `DELETE /api/nodes/<name>` answers `{ok, node, turns, tokens}` (404 when there was nothing); the turns it
  held wait again, those pinned to it fail with «the machine was forgotten»; its jobs stay as history. Any token or
  session of the account may do it, a forgotten machine's own token included.
- **The node.** `voice` is a machine field of `node.json`; both programs run with an empty environment; ffmpeg reads local files only
  (`-protocol_whitelist file`) with the container forced by the recording's type, so a playlist sent as audio is not
  followed; on a headless node with bubblewrap both run with the network and the processes unshared, the filesystem
  read only but for their temporary folder, and die with the node's process; half an hour is the most a note may take. Transcription is silent for the service, so the heartbeat keeps the turn ours meanwhile.
- **Not here.** Speech recognition in the browser and the recorder are the web app's.

## The API, third round (2026-10-16)

The owner at the phone wants three things the path lacks: a server that **has the repositories** its jobs need
without a hand-made clone, **the agents of every machine in one view**, and the same view **in Claude Desktop**
to orchestrate from. F2 ([ADR 0013](0013-a-server-node-without-a-terminal.md)) rides with them. Four slices
(`clone`, `runs`, `panel`, `f2`) built in parallel; «Who touches what», at the end, keeps them apart.

### A. Clone on first need, and the env files a repository's checkout lacks

**Clone on first need.** Where a job or a resume (ADR 0012, «Moving and resuming») names a repository the node
has no clone of, the node used to say «cannot move». It now clones, **only if the remote is allowed**:

- the remote is in `config/nodes.json` `repos` (the list `agents node setup` already clones), **or**
- its host is in the new `config/nodes.json` `gitHosts`: an array of `host` or `host/owner` prefixes (the owner's
  forge, `git.example.me`; their account on a public one, `github.com/owner`), matched on the parsed remote, never
  by substring. `gitHosts` is the owner's configuration, the same on every machine; empty by default (nothing is
  cloned on need until the owner lists a host).
- Any other remote — a client's, a stranger's — is **refused with its reason** in the job («not in repos or
  gitHosts»), and goes on only through an explicit `--repo` of `agents node seed` (below).
- The clone is made **by the node, with its own git key** (`<state>/git/`, the one `agents node setup` makes; the
  same `GIT_ENV`, no agent, no credentials from the environment), under the first `repoRoots`, by
  `git clone --quiet` into `<root>/<cloneName>` (`cloneName` of setup.ts moves to a shared module). Never with a
  token in the URL, never over a remote that is not `ssh://`, `https://` or `user@host:`. A clone that fails
  (the forge refuses the key) leaves nothing half made and tells the owner once per remote per hour.
- The function is `ensureClone(cfg, remote)` in `apps/cli/node/clone.ts` (pure parts: `remoteAllowed`,
  `cloneTarget`); agentd's resume path and the job's check call it before they declare a repository missing.

**`agents node seed <machine>`** (run on a machine with the vault, normally the owner's PC): the files a clone
lacks because git ignores them go through the vault, sealed, to a machine that will have the repository.

- **What**: in each repository chosen, the files `git ls-files --others --ignored --exclude-standard` lists that
  are named `.env`, `.env.*` or `.dev.vars`, `.dev.vars.*`, at the root or at most three folders down, never under
  `node_modules/`, `.git/`, `vendor/` or `dist/`. Which repositories: the owner's — those under this machine's
  `repoRoots` whose `origin` is in `repos` or `gitHosts` — with `--dry-run` listing paths (never values). **A
  client's repository only with an explicit `--repo <path>`**, one per flag, and the command says it is a client's
  case, asks for a yes, and writes `client: true` in the entry.
- **Where**: the vault (`shared/mcp/lib/vault.ts`), service `seed`, account `<host>/<path of the remote>` without
  `.git` (`git.example.me/owner/repo`), one entry per repository, value JSON `{v: 1, at, from, nodes: [names],
  client?: true, files: [{path, mode, b64}]}`. Sealed because the vault is: encrypted at rest, in the Syncthing
  folder the owner's machines and servers already share; no new store, nothing in the service, nothing in the
  repository, nothing in `nodes.json`. Re-seeding replaces the entry. `agents node seed --forget <repo>` deletes it.
- **Cap**: 64 KiB a file, 20 files and 256 KiB a repository, 200 entries a vault; one over is skipped with its
  name, never truncated.
- **Never seeded**, whatever its name: a symlink, a file outside the repository or not ignored by git (tracked
  `.env.example` is in the clone already), a file that is not UTF-8 text, any `*.pem`, `*.key`, `id_*`, `.npmrc`,
  `.netrc`, `credentials*`, `*.p12`, `*.kdbx`; anything in `.claude/`, `.agents/`, the vault, the state folder;
  and the values of the Claude or Anthropic credentials (`sk-ant-…`: a file with one is skipped and said). The
  node's deny rules on its own secrets (ADR 0012) are untouched.
- **The node writes them** at clone and again at each update of that clone (a resume or job start that fetches),
  and only when the entry lists its name: mode 0600, atomically, **never over a file that exists and differs**
  (kept, the difference reported once in the job's log), and only after `git check-ignore -q <path>` says git
  ignores it in that clone: a repository that stopped ignoring it never gets it written. Values are never logged.
- **Where the code is**: `apps/cli/node/seed.ts` (collect, cap, seal, apply: pure functions tested in
  `apps/cli/tests/`), the `seed` subcommand in `command.ts` (one case; see the table), the doctor check
  `node.seed` (an entry naming a machine the service does not know, or a client entry older than 90 days).

### B. The Agents view

The web app gets a section, **Agents**, between Waiting and Tasks: what is running, on which machine, and what it
is doing now.

- **A run** is a hub child, a routine's firing or a workflow's run, as the node's hub knows them. The node
  publishes **its own runs** as it publishes requests (ADR 0014, G5): the whole list replaces its previous one.
  ```
  PUT /api/node/runs {runs: [Run], routines?: [Routine]}  →  {ok}
  Run = {id, kind: "child" | "routine" | "workflow", profile, provider?, project, repo?, branch?, started,
         updated, state: "working" | "waiting" | "idle" | "ended" | "failed", ended?, tail: [string],
         waiting?: [<child>/<request>], routine?, workflow?: {name, step, steps: [{id, state}]}}
  Routine = {name, schedule, next?, last?, enabled}
  ```
  `id` is the child's id (`<profile>-…`, ADR 0005), `project` the folder under `~` (`personal/dnd/dragons-lair`),
  `repo` the remote's `host/path`, `tail` the last 5 lines of the child's output, each at most 400 characters,
  **masked** (`shared/mcp/lib/mask.ts`) and bounded by the node before it sends. `waiting` lists the ids that are
  also in `PUT /api/node/requests` (the Yes/No stays where it is: `POST /api/waiting/<id>`, passkey and all).
  The node sends when a run's state or tail changes, **at most once every 2 s**, and with each announce, as the
  requests are; at most 100 runs and 20 routines.
- **What a machine publishes** is its own choice: `runs` in this machine's `node.json` is `"full"` (default),
  `"state"` (no `tail`, no `branch`) or `"off"`. A run of a repository that is not the owner's (the rule of
  slice A: not in `repos` or `gitHosts`) is published as `"state"` whatever the machine says, with `project`
  and `repo` replaced by `(client)`: the client's names and output are not stored by a host. The console's
  Nodes page shows the setting.
- **The view reads**: `GET /api/runs` → `{runs: [Run & {node, online}], routines: [Routine & {node}], recent:
  [Run & {node}]}`, `runs` the live ones (state not ended) of nodes seen in the last 10 minutes, `recent` the
  last 50 ended in the last 7 days; sorted waiting first, then working, then newest. Any session or token of the
  account **except a `node` token** (ADR 0013, F2) may read.
- **Live**: `GET /api/runs/events` (Server-Sent Events, a comment every 20 s): `run` `{run}` (upsert, with `node`
  and `online`), `gone` `{id, node}` (a run dropped from its node's list without ending, or a forgotten
  machine), `node` `{node, online}` (a machine went offline: its runs are shown stale, not removed). The page
  loads `GET /api/runs` and then follows the stream, as the chat does.
- **Actions** (the person's, from the web session, each as the existing signed paths allow):
  - **Answer**: the same row as What waits: `POST /api/waiting/<id>` with the passkey (G5). Nothing new.
  - **Stop**: `POST /api/runs/<node>/<id>/stop` `{expires, assertion}`, the assertion of a passkey over
    `agents-multi stop v1\n` + canonical JSON of `{node, run, expires}`, `expires` at most 10 minutes ahead. The
    service stores it; the announce's reply carries `stops: [{run, expires, assertion}]` for that node, which
    verifies it exactly as it verifies a decline (the endorsement, the revocations, the replay record) and then
    stops the child (`stopChild`); the outcome comes back in `POST /api/node/answers` as `{id: "stop:<run>", ok,
    why?}`. A stop is signed because nobody but the owner stops their agents (ADR 0014, «the node checks it»).
  - **Resume elsewhere**: `POST /api/jobs` `{kind: "resume", run, from: <node>, node?}` proposes the move as ADR
    0012 «Placement» does (`place`), and the proposal is accepted on the phone with the passkey as any job: the
    new route is only a proposal raised for a run's id, not a new kind of authority. The row says why it cannot
    (no remote, `push: false`, a client's repository).
  - **Routines and workflows** are shown with their next firing and step; no action beyond the above in this round.
- **What the service stores, and for how long**: table `runs` (`node`, `id`, `data` JSON, `updated`) in the
  account's database, replaced per node by each `PUT`; a run no longer in the node's list is deleted unless its
  last state was `ended` or `failed`, which stay as `recent` for 7 days (purged hourly, with the account's
  other housekeeping), the tail included — so the host holds a few lines of what a child said for a week; the
  sign-up text (G6) says it, and `brain-admin delete` removes it with the rest. Forgetting a machine deletes
  its runs. The service never stores a stop's assertion beyond its `expires` plus an hour.
- **Where the code is**: `apps/brain/runs.ts` (table, `runsRoute`, SSE hub), `apps/cli/node/runs.ts` (collect
  from the hub, mask, bound, publish, apply stops), `apps/ui/src/web/agents.tsx` (the section, one tab entry),
  strings in the new `apps/ui/src/i18n/web-agents.ts` (merged into the app's dictionary by one line in
  `web/t.ts`), tests in `apps/cli/tests/` and `apps/brain/tests/`.

**As built (fourth round, 2026-10-16).** A client's run goes with an **opaque id**: `x-` and 32 hex digits of an
HMAC-SHA256 of the real id, with a key the node makes once (`<runs>/node/runs-key`, 0600) and never sends; its
`waiting` ids are opaque the same way and its workflow's steps are numbered, not named. A Stop names the opaque id
and the node finds its run by recomputing it over its own runs; a resume moves the run's job, which the service
already knows. Who owns a repository is one function, `ownedRemote` in `clone.ts`, for a clone on need and for the
runs alike; `agents node hosts add <host>` puts the owner's forge in `nodes.json` `gitHosts` (proposed by `agents
node enable` and the doctor's `node.runs` when neither list is set). The tables are a step of the brain's
migrations; the stops waiting for a node are `stops.ts`, so `fleet.ts` and `runs.ts` no longer import each other. A
resume is a proposal whose parent is the run's job (`Fleet.proposeResume`): one open per job, whether the phone or
the sweep raises it. **What a client's child waits on is not relayed** (`requestsOf`, `waiting.ts`): its words name
the client, and a yes to a placeholder would be a yes unseen. It is answered on the machine; the Agents view shows
that the run waits, and an answer naming such a request finds nothing to answer.

### C. The panel: orchestrating from Claude Desktop

Claude Desktop shows an **MCP App** (the MCP Apps extension:
a tool declares `_meta.ui.resourceUri`, and the host renders that `ui://` resource, an HTML page, in a sandboxed
frame beside the conversation). The `agents` MCP server (`shared/mcp/agents/`) gains one.

- **Resource**: `ui://agents/panel`, MIME type `text/html;profile=mcp-app`, **one self-contained HTML file**
  (inline CSS and JS, no CDN, no framework, no build step: `shared/mcp/agents/panel/panel.html`, read when the
  server starts), served through `resources/read`. It declares no external origins in its `_meta.ui.csp`: it
  needs none, since all data comes through the host.
- **Tools**:
  - `agents_panel` (model-visible): «Open the panel of this session's children and runs.» Its result's text is a
    short summary (counts, what waits) and its `structuredContent` is the first snapshot; its `_meta.ui` names
    the resource. The model calls it when the owner asks to see or manage the agents.
  - `agents_panel_state` (visible only to the app: `_meta.ui.visibility: ["app"]`, **to confirm against Claude
    Desktop's build** — if the host ignores it the tool is merely also listed, harmless) → the snapshot:
    `{at, children: [{id, profile, provider, project, phase, orphan?, started, last, tail}], runs: [{id, name,
    state, step, steps: [{id, state}], confirm?}], requests: [{id, child, kind, what, questions?, session}],
    limits: [{profile, provider, windows: [{name, used, resets}]}], stale?}`, with the same scope as the other tools: the
    session's own children and runs, never another's (`project`/`all` are not offered).
  - The buttons call tools that already exist, through the host: **`agent_answer`** (Yes → `allow`, Yes for the
    session → `session`, No → `deny`; a `question` shows its options and the owner's own text, `answers`),
    **`agent_stop`**, **`workflow_answer`** (go / skip / retry / stop), and for steps `workflow_status`. No new
    permission and no new authority: a click is the owner's own act, rendered from the same `Pending` the model
    would have asked about, and the panel shows the request's exact `what`, never a paraphrase, as text (never
    HTML).
- **Where the data comes from**: `shared/mcp/lib/panel.ts` (new, pure and tested) assembles the snapshot from
  the functions `agents.ts` already exports (`listChildren`, `look`/`attentionBetween`, the workflow runs
  reader, the limits reader of `limits`); `shared/mcp/lib/agents.ts` itself is **not changed** by this round,
  except an additive export if the panel needs one it lacks (the panel's owner only).
- **Live without a loop of its own**: a stdio MCP server cannot push into the frame, and `resources/updated`
  reaches the host, not the app. So the app **asks through the host** with `agents_panel_state`: every 2 s while
  something is working or waiting, every 15 s when all is idle, **not at all while the frame is hidden**
  (`visibilitychange`), and once straight after any button; it stops on the first error and offers «Refresh». Each
  call is a read of the runs folder (the same read `agent_list` does). Chosen over holding a long call open
  (`agent_wait`-style) because hosts time long tool calls out and one stuck call blocks the buttons, and over no
  refresh because a request that waits unseen is the whole point. The host's `ui/notifications/tool-result` for
  `agents_panel` is the first paint, so nothing is blank while the first poll is on its way.
- **Fallback**: a host without the extension ignores `_meta.ui` and the model gets the text summary: the tools
  work as today. The instructions of the server gain one sentence about the panel (and one about
  `node_list`/`node_propose`, slice F2).
- **Not in this round**: remote machines' runs (they are the web app's, slice B), editing a plan inside the
  panel, a panel in the console (it has its own pages).

### F2 in this round

F2's shape (pairing a server from the console, the `node` token scope, the coordinator's MCP tools) is in
[ADR 0013](0013-a-server-node-without-a-terminal.md), «F2: pairing from the console». Slice `f2` builds it.

### Who touches what

Four agents build in parallel, each on its own branch. A slice **owns** the paths in its row; it touches a
**shared** file only as the third column says, by adding lines and never rewording or moving what is there.
Anything else it needs from another's path goes by `team_send`, not by an edit. The reviewer merges the four.

| Slice   | Owns (create, change freely)                                                                                                                                                                                                                                        | Shared files: additive only, and where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clone` | `apps/cli/node/clone.ts`, `apps/cli/node/seed.ts`, `apps/cli/tests/node_clone_test.ts`, `apps/cli/tests/node_seed_test.ts`, the `node.seed` check in `apps/cli/doctor/`                                                                                             | `apps/cli/node/command.ts`: one `case "seed":` block **right after `case "key":`** (the last case) and one import line **at the end** of the imports. `apps/cli/node/setup.ts`: its `cloneName` import from `clone.ts` (one line; the rest untouched). `apps/cli/node/agentd.ts`: only the `ensureClone` call where a resume finds no clone. `shared/mcp/lib/headless.ts`: only the config's new `gitHosts` field (type, default `[]`, parser line). `shared/mcp/lib/moving.ts`: only the «no clone» refusal, to call `ensureClone`. README: one paragraph in the node section.                                                                                                                                                                                                                                                                                 |
| `runs`  | `apps/brain/runs.ts`, `apps/brain/tests/runs_test.ts`, `apps/cli/node/runs.ts`, `apps/cli/tests/node_runs_test.ts`, `apps/ui/src/web/agents.tsx`, `apps/ui/src/i18n/web-agents.ts`, the console's Nodes setting for `runs` in a new file under `apps/ui/src/pages/` | `apps/brain/main.ts`: one import line **right after the `./waiting.ts` import** and one route block **right after the waiting block** (before «the person types the code a machine shows»); the table is created by `runs.ts`, no edit of `store.ts`. `apps/cli/node/agentd.ts`: one publish call in `tick()`/`quick()` and the `stops` handling next to `declined`. `apps/cli/node/service.ts`: the `PUT /api/node/runs` helper and `stops` in the announce reply type. `apps/brain/fleet.ts`: only the announce reply's `stops` field. `apps/ui/src/web/app.tsx`, `route.ts`: the section's route and tab. `apps/ui/src/web/t.ts`: one line merging `web-agents.ts`. `apps/ui/src/web/web.css`: rules **appended at the end**. `shared/mcp/lib/headless.ts`: only the machine's `runs` field of `node.json`. **Not** `apps/ui/src/i18n/web.ts`.               |
| `panel` | `shared/mcp/agents/panel/`, `shared/mcp/agents/panel-tools.ts`, `shared/mcp/lib/panel.ts`, its tests beside the other MCP tests                                                                                                                                     | `shared/mcp/agents/server.ts`: the `instructions` text (**the panel's owner is its only editor**: one sentence about the panel and this one about nodes, «Nodes: node_list shows the owner's machines (online, sessions, accounts); node_propose asks a node to run a routine or resume a run, and the owner's yes decides.»), one import line **before the `registerAgentTools` import** and one `registerPanel(server)` call **before `registerAgentTools(server)`**. `shared/mcp/lib/agents.ts`: **nobody edits it**; the panel's owner alone may add an export. `scripts/ci.sh`: the MCP probe's expected tool list, if it has one.                                                                                                                                                                                                                         |
| `f2`    | `apps/cli/node/pair.ts`, `apps/brain/pair.ts`, `shared/mcp/lib/seal.ts`, `shared/mcp/agents/node-tools.ts`, `apps/ui/src/i18n/servers.ts`, the console's «Add a server» page under `apps/ui/src/pages/`, tests for each                                             | `apps/brain/auth.ts`: `Caller.scope`, the `tokens.scope` column (in-place migration, as `oauth_codes.scope` was), the scope check: f2's file. `apps/brain/main.ts`: the gate right after `who` is computed, the pair routes (edited in place) and `GET /api/nodes` fields; **not** the waiting block or what follows it. `apps/brain/tools.ts`: the area filter of a `node` caller. `apps/brain/fleet.ts`: `kind: "server"` and the git key on the node row. `apps/cli/node/command.ts`: **only inside `case "pair":`**. `apps/cli/node/setup.ts`: only the step that publishes the git key. `shared/mcp/agents/server.ts`: one import line **after the `registerRoutineTools` import** and one `registerNodeTools(server)` call **after `registerAccountTools(server)`**, nothing else. `apps/ui/src/i18n.ts`: one import line and one entry for `servers.ts`. |

Shared files by name:

- **`apps/cli/node/command.ts`**: `clone` adds `case "seed"` after `case "key"`; `f2` edits only inside `case "pair"`;
  `runs` does not touch it (its setting is one optional field of `node.json`, in `headless.ts`).
- **`apps/brain` routing (`main.ts`)**: `f2` the gate after `who` and the pair routes; `runs` one import and one block
  after the waiting block; `clone` and `panel` nothing. Each route function lives in its slice's own file.
- **`apps/ui` i18n**: `i18n/web.ts` is edited by **nobody** this round; `runs` adds `web-agents.ts` (merged in
  `web/t.ts`); `f2` adds `servers.ts` (registered in the console's `i18n.ts`); Italian carries every English key.
- **`shared/mcp/lib/agents.ts`**: nobody (the panel's owner may add an export). **`shared/mcp/agents/server.ts`**: the
  panel's owner edits the instructions and its own lines; `f2` adds its two lines at the places named.
- **`shared/mcp/lib/headless.ts`**: `clone` adds `gitHosts` to the config's type, `runs` adds the machine's `runs`: two
  fields in two places.
- Every slice adds its invariants to `apps/cli/doctor/`, not to the README, and its tests beside the code.

## As built (third round; 2026-10-16)

- **Stop results ride the runs' publish**: the node sends `{id: "stop:<run>", ok, why?}` as `results` in its next
  `PUT /api/node/runs`, not in `POST /api/node/answers`.
- **Resume elsewhere** is `POST /api/runs/<node>/<id>/resume`: the service raises the `resume` job for the run, which
  the phone accepts with the passkey as any job.
- **The panel exists only where the `agents` MCP server is**: `_surfaces: ["cli"]` at first; since 2026-10-16
  `["cli", "desktop"]`, with the Desktop app as a coordinator with no folder ([ADR 0005](0005-agent-workflows.md),
  amendment 2026-10-16), so Desktop's chat opens the same panel.
- **Client runs carry an opaque id** in what the node publishes.
- **`gitHosts`** stays empty by default; `agents node hosts add <host>` fills it (fourth round, above).
- F2's deviations are in [ADR 0013](0013-a-server-node-without-a-terminal.md), «As built (F2)».

# 0014 — From the phone: the web app on the service, the orchestrator on a paired machine

- Status: accepted 2026-10-15; G1–G3 built (1.2.1-rc.2), G4–G7 in progress
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

F2 (the `node` token scope, the coordinator's MCP tools for nodes, presence) and Telegram wait until this path
works; each is taken up only if the path shows it is needed.

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
  - declining a proposed job from the phone is not signed (the contract signs a deny of a request, and is silent on
    a job's decline): a stolen session can decline work, not start it;
  - the answer's challenge binds the request's id, not its text: a hostile service could show the phone different
    words for the same id; binding a hash of `what` is the next revision of the signed text;
  - revoking a passkey is the service withholding it; the nodes keep no revocation list of their own.

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

## As built (second round: voice, the chat's actions, forgetting a machine; 2026-10-16)

- **Voice routing.** The audio is a row of `turn_audio` (a blob in the account's database), deleted when the turn
  ends in any way (done, failed, cancelled) and with its chat. `chat_turns.voice` marks the turn; its `q` is empty until
  the `transcript` event, which also renames the chat from «Voice note» to the transcript's first words. A voice turn
  is claimed only by a node whose announcement says `voice: true`; unpinned, it goes to the account's answering node
  _among the voice nodes_ (the setting's choice, then its fallbacks, then the first online). A turn pinned to a machine
  that cannot transcribe waits there until cancelled: the service accepts it, it does not guess.
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
- **The node.** `voice` is a machine field of `node.json`; both programs run with an empty environment and, on a
  headless node with bubblewrap, whisper runs with the network unshared and the filesystem read only but for its
  temporary folder. Transcription is silent for the service, so the heartbeat keeps the turn ours meanwhile.
- **Not here.** Speech recognition in the browser and the recorder are the web app's.

// chat.ts — the account's chats and their turns (ADR 0014, G1): the phone writes a turn, the node that answers for
// the account claims it over a long poll, relays what Claude says as it goes and ends it; the web app follows on
// Server-Sent Events. The service runs no agent. The database is the truth (a reconnecting client reads
// GET /api/chats/<id>); the SSE fan-out is in memory and only a courtesy to the clients connected right now.
// A node holds a turn by its beat: a claim, an events call (an empty list is a heartbeat). Silent for 90 s, the
// turn goes back to `waiting` and starts over, from the top, on whichever node answers then.

import type { DatabaseSync } from "node:sqlite";
import { isOnline, type NodeInfo, validNodeName } from "../../shared/mcp/lib/nodes.ts";
import { Fleet } from "./fleet.ts";

/** A node silent this long loses the turns it claimed. */
export const RECLAIM_MS = 90_000;
const MAX_TEXT = 20_000;
const MAX_TITLE = 120;
const MAX_ANSWER = 200_000;
const MAX_ACTS = 200;
const HISTORY = 10;
const KEEPALIVE_MS = 20_000;
/** A voice note: at most 10 MB of audio (5 minutes of Opus or AAC is far below), of these types. */
export const MAX_AUDIO = 10 * 1024 * 1024;
export const AUDIO_TYPES = [
  "audio/webm",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/aac",
  "audio/ogg",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "video/webm",
  "video/mp4",
];
/** What the chat is called until the node has transcribed its first voice note. */
export const VOICE_TITLE = "Voice note";

export type TurnState = "waiting" | "running" | "done" | "failed" | "cancelled";
export interface Act {
  k: string;
  n: string;
  d?: string;
}
export interface Turn {
  id: string;
  q: string;
  a: string;
  acts: Act[];
  state: TurnState;
  node: string | null;
  error: string | null;
  /** the folder Claude named for work inside a project's files (`[[code:PATH]]`), when it did */
  code?: string;
  /** a voice note: `q` is empty until the node has transcribed it */
  voice?: true;
  created: string;
  ended: string | null;
}
export interface ChatSummary {
  id: string;
  title: string;
  updated: string;
  node: string | null;
  /** how many turns the chat has, in any state */
  turns: number;
}
export interface Orchestrator {
  node: string | null;
  order: string[];
}
/** What the answering node gets for a turn it claimed. */
export interface Claimed {
  id: string;
  chat: string;
  text: string;
  session: string | null;
  history: { q: string; a: string }[];
  /** a voice note: fetch `GET /api/turns/<id>/audio`, transcribe, post a `transcript` event first */
  voice?: true;
}
export type NodeEvent =
  | { t: "text"; d: string }
  | { t: "tool"; k: string; n: string; d?: string }
  | { t: "session"; id: string }
  | { t: "transcript"; text: string };

export interface SseEvent {
  event: "turn" | "text" | "act" | "done" | "transcript";
  data: Record<string, unknown>;
}

/** What a push says when a turn ends. */
export interface PushNotice {
  chat: string;
  turn: string;
  title: string;
  body: string;
  failed: boolean;
}

export class ChatError extends Error {
  constructor(message: string, readonly status = 400, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** The in-memory side, shared by every request of the process: who follows which chat, and which node is waiting
 *  for a turn. Keys carry the account, so one account never hears another's chat. */
export class ChatHub {
  private subs = new Map<string, Set<(e: SseEvent) => void>>();
  private waiters = new Map<string, Set<() => void>>();

  publish(user: string, chat: string, e: SseEvent) {
    for (const f of [...this.subs.get(`${user}/${chat}`) ?? []]) f(e);
  }

  subscribe(user: string, chat: string, f: (e: SseEvent) => void): () => void {
    const k = `${user}/${chat}`;
    const set = this.subs.get(k) ?? new Set();
    set.add(f);
    this.subs.set(k, set);
    return () => {
      set.delete(f);
      if (!set.size) this.subs.delete(k);
    };
  }

  /** How many clients follow the chat now. */
  following(user: string, chat: string): number {
    return this.subs.get(`${user}/${chat}`)?.size ?? 0;
  }

  /** A node's polls are woken when the account has a turn to take. */
  wake(user: string) {
    for (const f of [...this.waiters.get(user) ?? []]) f();
  }

  /** Made before looking, so a turn that arrives between the look and the wait is not missed. */
  waiter(user: string, signal?: AbortSignal): { wait(ms: number): Promise<void>; cancel(): void } {
    let woken = false, wakeNow: (() => void) | null = null, timer: ReturnType<typeof setTimeout> | undefined;
    const set = this.waiters.get(user) ?? new Set();
    this.waiters.set(user, set);
    const f = () => {
      woken = true;
      wakeNow?.();
    };
    set.add(f);
    const cancel = () => {
      clearTimeout(timer);
      set.delete(f);
      if (!set.size) this.waiters.delete(user);
      signal?.removeEventListener("abort", f);
    };
    signal?.addEventListener("abort", f);
    return {
      cancel,
      wait: (ms) =>
        woken || signal?.aborted ? Promise.resolve() : new Promise((res) => {
          wakeNow = res;
          timer = setTimeout(res, ms);
        }),
    };
  }
}

interface TurnRow {
  id: string;
  chat: string;
  q: string;
  a: string;
  acts: string;
  state: string;
  node: string | null;
  error: string | null;
  session: string | null;
  created: string;
  ended: string | null;
  beat: number | null;
  /** the only node that may take it, when the asker pinned one */
  pin: string | null;
  code: string | null;
  voice: number;
  cancel: number;
}

const toTurn = (r: TurnRow): Turn => ({
  id: r.id,
  q: r.q,
  a: r.a,
  acts: JSON.parse(r.acts),
  state: r.state as TurnState,
  node: r.node,
  error: r.error,
  ...(r.code ? { code: r.code } : {}),
  ...(r.voice ? { voice: true as const } : {}),
  created: r.created,
  ended: r.ended,
});

/** Pure: a chat's title from its first request: the first line, trimmed, at most 60 characters. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0].trim().replace(/\s+/g, " ");
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line || "Chat";
}

/** Pure: the node that answers for an account. Its chosen one when online, else the first of the fallbacks that is
 *  online, else (nothing chosen, or none of them there) the first online headless node, else the first online one.
 *  `caller` is the node asking: it is talking to the service, so it is online whatever its last announcement says. */
export function answeringNode(
  nodes: Pick<NodeInfo, "name" | "seen" | "headless">[],
  setting: Orchestrator,
  now: number,
  caller?: string,
): string | null {
  const online = nodes.filter((n) => isOnline(n, now) || n.name === caller);
  if (caller && !online.some((n) => n.name === caller)) online.push({ name: caller, seen: "", headless: false });
  const up = new Set(online.map((n) => n.name));
  if (setting.node && up.has(setting.node)) return setting.node;
  const next = setting.order.find((n) => up.has(n));
  if (next) return next;
  return (online.find((n) => n.headless) ?? online[0])?.name ?? null;
}

export class Chats {
  constructor(
    private db: DatabaseSync,
    private hub: ChatHub,
    private o: {
      user: string;
      now?: () => number;
      newId?: () => string;
      /** called when a turn ends, to push it to the person's devices */
      notify?: (p: PushNotice) => void;
    },
  ) {}

  private now = () => (this.o.now ?? Date.now)();
  private iso = () => new Date(this.now()).toISOString();
  private newId = () => (this.o.newId ?? (() => crypto.randomUUID().replace(/-/g, "").slice(0, 16)))();
  private publish(chat: string, event: SseEvent["event"], data: Record<string, unknown>) {
    this.hub.publish(this.o.user, chat, { event, data });
  }

  // ---------------------------------------------------------------- reading

  list(): ChatSummary[] {
    this.reclaim();
    return (this.db.prepare(
      `select c.id, c.title, c.updated,
        (select t.node from chat_turns t where t.chat = c.id order by t.rowid desc limit 1) as node,
        (select count(*) from chat_turns t where t.chat = c.id) as turns
       from chats c order by c.updated desc, c.rowid desc`,
    ).all() as unknown as ChatSummary[]).map((c) => ({
      id: c.id,
      title: c.title,
      updated: c.updated,
      node: c.node ?? null,
      turns: Number(c.turns),
    }));
  }

  get(id: string): { id: string; title: string; turns: Turn[] } | null {
    this.reclaim();
    const c = this.db.prepare("select id, title from chats where id = ?").get(id) as
      | { id: string; title: string }
      | undefined;
    return c ? { ...c, turns: this.turns(id).map(toTurn) } : null;
  }

  private turns(chat: string): TurnRow[] {
    return this.db.prepare("select * from chat_turns where chat = ? order by rowid").all(chat) as unknown as TurnRow[];
  }

  private turn(id: string): TurnRow | undefined {
    return this.db.prepare("select * from chat_turns where id = ?").get(id) as TurnRow | undefined;
  }

  // ---------------------------------------------------------------- writing

  /** A new turn, in a new chat when `chat` is absent. `pin`: the one node that may answer it (any caller of the
   *  account may pin; the answering node of the account's setting does not apply to a pinned turn). */
  post(text: unknown, chat?: unknown, pin?: unknown): { chat: ChatSummary; turn: Turn } {
    if (typeof text !== "string" || !text.trim()) throw new ChatError("text is the request");
    if (text.length > MAX_TEXT) throw new ChatError(`text is at most ${MAX_TEXT} characters`, 413);
    return this.insert(text, chat, pin);
  }

  /** A voice note: a turn with no text yet, and the audio kept until the turn ends. */
  postVoice(
    audio: { type: string; data: Uint8Array },
    chat?: unknown,
    pin?: unknown,
  ): { chat: ChatSummary; turn: Turn } {
    const type = audio.type.split(";")[0].trim().toLowerCase();
    if (!AUDIO_TYPES.includes(type)) throw new ChatError(`audio is one of ${AUDIO_TYPES.join(", ")}`, 415);
    if (!audio.data.byteLength) throw new ChatError("the audio is empty");
    if (audio.data.byteLength > MAX_AUDIO) throw new ChatError("the audio is at most 10 MB", 413);
    return this.insert("", chat, pin, { type, data: audio.data });
  }

  private insert(
    text: string,
    chat: unknown,
    pin: unknown,
    audio?: { type: string; data: Uint8Array },
  ): { chat: ChatSummary; turn: Turn } {
    if (chat !== undefined && chat !== null && (typeof chat !== "string" || !/^[\w-]{1,64}$/.test(chat))) {
      throw new ChatError("not a chat id");
    }
    if (pin !== undefined && pin !== null && pin !== "" && !validNodeName(pin)) {
      throw new ChatError("node is a node name");
    }
    const at = this.iso();
    let id = typeof chat === "string" ? chat : "";
    this.db.exec("begin immediate");
    try {
      if (id) {
        if (!this.db.prepare("select 1 from chats where id = ?").get(id)) throw new ChatError("no such chat", 404);
        this.db.prepare("update chats set updated = ? where id = ?").run(at, id);
      } else {
        id = `c-${this.newId()}`;
        this.db.prepare("insert into chats (id, title, created, updated) values (?, ?, ?, ?)").run(
          id,
          audio ? VOICE_TITLE : titleFrom(text),
          at,
          at,
        );
      }
      const turnId = `u-${this.newId()}`;
      this.db.prepare("insert into chat_turns (id, chat, q, created, pin, voice) values (?, ?, ?, ?, ?, ?)").run(
        turnId,
        id,
        text,
        at,
        pin ? String(pin) : null,
        audio ? 1 : 0,
      );
      if (audio) {
        this.db.prepare("insert into turn_audio (turn, type, data, created) values (?, ?, ?, ?)").run(
          turnId,
          audio.type,
          audio.data,
          at,
        );
      }
      this.db.exec("commit");
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
    const row = this.db.prepare("select * from chat_turns where chat = ? order by rowid desc limit 1").get(
      id,
    ) as unknown as TurnRow;
    this.publish(id, "turn", { turn: row.id, state: "waiting", node: null });
    this.hub.wake(this.o.user);
    return { chat: this.list().find((c) => c.id === id)!, turn: toTurn(row) };
  }

  remove(id: string): boolean {
    const r = this.db.prepare("delete from chats where id = ?").run(id);
    return Number(r.changes) > 0;
  }

  /** Renames a chat. */
  rename(id: string, title: unknown): ChatSummary {
    if (typeof title !== "string") throw new ChatError("title is the new name");
    const t = title.trim().replace(/\s+/g, " ");
    if (!t || t.length > MAX_TITLE) throw new ChatError(`title is 1 to ${MAX_TITLE} characters`);
    const r = this.db.prepare("update chats set title = ? where id = ?").run(t, id);
    if (!Number(r.changes)) throw new ChatError("no such chat", 404);
    return this.list().find((c) => c.id === id)!;
  }

  /** Cancels a turn: a waiting one ends at once; a running one is marked, and its node is told at its next call. */
  cancel(id: string): TurnState {
    this.reclaim();
    const t = this.turn(id);
    if (!t) throw new ChatError("no such turn", 404);
    if (t.state === "waiting") {
      this.end(t, "cancelled");
      return "cancelled";
    }
    if (t.state === "running") {
      this.db.prepare("update chat_turns set cancel = 1 where id = ?").run(id);
      return "running";
    }
    throw new ChatError(`the turn is ${t.state}`, 409);
  }

  /** A turn that ends without an answer (cancelled, or failed by the service): its audio goes with it. */
  private end(t: TurnRow, state: "cancelled" | "failed", error?: string) {
    const at = this.iso();
    this.db.prepare("update chat_turns set state = ?, error = ?, ended = ?, beat = null where id = ?").run(
      state,
      error ?? null,
      at,
      t.id,
    );
    this.db.prepare("delete from turn_audio where turn = ?").run(t.id);
    this.db.prepare("update chats set updated = ? where id = ?").run(at, t.chat);
    this.publish(t.chat, "turn", { turn: t.id, state, node: t.node, ...(error ? { error } : {}) });
  }

  /** What a forgotten machine leaves: the turns it held go back to waiting (or end, when they were pinned to it
   *  or marked cancelled). Returns how many. */
  releaseNode(node: string): number {
    const rows = this.db.prepare(
      "select * from chat_turns where (state = 'running' and node = ?) or (state = 'waiting' and pin = ?)",
    ).all(node, node) as unknown as TurnRow[];
    for (const t of rows) {
      if (t.state === "waiting" || t.pin === node) this.end(t, "failed", "the machine was forgotten");
      else if (t.cancel) this.end(t, "cancelled");
      else this.restart(t);
    }
    this.hub.wake(this.o.user);
    return rows.length;
  }

  private restart(t: { id: string; chat: string }) {
    this.db.prepare(
      "update chat_turns set state = 'waiting', node = null, beat = null, a = '', acts = '[]', session = null where id = ?",
    ).run(t.id);
    this.publish(t.chat, "turn", { turn: t.id, state: "waiting", node: null });
  }

  /** The audio of a voice turn, for the node that holds it. */
  audio(id: string, node: string): { type: string; data: Uint8Array<ArrayBuffer> } {
    const t = this.turn(id);
    if (!t) throw new ChatError("no such turn", 404);
    if (!t.voice) throw new ChatError("not a voice turn", 404);
    if (t.state !== "running" || t.node !== node) throw new ChatError("not this node's turn", 403);
    const a = this.db.prepare("select type, data from turn_audio where turn = ?").get(id) as
      | { type: string; data: Uint8Array }
      | undefined;
    if (!a) throw new ChatError("the audio is gone", 404);
    return { type: a.type, data: new Uint8Array(a.data) };
  }

  // ---------------------------------------------------------------- the node's side

  /** Turns claimed by a node silent for 90 s go back to waiting, from the top. */
  reclaim(): number {
    const lost = this.db.prepare("select * from chat_turns where state = 'running' and beat < ?").all(
      this.now() - RECLAIM_MS,
    ) as unknown as TurnRow[];
    if (!lost.length) return 0;
    for (const t of lost) {
      if (t.cancel) this.end(t, "cancelled"); // asked to stop, and its node is gone: it does not start over
      else this.restart(t);
    }
    this.hub.wake(this.o.user);
    return lost.length;
  }

  orchestrator(): Orchestrator {
    const r = this.db.prepare("select v from meta where k = 'orchestrator'").get() as { v: string } | undefined;
    try {
      const v = JSON.parse(r?.v ?? "{}");
      return {
        node: validNodeName(v.node) ? v.node : null,
        order: Array.isArray(v.order) ? v.order.filter(validNodeName) : [],
      };
    } catch {
      return { node: null, order: [] };
    }
  }

  setOrchestrator(b: Record<string, unknown>): Orchestrator {
    const node = b.node === null || b.node === undefined || b.node === "" ? null : b.node;
    if (node !== null && !validNodeName(node)) throw new ChatError("node is a node name, or null");
    const order = b.order === undefined ? [] : b.order;
    if (!Array.isArray(order) || order.length > 20 || !order.every(validNodeName)) {
      throw new ChatError("order is a list of node names");
    }
    const v: Orchestrator = { node, order: [...new Set(order as string[])] };
    this.db.prepare("insert into meta (k, v) values ('orchestrator', ?) on conflict(k) do update set v = excluded.v")
      .run(JSON.stringify(v));
    this.hub.wake(this.o.user);
    return v;
  }

  /** Whether `node` is the one that answers for the account right now. */
  answers(node: string): boolean {
    return answeringNode(new Fleet(this.db, this.now).nodes(), this.orchestrator(), this.now(), node) === node;
  }

  /** The waiting turns this node answers for: at most `max`, the oldest of each chat, and none in a chat whose
   *  earlier turn is still running. A turn pinned to this node is its own whatever the account's setting says; an
   *  unpinned one is its own when it is the answering node; a turn pinned to another is never. Claimed: running,
   *  on this node. */
  claim(node: string, max = 1): Claimed[] {
    this.reclaim();
    // a voice note goes only to a machine that announced it can transcribe (a pinned one too), and when it is not
    // pinned, to the account's answering node among those
    const nodes = new Fleet(this.db, this.now).nodes();
    const voice = nodes.find((n) => n.name === node)?.voice === true;
    const ansVoice = voice &&
      answeringNode(nodes.filter((n) => n.voice === true), this.orchestrator(), this.now(), node) === node;
    const rows = this.db.prepare(
      `select * from chat_turns t where t.state = 'waiting'
         and (t.voice = 0 or ?)
         and (t.pin = ? or (t.pin is null and (case when t.voice = 1 then ? else ? end)))
         and not exists (select 1 from chat_turns r where r.chat = t.chat and r.state = 'running')
         and t.rowid = (select min(w.rowid) from chat_turns w where w.chat = t.chat and w.state = 'waiting')
       order by t.rowid limit ?`,
    ).all(
      voice ? 1 : 0,
      node,
      ansVoice ? 1 : 0,
      this.answers(node) ? 1 : 0,
      Math.max(1, Math.min(20, max)),
    ) as unknown as TurnRow[];
    const out: Claimed[] = [];
    for (const t of rows) {
      this.db.prepare("update chat_turns set state = 'running', node = ?, beat = ? where id = ?").run(
        node,
        this.now(),
        t.id,
      );
      const before = this.db.prepare(
        "select node, session from chat_turns where chat = ? and rowid < (select rowid from chat_turns where id = ?) and state in ('done', 'failed') order by rowid desc limit 1",
      ).get(t.chat, t.id) as { node: string | null; session: string | null } | undefined;
      const history = (this.db.prepare(
        "select q, a from chat_turns where chat = ? and rowid < (select rowid from chat_turns where id = ?) and state = 'done' order by rowid desc limit ?",
      ).all(t.chat, t.id, HISTORY) as unknown as { q: string; a: string }[]).reverse();
      out.push({
        id: t.id,
        chat: t.chat,
        text: t.q,
        session: before && before.node === node ? before.session : null,
        history,
        ...(t.voice ? { voice: true as const } : {}),
      });
      this.publish(t.chat, "turn", { turn: t.id, state: "running", node });
    }
    return out;
  }

  /** The turn, if it is running and this node's. */
  private mine(id: string, node: string): TurnRow {
    const t = this.turn(id);
    if (!t) throw new ChatError("no such turn", 404);
    if (t.node !== node && t.state !== "waiting") throw new ChatError("not this node's turn", 403);
    if (t.state !== "running" || t.node !== node) throw new ChatError(`the turn is ${t.state}`, 409);
    if (t.cancel) {
      // asked to stop: the node learns it here, stops Claude and has no more to report
      this.end(t, "cancelled");
      throw new ChatError("the turn was cancelled", 409, { cancelled: true });
    }
    return t;
  }

  /** What the answer has so far: relayed to the chat's streams and kept. An empty list is a heartbeat. */
  events(id: string, node: string, events: unknown): void {
    const t = this.mine(id, node);
    if (!Array.isArray(events) || events.length > 500) throw new ChatError("events is a list");
    let a = t.a, session = t.session, transcript: string | null = null;
    const acts: Act[] = JSON.parse(t.acts);
    const relay: [SseEvent["event"], Record<string, unknown>][] = [];
    for (const e of events as Record<string, unknown>[]) {
      if (e?.t === "text" && typeof e.d === "string") {
        if (a.length < MAX_ANSWER) a += e.d;
        relay.push(["text", { turn: id, d: e.d }]);
      } else if (e?.t === "tool" && typeof e.k === "string" && typeof e.n === "string") {
        const act: Act = {
          k: e.k.slice(0, 40),
          n: e.n.slice(0, 120),
          ...(typeof e.d === "string" ? { d: e.d.slice(0, 300) } : {}),
        };
        if (acts.length < MAX_ACTS) acts.push(act);
        relay.push(["act", { turn: id, ...act }]);
      } else if (e?.t === "session" && typeof e.id === "string" && /^[\w.-]{1,100}$/.test(e.id)) {
        session = e.id;
      } else if (e?.t === "transcript" && typeof e.text === "string" && e.text.trim()) {
        if (!t.voice) throw new ChatError("only a voice turn has a transcript");
        transcript = e.text.trim().slice(0, MAX_TEXT);
      } else throw new ChatError("an event is text, tool or session");
    }
    this.db.prepare("update chat_turns set a = ?, acts = ?, session = ?, beat = ? where id = ?").run(
      a,
      JSON.stringify(acts),
      session,
      this.now(),
      id,
    );
    if (transcript !== null) {
      // the question of the turn; the chat, named for the voice note until now, takes its first words
      this.db.prepare("update chat_turns set q = ? where id = ?").run(transcript, id);
      this.db.prepare("update chats set title = ? where id = ? and title = ?").run(
        titleFrom(transcript),
        t.chat,
        VOICE_TITLE,
      );
      relay.unshift(["transcript", { turn: id, text: transcript }]);
    }
    for (const [ev, data] of relay) this.publish(t.chat, ev, data);
  }

  /** The turn ends: done, or failed with an error. */
  done(id: string, node: string, b: Record<string, unknown>): void {
    const t = this.mine(id, node);
    const error = typeof b.error === "string" && b.error ? b.error.slice(0, 500) : null;
    const text = typeof b.text === "string" ? b.text.slice(0, MAX_ANSWER) : t.a;
    // the folder the answer named for work in a project (a string), or an exit code (a number)
    const code = typeof b.code === "string" && b.code.trim()
      ? b.code.trim().slice(0, 300)
      : typeof b.code === "number" && Number.isFinite(b.code)
      ? b.code
      : undefined;
    const at = this.iso();
    this.db.prepare(
      "update chat_turns set state = ?, a = ?, error = ?, code = ?, ended = ?, beat = null where id = ?",
    ).run(error ? "failed" : "done", text, error, !error && typeof code === "string" ? code : null, at, id);
    this.db.prepare("delete from turn_audio where turn = ?").run(id);
    this.db.prepare("update chats set updated = ? where id = ?").run(at, t.chat);
    this.publish(t.chat, "turn", {
      turn: id,
      state: error ? "failed" : "done",
      node,
      ...(error ? { error } : {}),
    });
    if (!error) this.publish(t.chat, "done", { turn: id, a: text, ...(code !== undefined ? { code } : {}) });
    const title = (this.db.prepare("select title from chats where id = ?").get(t.chat) as { title: string }).title;
    const first = (error ?? text).trim().split("\n")[0].slice(0, 140);
    try {
      this.o.notify?.({ chat: t.chat, turn: id, title, body: first, failed: !!error });
    } catch { /* a push that cannot be made never undoes the turn */ }
  }

  /** The state of the chat's unfinished turns, for a client that has just connected. */
  open(chat: string): Record<string, unknown>[] {
    return this.turns(chat).filter((t) => t.state === "waiting" || t.state === "running").map((t) => ({
      turn: t.id,
      state: t.state,
      node: t.node,
    }));
  }
}

/** The body of a request, read up to `max` bytes: more is refused before it is all in memory. */
export async function readLimited(req: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new ChatError("the request is too large", 413);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new ChatError("the request is too large", 413);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) (out.set(c, at), at += c.byteLength);
  return out;
}

/** A voice note's form (multipart: `audio`, `chat?`, `node?`), parsed within the size limit. */
export async function readVoiceForm(
  req: Request,
): Promise<{ audio: { type: string; data: Uint8Array }; chat?: string; node?: string }> {
  const type = req.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(type)) throw new ChatError("a multipart form is expected", 415);
  const bytes = await readLimited(req, MAX_AUDIO + 64 * 1024);
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { "content-type": type } }).formData();
  } catch {
    throw new ChatError("not a valid multipart form");
  }
  const a = form.get("audio");
  if (!(a instanceof File)) throw new ChatError("audio is the recording");
  const field = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" && v ? v : undefined;
  };
  return {
    audio: { type: a.type, data: new Uint8Array(await a.arrayBuffer()) },
    chat: field("chat"),
    node: field("node"),
  };
}

/** `DELETE /api/nodes/<name>`: a machine forgotten. The node and what waits on it go, the turns it held go back
 *  to waiting, and its personal tokens are revoked (`revoke` returns how many), so it cannot come back unpaired. */
export function forgetNode(
  fleet: Fleet,
  chats: Chats,
  revoke: (node: string) => number,
  name: string,
): { node: boolean; turns: number; tokens: number } {
  const node = fleet.forget(name);
  const turns = chats.releaseNode(name);
  return { node, turns, tokens: revoke(name) };
}

export function forgetRoute(
  req: Request,
  u: URL,
  fleet: Fleet,
  chats: Chats,
  revoke: (node: string) => number,
): Response | null {
  const m = u.pathname.match(/^\/api\/nodes\/([^/]{1,64})$/);
  if (!m || req.method !== "DELETE") return null;
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  let name: string;
  try {
    name = decodeURIComponent(m[1]);
  } catch {
    return json({ error: "not a node name" }, 400);
  }
  if (!validNodeName(name)) return json({ error: "not a node name" }, 400);
  const r = forgetNode(fleet, chats, revoke, name);
  if (!r.node && !r.tokens && !r.turns) return json({ error: "no such node" }, 404);
  return json({ ok: true, ...r });
}

/** The chats' routes, for a caller signed in to the account. `node`: the machine whose token it is (null for a web
 *  session or any other token). Null when the path is not theirs. */
export async function chatRoute(
  req: Request,
  u: URL,
  node: string | null,
  chats: Chats,
  hub: ChatHub,
  user: string,
): Promise<Response | null> {
  const p = u.pathname;
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  const body = async () => {
    const b = await req.json().catch(() => null);
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new ChatError("a JSON object is expected");
    return b as Record<string, unknown>;
  };
  const nodeOnly = () => {
    if (!node) throw new ChatError("only a machine's own token answers turns", 403);
    return node;
  };
  const m = req.method;
  try {
    if (p === "/api/chats" && m === "GET") return json({ chats: chats.list() });
    if (p === "/api/chats" && m === "POST") {
      const b = await body();
      return json(chats.post(b.text, b.chat, b.node));
    }
    if (p === "/api/chats/voice" && m === "POST") {
      const f = await readVoiceForm(req);
      return json(chats.postVoice(f.audio, f.chat, f.node));
    }
    const one = p.match(/^\/api\/chats\/([\w-]{1,64})$/);
    if (one && m === "GET") {
      const c = chats.get(one[1]);
      return c ? json({ chat: c }) : json({ error: "no such chat" }, 404);
    }
    if (one && m === "PATCH") return json({ chat: chats.rename(one[1], (await body()).title) });
    if (one && m === "DELETE") return chats.remove(one[1]) ? json({ ok: true }) : json({ error: "no such chat" }, 404);
    const ev = p.match(/^\/api\/chats\/([\w-]{1,64})\/events$/);
    if (ev && m === "GET") {
      if (!chats.get(ev[1])) return json({ error: "no such chat" }, 404);
      return stream(req, hub, user, ev[1], chats.open(ev[1]));
    }
    if (p === "/api/node/turns" && m === "GET") {
      const me = nodeOnly();
      const wait = Math.max(0, Math.min(25, Number(u.searchParams.get("wait")) || 0));
      const max = Number(u.searchParams.get("max")) || 1;
      const end = Date.now() + wait * 1000;
      for (;;) {
        const w = hub.waiter(user, req.signal);
        const turns = chats.claim(me, max);
        if (turns.length || Date.now() >= end || req.signal.aborted) {
          w.cancel();
          return json({ turns });
        }
        await w.wait(Math.min(end - Date.now(), 5000));
        w.cancel();
      }
    }
    const cx = p.match(/^\/api\/turns\/([\w-]{1,64})\/cancel$/);
    if (cx && m === "POST") return json({ ok: true, state: chats.cancel(cx[1]) });
    const au = p.match(/^\/api\/turns\/([\w-]{1,64})\/audio$/);
    if (au && m === "GET") {
      const a = chats.audio(au[1], nodeOnly());
      return new Response(a.data, { headers: { "content-type": a.type, "cache-control": "no-store" } });
    }
    const t = p.match(/^\/api\/turns\/([\w-]{1,64})\/(events|done)$/);
    if (t && m === "POST") {
      const me = nodeOnly(), b = await body();
      if (t[2] === "events") chats.events(t[1], me, b.events);
      else chats.done(t[1], me, b);
      return json({ ok: true });
    }
    if (p === "/api/settings/orchestrator" && m === "GET") {
      const o = chats.orchestrator();
      return json({ ...o });
    }
    if (p === "/api/settings/orchestrator" && m === "PUT") return json(chats.setOrchestrator(await body()));
  } catch (e) {
    if (e instanceof ChatError) return json({ ...e.extra, error: e.message }, e.status);
    throw e;
  }
  return null;
}

/** A Server-Sent Events response following one chat; a comment every 20 s keeps it open. */
function stream(req: Request, hub: ChatHub, user: string, chat: string, open: Record<string, unknown>[]): Response {
  const enc = new TextEncoder();
  let off: (() => void) | null = null, beat: ReturnType<typeof setInterval> | undefined;
  const end = () => {
    off?.();
    off = null;
    clearInterval(beat);
  };
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const send = (s: string) => {
        try {
          c.enqueue(enc.encode(s));
        } catch {
          end();
        }
      };
      send(": connected\n\n");
      for (const t of open) send(`event: turn\ndata: ${JSON.stringify(t)}\n\n`);
      off = hub.subscribe(user, chat, (e) => send(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
      beat = setInterval(() => send(": \n\n"), KEEPALIVE_MS);
      req.signal.addEventListener("abort", () => {
        end();
        try {
          c.close();
        } catch { /* already closed */ }
      });
    },
    cancel: end,
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    },
  });
}

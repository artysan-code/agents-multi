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
const MAX_ANSWER = 200_000;
const MAX_ACTS = 200;
const HISTORY = 10;
const KEEPALIVE_MS = 20_000;

export type TurnState = "waiting" | "running" | "done" | "failed";
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
}
export type NodeEvent =
  | { t: "text"; d: string }
  | { t: "tool"; k: string; n: string; d?: string }
  | { t: "session"; id: string };

export interface SseEvent {
  event: "turn" | "text" | "act" | "done";
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
  constructor(message: string, readonly status = 400) {
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
          titleFrom(text),
          at,
          at,
        );
      }
      this.db.prepare("insert into chat_turns (id, chat, q, created, pin) values (?, ?, ?, ?, ?)").run(
        `u-${this.newId()}`,
        id,
        text,
        at,
        pin ? String(pin) : null,
      );
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

  // ---------------------------------------------------------------- the node's side

  /** Turns claimed by a node silent for 90 s go back to waiting, from the top. */
  reclaim(): number {
    const lost = this.db.prepare("select id, chat from chat_turns where state = 'running' and beat < ?").all(
      this.now() - RECLAIM_MS,
    ) as unknown as { id: string; chat: string }[];
    if (!lost.length) return 0;
    const reset = this.db.prepare(
      "update chat_turns set state = 'waiting', node = null, beat = null, a = '', acts = '[]', session = null where id = ?",
    );
    for (const t of lost) {
      reset.run(t.id);
      this.publish(t.chat, "turn", { turn: t.id, state: "waiting", node: null });
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
    const rows = this.db.prepare(
      `select * from chat_turns t where t.state = 'waiting'
         and (t.pin = ? or (t.pin is null and ?))
         and not exists (select 1 from chat_turns r where r.chat = t.chat and r.state = 'running')
         and t.rowid = (select min(w.rowid) from chat_turns w where w.chat = t.chat and w.state = 'waiting')
       order by t.rowid limit ?`,
    ).all(node, this.answers(node) ? 1 : 0, Math.max(1, Math.min(20, max))) as unknown as TurnRow[];
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
    return t;
  }

  /** What the answer has so far: relayed to the chat's streams and kept. An empty list is a heartbeat. */
  events(id: string, node: string, events: unknown): void {
    const t = this.mine(id, node);
    if (!Array.isArray(events) || events.length > 500) throw new ChatError("events is a list");
    let a = t.a, session = t.session;
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
      } else throw new ChatError("an event is text, tool or session");
    }
    this.db.prepare("update chat_turns set a = ?, acts = ?, session = ?, beat = ? where id = ?").run(
      a,
      JSON.stringify(acts),
      session,
      this.now(),
      id,
    );
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
    const one = p.match(/^\/api\/chats\/([\w-]{1,64})$/);
    if (one && m === "GET") {
      const c = chats.get(one[1]);
      return c ? json({ chat: c }) : json({ error: "no such chat" }, 404);
    }
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
    if (e instanceof ChatError) return json({ error: e.message }, e.status);
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

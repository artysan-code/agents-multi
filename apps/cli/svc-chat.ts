// svc-chat.ts — the console's Chat on the service (ADR 0014, G1b). With a brain account and this machine a node of it,
// the Chat page lists and opens the service's chats and a question becomes a turn pinned to this machine
// (`POST /api/chats {text, chat?, node}`); the chat's Server-Sent Events are relayed to the page as the NDJSON it reads
// from /api/ask today (`Out` in ask.ts), so the page changes little and a conversation is the same on the phone.
// Without a brain account, without a node token of its own or when the service does not answer, the chats are the
// local ones (chats.ts) as before. A chat's id says where it lives: a UUID is a local file, anything else the service's.

import type { Act, Chat, ChatHead, Turn } from "./chats.ts";
import { CHAT_ID } from "./chats.ts";
import type { Out } from "./ask.ts";
import { loadNodeConfig } from "../../shared/mcp/lib/headless.ts";
import { CONFIG } from "./lib/paths.ts";
import { nodeName } from "./node/facts.ts";
import { readNodeToken, type Service, service } from "./node/service.ts";

// ---------------------------------------------------------------- what the service says (chat.ts of the brain)

/** `GET /api/chats` rows. */
export interface SvcSummary {
  id: string;
  title: string;
  updated: string;
  node: string | null;
  turns?: number;
}
/** A turn of `GET /api/chats/<id>`. */
export interface SvcTurn {
  id: string;
  q: string;
  a: string;
  acts: Act[];
  state: "waiting" | "running" | "done" | "failed";
  node: string | null;
  error: string | null;
  code?: string;
  created: string;
  ended: string | null;
}

/** Pure: whether a chat id is a local file's (a UUID) rather than the service's. */
export const isLocalChat = (id: string): boolean => CHAT_ID.test(id);

/** Pure: a service chat as the list shows it. A service that does not count turns says 0, which the page reads as
 *  nothing new to fetch until `updated` moves. */
export const headOf = (c: SvcSummary): ChatHead => ({
  id: c.id,
  title: c.title,
  updated: c.updated,
  turns: c.turns ?? 0,
});

/** Pure: a service turn as the page keeps one. */
export const turnOf = (t: SvcTurn): Turn => ({
  q: t.q,
  a: t.a,
  acts: t.acts ?? [],
  ...(t.error ? { error: t.error } : {}),
  ...(t.code ? { code: t.code } : {}),
  at: t.created,
});

/** Pure: a service chat as the page opens it (no Claude session of its own: the service keeps it with the turn). */
export function chatOf(c: { id: string; title: string; turns: SvcTurn[] }): Chat {
  const last = c.turns.at(-1);
  const created = c.turns[0]?.created ?? "";
  return {
    id: c.id,
    title: c.title,
    created,
    updated: last?.ended ?? last?.created ?? created,
    session: null,
    turns: c.turns.map(turnOf),
  };
}

// ---------------------------------------------------------------- Server-Sent Events -> NDJSON

export interface Sse {
  event: string;
  data: Record<string, unknown>;
}

/** Reads Server-Sent Events from chunks of text as they arrive: `event:` and `data:` lines, a blank line ends one;
 *  comments (the service's keep-alives) and anything that is not JSON are dropped. */
export class SseParser {
  private rest = "";
  push(chunk: string): Sse[] {
    this.rest += chunk;
    const out: Sse[] = [];
    for (let i = this.rest.search(/\r?\n\r?\n/); i >= 0; i = this.rest.search(/\r?\n\r?\n/)) {
      const block = this.rest.slice(0, i);
      this.rest = this.rest.slice(i).replace(/^\r?\n\r?\n/, "");
      let event = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(":")) continue;
        const m = line.match(/^(\w+):? ?(.*)$/);
        if (m?.[1] === "event") event = m[2];
        else if (m?.[1] === "data") data.push(m[2]);
      }
      if (!data.length) continue;
      try {
        const d = JSON.parse(data.join("\n"));
        if (d && typeof d === "object" && !Array.isArray(d)) out.push({ event, data: d as Record<string, unknown> });
      } catch { /* not ours */ }
    }
    return out;
  }
}

type Done = Extract<Out, { t: "done" }>;

/** Pure: what one event of the chat's stream means to the page, for the turn `turn`: the lines to send, and `end`
 *  when it was the turn's last (`done`, or `failed`). Events of other turns say nothing. */
export function relay(e: Sse, turn: string): { out: Out[]; end: boolean } {
  const d = e.data;
  if (d.turn !== turn) return { out: [], end: false };
  const str = (v: unknown) => typeof v === "string" ? v : "";
  switch (e.event) {
    case "text":
      return str(d.d) ? { out: [{ t: "text", d: str(d.d) }], end: false } : { out: [], end: false };
    case "act":
      return {
        out: [{
          t: "tool",
          k: str(d.k) as Extract<Out, { t: "tool" }>["k"],
          n: str(d.n),
          ...(str(d.d) ? { d: str(d.d) } : {}),
        }],
        end: false,
      };
    case "done":
      return { out: [{ t: "done", text: str(d.a), code: str(d.code) || null }], end: true };
    case "turn":
      if (d.state === "failed") {
        return { out: [{ t: "done", text: "", code: null, error: str(d.error) || "the turn failed" }], end: true };
      }
      return { out: [], end: false };
  }
  return { out: [], end: false };
}

/** Pure: the end of a turn already over when the stream was opened (a fast answer finished before the events were
 *  followed), from the chat as the service keeps it; null while it goes on. */
export function endedTurn(t: SvcTurn | undefined): Done | null {
  if (!t) return null;
  if (t.state === "done") return { t: "done", text: t.a, code: t.code ?? null };
  if (t.state === "failed") return { t: "done", text: "", code: null, error: t.error || "the turn failed" };
  return null;
}

// ---------------------------------------------------------------- this console and the service

/** Pure: the service's address for a route that only reads, with the id cleaned for a path. */
const chatPath = (id: string) => `/api/chats/${encodeURIComponent(id)}`;

/** How long a service that failed is left alone before the next try: the page keeps working on local chats. */
export const DOWN_MS = 20_000;
const READ_TIMEOUT = 5_000;
const FOLLOW_MS = 30 * 60_000;

export interface ChatsIO {
  /** the service as this node, or null when the console's chat stays local */
  service: () => Promise<{ svc: Service; node: string } | null>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The default: a brain account, a node token of its own (what makes this machine a node) and the node turned on —
 *  only then does a pinned turn have this machine's loop to take it. */
async function nodeService(): Promise<{ svc: Service; node: string } | null> {
  const cfg = await loadNodeConfig(CONFIG);
  if (!cfg.enabled || !(await readNodeToken())) return null;
  const svc = await service(fetch, { node: true });
  return typeof svc === "string" ? null : { svc, node: nodeName(cfg) };
}

export class ServiceChats {
  private downUntil = 0;
  constructor(private io: ChatsIO = { service: nodeService }) {}

  private now = () => (this.io.now ?? Date.now)();
  private sleep = (ms: number) => this.io.sleep?.(ms) ?? new Promise<void>((r) => setTimeout(r, ms));

  /** The service to use now, or null (not configured, or it failed lately). */
  private async up(): Promise<{ svc: Service; node: string } | null> {
    if (this.now() < this.downUntil) return null;
    return await this.io.service().catch(() => null);
  }
  private failed() {
    this.downUntil = this.now() + DOWN_MS;
  }

  /** The service's chats as list rows, or null when the console's chat is local only (or the service failed). */
  async list(): Promise<ChatHead[] | null> {
    const s = await this.up();
    if (!s) return null;
    try {
      const r = await s.svc.call<{ chats: SvcSummary[] }>("GET", "/api/chats", undefined, { timeout: READ_TIMEOUT });
      return r.chats.map(headOf);
    } catch {
      this.failed();
      return null;
    }
  }

  /** One service chat in full; null when it is not there or the service did not answer. */
  async get(id: string): Promise<Chat | null> {
    const s = await this.up();
    if (!s) return null;
    try {
      const r = await s.svc.call<{ chat: { id: string; title: string; turns: SvcTurn[] } }>(
        "GET",
        chatPath(id),
        undefined,
        { timeout: READ_TIMEOUT },
      );
      return chatOf(r.chat);
    } catch (e) {
      if (!/not found|no such chat|404/.test((e as Error).message)) this.failed();
      return null;
    }
  }

  async remove(id: string): Promise<boolean> {
    const s = await this.up();
    if (!s) return false;
    try {
      await s.svc.call("DELETE", chatPath(id), undefined, { timeout: READ_TIMEOUT });
      return true;
    } catch {
      return false;
    }
  }

  /** A question as a turn pinned to this machine, and its answer followed as NDJSON lines. Null when the question
   *  should be asked locally instead: the service is not there, or would not take a new chat. A turn in a chat the
   *  service already has that fails is an error line, not a local answer: the conversation is there. */
  async ask(
    text: string,
    chat: string | null,
    signal: AbortSignal,
    saved: () => void = () => {},
  ): Promise<ReadableStream<Uint8Array> | null> {
    const s = await this.up();
    if (!s) return null;
    let made: { chat: SvcSummary | string; turn: SvcTurn | string };
    try {
      made = await s.svc.call("POST", "/api/chats", { text, ...(chat ? { chat } : {}), node: s.node }, {
        timeout: 10_000,
      });
    } catch (e) {
      this.failed();
      return chat ? this.refusal(chat, (e as Error).message) : null;
    }
    const id = typeof made.chat === "string" ? made.chat : made.chat.id;
    const turn = typeof made.turn === "string" ? made.turn : made.turn.id;
    return this.follow(s.svc, id, turn, signal, saved);
  }

  private refusal(chat: string, message: string): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(JSON.stringify({ t: "chat", id: chat } satisfies Out) + "\n"));
        c.enqueue(enc.encode(JSON.stringify({ t: "done", text: "", code: null, error: message } satisfies Out) + "\n"));
        c.close();
      },
    });
  }

  /** The chat's events, mapped to the page's lines until the turn ends. A stream that drops is opened again; the
   *  chat as stored settles a turn that ended meanwhile. The page going away stops the following, not the turn. */
  private follow(
    svc: Service,
    chat: string,
    turn: string,
    signal: AbortSignal,
    saved: () => void,
  ): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    const stop = new AbortController();
    const quit = () => stop.abort();
    signal.addEventListener("abort", quit, { once: true });
    return new ReadableStream<Uint8Array>({
      start: async (ctl) => {
        const send = (o: Out) => {
          try {
            ctl.enqueue(enc.encode(JSON.stringify(o) + "\n"));
          } catch { /* the page went away */ }
        };
        send({ t: "chat", id: chat });
        const until = this.now() + FOLLOW_MS;
        let finished = false;
        try {
          while (!finished && !stop.signal.aborted && this.now() < until) {
            finished = await this.watch(svc, chat, turn, stop.signal, send);
            if (!finished && !stop.signal.aborted) await this.sleep(1000);
          }
          if (!finished && !stop.signal.aborted) {
            send({ t: "done", text: "", code: null, error: "the answer did not arrive in time: the chat keeps it" });
          }
        } finally {
          saved();
          signal.removeEventListener("abort", quit);
          try {
            ctl.close();
          } catch { /* already closed */ }
        }
      },
      cancel: quit,
    });
  }

  /** One connection to the chat's events; true when the turn ended in it (or was already over). */
  private async watch(
    svc: Service,
    chat: string,
    turn: string,
    signal: AbortSignal,
    send: (o: Out) => void,
  ): Promise<boolean> {
    if (!svc.stream) throw new Error("this service connection cannot stream");
    let res: Response;
    try {
      res = await svc.stream(`${chatPath(chat)}/events`, signal);
    } catch {
      return await this.settled(svc, chat, turn, signal, send);
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      return await this.settled(svc, chat, turn, signal, send);
    }
    // the answer may have finished before the stream was open: look at the chat once it is
    if (await this.settled(svc, chat, turn, signal, send)) {
      await res.body.cancel().catch(() => {});
      return true;
    }
    const parser = new SseParser();
    try {
      for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
        for (const e of parser.push(chunk)) {
          const r = relay(e, turn);
          r.out.forEach(send);
          if (r.end) {
            await res.body.cancel().catch(() => {});
            return true;
          }
        }
      }
    } catch { /* the stream dropped: the caller opens it again */ }
    return false;
  }

  /** Whether the chat, as stored, says our turn is over; sends its end when so. */
  private async settled(
    svc: Service,
    chat: string,
    turn: string,
    signal: AbortSignal,
    send: (o: Out) => void,
  ): Promise<boolean> {
    try {
      const r = await svc.call<{ chat: { turns: (SvcTurn & { id: string })[] } }>("GET", chatPath(chat), undefined, {
        timeout: READ_TIMEOUT,
        signal,
      });
      const end = endedTurn(r.chat.turns.find((t) => t.id === turn));
      if (end) send(end);
      return !!end;
    } catch {
      return false;
    }
  }
}

/** The one this console uses. */
export const serviceChats = new ServiceChats();

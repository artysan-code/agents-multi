// store.ts — the Chat page's state, kept outside the page so an answer goes on while another view is on
// screen: the list of chats, the one open, and the answer being written. The server keeps every chat
// (apps/cli/chats.ts): the page holds a copy, read again when the `chats` topic moves.

import { signal } from "@preact/signals";
import { askStream, get, post, type Result } from "../../api.ts";
import { t, tk } from "../../i18n.ts";
import type { SparkMode } from "../../lib/claude.tsx";

/** A tool Claude called: its kind (tasks, calendar…), its name, and for a change what it was on. */
export interface Act {
  k: string;
  n: string;
  d?: string;
}

/** One request and its answer, as the server keeps it. */
export interface Turn {
  q: string;
  a: string;
  acts: Act[];
  error?: string;
  code?: string;
  model?: string;
  at: string;
}

export interface ChatHead {
  id: string;
  title: string;
  updated: string;
  turns: number;
}

interface Open {
  /** null: a new chat, not asked anything yet */
  id: string | null;
  title: string;
  session: string | null;
  turns: Turn[];
}

/** The answer being written: its chat, what was asked, and what has come so far. */
export interface Live {
  chat: string | null;
  q: string;
  a: string;
  acts: Act[];
  state: SparkMode;
  /** what the status line says while Claude works */
  doing: string;
}

const EMPTY: Open = { id: null, title: "", session: null, turns: [] };

export const chats = signal<ChatHead[] | null>(null);
export const current = signal<Open>(EMPTY);
export const live = signal<Live | null>(null);
/** Puts the cursor in the composer: a new chat, a suggestion taken. */
export const focusComposer = signal(0);

let busy: AbortController | null = null;
const CODE = /\[\[code:[^\]]*\]\]/g;

export async function loadChats(): Promise<void> {
  chats.value = await get<ChatHead[]>("/api/chats").catch(() => chats.value ?? []);
}

/** Opens a chat; the answer being written, if any, goes on and shows again when its chat is open. */
export async function openChat(id: string): Promise<void> {
  const c = await get<Open & { id: string }>(`/api/chat?id=${encodeURIComponent(id)}`);
  current.value = { id: c.id, title: c.title, session: c.session, turns: c.turns };
}

/** Reads the open chat again when another window (Hey) added to it; never under an answer being written. */
export async function syncOpen(): Promise<void> {
  const c = current.value;
  if (!c.id || live.value?.chat === c.id) return;
  const n = chats.value?.find((h) => h.id === c.id)?.turns;
  if (n === undefined) {
    // forgotten elsewhere
    current.value = EMPTY;
    return;
  }
  if (n !== c.turns.length) await openChat(c.id).catch(() => {});
}

export function newChat(): void {
  current.value = EMPTY;
  focusComposer.value++;
}

export async function forget(id: string): Promise<Result> {
  const r = await post<Result>("/api/chats", { op: "delete", id }).catch((e: Error): Result => ({ ok: false, message: e.message }));
  if (current.value.id === id) newChat();
  await loadChats();
  return r;
}

/** Stops the answer being written; what came so far is kept. */
export function stop(): void {
  busy?.abort();
}

export const answering = () => busy !== null;

/** Sends `text` in the open chat (a new one when none is), streaming the answer into `live`. */
export async function send(text: string): Promise<void> {
  if (busy || !text.trim()) return;
  const ctl = busy = new AbortController();
  const start = current.value;
  let chat = start.id, a = "", frame = 0;
  const acts: Act[] = [];
  let l: Live = { chat, q: text, a: "", acts: [], state: "thinking", doing: t("ask.thinking") };
  live.value = l;
  const paint = () => {
    frame = 0;
    live.value = l = { ...l, a: a.replace(CODE, "") };
  };
  let done: Turn = { q: text, a: "", acts, at: new Date().toISOString() };
  try {
    await askStream(text, chat, ctl.signal, (o) => {
      if (o.t === "chat") {
        chat = o.id;
        live.value = l = { ...l, chat };
        // a new chat takes its id while the page still shows it
        if (current.value === start && !start.id) current.value = { ...start, id: chat, title: text.split("\n")[0] };
      } else if (o.t === "session") {
        if (current.value.id === chat) current.value = { ...current.value, session: o.id };
      } else if (o.t === "text") {
        a += o.d;
        if (l.state !== "writing") live.value = l = { ...l, state: "writing" };
        if (!frame) frame = requestAnimationFrame(paint);
      } else if (o.t === "tool") {
        acts.push(o.d ? { k: o.k, n: o.n, d: o.d } : { k: o.k, n: o.n });
        live.value = l = { ...l, acts: [...acts], state: "thinking", doing: tk(`ask.tool.${o.k}`) };
      } else if (o.t === "done") {
        done = {
          ...done,
          a: o.error ? "" : o.text,
          ...(o.error ? { error: o.error } : {}),
          ...(o.code ? { code: o.code } : {}),
        };
      }
    });
  } catch (err) {
    const e = err as Error;
    done = e.name === "AbortError"
      ? { ...done, a: a.replace(CODE, "").trim() }
      : { ...done, a: a.replace(CODE, "").trim(), error: e.message };
  }
  if (frame) cancelAnimationFrame(frame);
  busy = null;
  live.value = null;
  // the turn shows at once in its chat, before the server's copy is read back; a request refused before
  // it had a chat shows where it was asked
  if ((chat && current.value.id === chat) || (!chat && current.value === start)) {
    current.value = { ...current.value, turns: [...current.value.turns, done] };
  }
  void loadChats();
}

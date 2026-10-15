// api.ts — what the web app asks of the service (ADR 0014, «The API»): same origin, the session cookie, JSON.
// It talks to nothing else. A 401 is a session that ended: back to the sign-in, which returns here.

import type { ChatHead, Turn } from "./lib.ts";

const SIGN_IN = "/account?next=/app";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  if (res.status === 401) {
    location.assign(SIGN_IN);
    throw new ApiError(401, "signed out");
  }
  const body = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `${res.status}`);
  return body;
}

const send = (method: string, path: string, body?: unknown) =>
  call<Record<string, unknown>>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

// ---- chat
export const listChats = () => call<{ chats: ChatHead[] }>("/api/chats").then((r) => r.chats);
export const getChat = (id: string) =>
  call<{ chat: { id: string; title: string; turns: Turn[] } }>(`/api/chats/${encodeURIComponent(id)}`).then((r) => r.chat);
/** A turn written: the contract says `{chat, turn}`, the chat's id or the chat itself; the id is what is kept. */
export async function sendTurn(text: string, chat?: string): Promise<{ chat: string; turn: string }> {
  const r = await send("POST", "/api/chats", chat ? { text, chat } : { text }) as { chat: string | { id: string }; turn: unknown };
  const id = typeof r.chat === "string" ? r.chat : r.chat.id;
  return { chat: id, turn: typeof r.turn === "string" ? r.turn : String((r.turn as { id?: string })?.id ?? "") };
}
export const deleteChat = (id: string) => send("DELETE", `/api/chats/${encodeURIComponent(id)}`);
export const eventsOf = (id: string) => new EventSource(`/api/chats/${encodeURIComponent(id)}/events`);

// ---- tasks: the files the service keeps; «done» goes through the board's own route, where the rules run
export const taskFiles = () => call<{ tasks: string[] }>("/api/tasks").then((r) => r.tasks);
export async function markDone(id: string): Promise<void> {
  const res = await fetch(`/tasks/${encodeURIComponent(id)}/status`, {
    method: "POST",
    credentials: "same-origin",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ status: "done" }),
  });
  // the board answers a change with a redirect to its page: the browser hides it (opaqueredirect)
  if (res.status === 401) location.assign(SIGN_IN);
  if (!res.ok && res.type !== "opaqueredirect") throw new ApiError(res.status, `${res.status}`);
}

// ---- brain
export interface Hit {
  path: string;
  title: string;
  excerpt: string;
}
export interface Page {
  path: string;
  title: string;
  body: string;
  updated: string;
}
export const searchBrain = (q: string) =>
  call<{ results: Hit[] }>(`/api/brain/search?q=${encodeURIComponent(q)}&limit=20`).then((r) => r.results);
export const readPage = (path: string) => call<Page>(`/api/brain/page?path=${encodeURIComponent(path)}`);

// ---- machines
export const loadNodes = () => call<{ nodes: import("./lib.ts").NodeInfo[]; now: string }>("/api/nodes");
export interface Orchestrator {
  node: string | null;
  order: string[];
}
export const getOrchestrator = () => call<Orchestrator>("/api/settings/orchestrator");
export const setOrchestrator = (o: Orchestrator) => send("PUT", "/api/settings/orchestrator", o);

// ---- push
export const pushKey = () => call<{ key: string }>("/api/push/key").then((r) => r.key);
export const subscribePush = (s: { endpoint: string; keys: { p256dh: string; auth: string }; device: string }) =>
  send("POST", "/api/push/subscriptions", s);
export const unsubscribePush = (endpoint: string) => send("DELETE", "/api/push/subscriptions", { endpoint });

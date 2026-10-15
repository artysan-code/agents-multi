// api.ts — what the web app asks of the service (ADR 0014, «The API»): same origin, the session cookie, JSON.
// It talks to nothing else. A 401 is a session that ended: back to the sign-in, which returns here.

import type { ChatHead, Passkey, Turn, WaitingState } from "./lib.ts";
import type { Assertion, Verdict } from "./webauthn-core.ts";

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
/** A turn written: the contract says `{chat, turn}`, both objects as `GET` gives them; the chat's id and the turn
 *  (null when the service sent only its id) are what is kept. */
export async function sendTurn(text: string, chat?: string, node?: string): Promise<{ chat: string; turn: Turn | null }> {
  const r = await send("POST", "/api/chats", { text, ...(chat ? { chat } : {}), ...(node ? { node } : {}) }) as {
    chat: string | { id: string };
    turn: Turn | string;
  };
  const id = typeof r.chat === "string" ? r.chat : r.chat.id;
  const turn = r.turn && typeof r.turn === "object" ? { ...r.turn, acts: r.turn.acts ?? [], a: r.turn.a ?? "" } : null;
  return { chat: id, turn };
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

// ---- pairing a machine (G4): the code first shows which machine asks; only a confirmed claim makes it a node
export interface PairPreview {
  node: string;
  platform: string;
  asked: string;
}
export const previewPairing = (code: string) =>
  send("POST", "/api/pair/claim", { code }) as Promise<{ preview: PairPreview }>;
export const claimPairing = (code: string) =>
  send("POST", "/api/pair/claim", { code, confirm: true }) as Promise<{ node: string }>;

// ---- what waits (G5)
export const loadWaiting = () => call<WaitingState>("/api/waiting");
export const answerRequest = (id: string, body: { verdict: Verdict; answers?: Record<string, string>; expires: string; assertion: Assertion }) =>
  send("POST", `/api/waiting/${encodeURIComponent(id)}`, body);
export const acceptJob = (id: string, expires: string, assertion: Assertion) =>
  send("POST", `/api/jobs/${encodeURIComponent(id)}`, { op: "accept", expires, assertion });
export const declineJob = (id: string) => send("POST", `/api/jobs/${encodeURIComponent(id)}`, { op: "decline" });

// ---- passkeys (G5)
export const listPasskeys = () => call<Passkey[] | { passkeys: Passkey[] }>("/api/passkeys").then((r) => (Array.isArray(r) ? r : r.passkeys));
export const passkeyOptions = () => send("POST", "/api/passkeys/options");
export const addPasskey = (name: string, credential: Record<string, unknown>) =>
  send("POST", "/api/passkeys", { name, credential }) as Promise<{ id: string; state: string }>;
export const revokePasskey = (id: string) => send("DELETE", `/api/passkeys/${encodeURIComponent(id)}`);

export interface PageHead {
  path: string;
  title: string;
  area?: string;
  updated: string;
}
/** The most recently changed pages, newest first (the service lists them all; the phone shows the first few). */
export const loadPages = () => call<{ pages: PageHead[] }>("/api/brain/pages").then((r) => r.pages.slice(0, 12));

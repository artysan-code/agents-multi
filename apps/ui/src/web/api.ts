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
    // a FormData body sets its own content type, with the boundary
    headers: { accept: "application/json", ...(init.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : {}) },
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
type Sent = { chat: string | { id: string }; turn: Turn | string };

/** The `{chat, turn}` a write answers: the contract says both are objects as `GET` gives them; the chat's id and
 *  the turn (null when the service sent only its id) are what is kept. */
function sentOf(r: Sent): { chat: string; turn: Turn | null } {
  const id = typeof r.chat === "string" ? r.chat : r.chat.id;
  const turn = r.turn && typeof r.turn === "object" ? { ...r.turn, acts: r.turn.acts ?? [], a: r.turn.a ?? "", q: r.turn.q ?? "" } : null;
  return { chat: id, turn };
}
export async function sendTurn(text: string, chat?: string, node?: string): Promise<{ chat: string; turn: Turn | null }> {
  return sentOf(await send("POST", "/api/chats", { text, ...(chat ? { chat } : {}), ...(node ? { node } : {}) }) as Sent);
}
/** A voice note: multipart with the audio, the chat and the machine to pin it to. The turn has `voice: true` and no
 *  words until a machine that can transcribe has heard it. */
export async function sendVoice(audio: Blob, ext: string, chat?: string, node?: string): Promise<{ chat: string; turn: Turn | null }> {
  const form = new FormData();
  form.append("audio", audio, `voice.${ext}`);
  if (chat) form.append("chat", chat);
  if (node) form.append("node", node);
  const r = sentOf(await call<Sent>("/api/chats/voice", { method: "POST", body: form }));
  return r.turn ? { ...r, turn: { ...r.turn, voice: true } } : r;
}
export const renameChat = (id: string, title: string) => send("PATCH", `/api/chats/${encodeURIComponent(id)}`, { title });
/** Cancels a turn: a waiting one at once, a running one when its machine next reports. */
export const cancelTurn = (id: string) => send("POST", `/api/turns/${encodeURIComponent(id)}/cancel`);
/** `keepalive`: a delete that was waiting out its Undo still goes when the page is closing. */
export const deleteChat = (id: string) =>
  call<Record<string, unknown>>(`/api/chats/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true });
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
/** Forgets a machine: the node, what waits on it and its personal tokens go; it must be paired again to come back. */
export const forgetNode = (name: string) => send("DELETE", `/api/nodes/${encodeURIComponent(name)}`);
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
/** Declining is signed as accepting is (ADR 0014, second round): nobody but the owner stops their agents either. */
export const declineJob = (id: string, expires: string, assertion: Assertion) =>
  send("POST", `/api/jobs/${encodeURIComponent(id)}`, { op: "decline", expires, assertion });

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

// ---- the agents of every machine (ADR 0014, third round): the list, its stream, a signed stop, a resume proposal
export const loadRuns = () => call<import("./agents-core.ts").RunsState>("/api/runs");
export const runsEvents = () => new EventSource("/api/runs/events");
const runPath = (node: string, id: string) => `/api/runs/${encodeURIComponent(node)}/${encodeURIComponent(id)}`;
/** A stop is signed with the passkey: the machine checks it before it stops anything. */
export const stopRun = (node: string, id: string, expires: string, assertion: Assertion) =>
  send("POST", `${runPath(node, id)}/stop`, { expires, assertion });
/** Proposes carrying a run on elsewhere (`node`, or the best one free): accepted in Waiting like any job. */
export const resumeRun = (node: string, id: string, to?: string) =>
  send("POST", `${runPath(node, id)}/resume`, to ? { node: to } : {});

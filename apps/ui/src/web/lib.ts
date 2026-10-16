// lib.ts — the web app's pure helpers (ADR 0014): what the chat stream does to a conversation, the day
// groups of the chat list, the task sections, the hash routes, the node order, and the notification
// advice. No DOM and no preact, so apps/brain/tests/webapp_ui_test.ts runs them under Deno.

import { fromFile } from "../../../../shared/mcp/lib/tasks/format.ts";
import type { Task } from "../../../../shared/mcp/lib/tasks/types.ts";
import { isOnline, type NodeInfo } from "../../../../shared/mcp/lib/nodes.ts";

export type { NodeInfo, Task };

// ---------------------------------------------------------------- chats

/** A change Claude made while answering (apps/cli/chats.ts's Act). */
export interface Act {
  k: string;
  n: string;
  d?: string;
}

export type TurnState = "waiting" | "running" | "done" | "failed" | "cancelled";

/** One request and its answer, as GET /api/chats/<id> gives it. */
export interface Turn {
  id: string;
  q: string;
  a: string;
  acts: Act[];
  state: TurnState;
  node: string | null;
  error?: string | null;
  created: string;
  ended?: string | null;
  /** a voice note: `q` is empty until the machine that transcribes it has sent the words */
  voice?: boolean;
}

export interface ChatHead {
  id: string;
  title: string;
  updated: string;
  node: string | null;
}

/** Pure: the turns after one Server-Sent Event of the chat (`turn`, `text`, `act`, `done`, `transcript`), or null when the
 *  event is about a turn this page does not have yet (the caller reads the chat again). */
export function applyEvent(turns: Turn[], name: string, data: Record<string, unknown>): Turn[] | null {
  const i = turns.findIndex((t) => t.id === data.turn);
  if (i < 0) return null;
  const t = turns[i];
  let next: Turn;
  switch (name) {
    case "turn":
      next = {
        ...t,
        state: data.state as TurnState,
        node: typeof data.node === "string" ? data.node : t.node,
        error: typeof data.error === "string" ? data.error : t.error,
      };
      break;
    case "text":
      next = { ...t, a: t.a + String(data.d ?? ""), state: t.state === "waiting" ? "running" : t.state };
      break;
    case "act":
      next = { ...t, acts: [...t.acts, { k: String(data.k), n: String(data.n), ...(data.d ? { d: String(data.d) } : {}) }] };
      break;
    case "done":
      next = {
        ...t,
        a: typeof data.a === "string" ? data.a : t.a,
        state: t.state === "failed" || t.state === "cancelled" ? t.state : "done",
      };
      break;
    case "transcript": {
      // a voice note's words, as the question; the event carries them as `text` (`q` and `d` are read too)
      const words = [data.text, data.q, data.d].find((x) => typeof x === "string") as string | undefined;
      if (words === undefined) return turns;
      next = { ...t, q: words, voice: true };
      break;
    }
    default:
      return turns;
  }
  return turns.map((x, j) => (j === i ? next : x));
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Pure: a date as the day it is on the viewer's clock, `YYYY-MM-DD`. */
export const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export interface DayGroup<T> {
  /** `today`, `yesterday`, or the day itself */
  day: string;
  items: T[];
}

/** Pure: items already newest first, in groups by the day of `when(item)` on the viewer's clock. */
export function groupByDay<T>(items: T[], when: (x: T) => string, now: Date): DayGroup<T>[] {
  const today = localDay(now), yesterday = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const groups: DayGroup<T>[] = [];
  for (const x of items) {
    const d = localDay(new Date(when(x)));
    const day = d === today ? "today" : d === yesterday ? "yesterday" : d;
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(x);
    else groups.push({ day, items: [x] });
  }
  return groups;
}

// ---------------------------------------------------------------- tasks

export interface TaskSections {
  day: string;
  overdue: Task[];
  today: Task[];
  done: Task[];
}

/** Pure: the task files the service returns, as tasks (what is not a task file is left out). */
export const parseTasks = (bodies: string[]): Task[] => bodies.map(fromFile).filter((t): t is Task => t !== null);

const open = (t: Task) => t.status !== "done" && t.status !== "dropped";
const byTime = (a: Task, b: Task) =>
  (a.time ?? "99:99").localeCompare(b.time ?? "99:99") || (a.priority ?? 9) - (b.priority ?? 9);

/** Pure: today with its times first, what is overdue (oldest first), and what was done today. */
export function taskSections(tasks: Task[], now: Date): TaskSections {
  const day = localDay(now);
  return {
    day,
    overdue: tasks.filter((t) => open(t) && t.due && t.due < day).sort((a, b) =>
      a.due!.localeCompare(b.due!) || byTime(a, b)
    ),
    today: tasks.filter((t) => open(t) && t.due === day).sort(byTime),
    done: tasks.filter((t) => t.status === "done" && t.done && localDay(new Date(t.done)) === day).sort((a, b) =>
      b.done!.localeCompare(a.done!)
    ),
  };
}

// ---------------------------------------------------------------- routes

export type View = "chat" | "waiting" | "tasks" | "brain" | "more" | "machines" | "agents";
export interface Route {
  view: View;
  /** a chat's id (`new` for one not started), or a brain page's path */
  id?: string;
}

const VIEWS: View[] = ["chat", "waiting", "tasks", "brain", "more", "machines", "agents"];

/** Pure: the tab a view belongs to (Machines is reached from More). */
export const tabOf = (v: View): View => (v === "machines" ? "more" : v);

/** Pure: the route a location hash names; the chat list when it names nothing known. */
export function parseHash(hash: string): Route {
  const m = hash.replace(/^#\/?/, "").match(/^([a-z]+)(?:\/(.+))?$/);
  if (!m || !VIEWS.includes(m[1] as View)) return { view: "chat" };
  let id: string | undefined;
  try {
    id = m[2] ? decodeURIComponent(m[2]) : undefined;
  } catch {
    id = undefined;
  }
  return id && (m[1] === "chat" || m[1] === "brain") ? { view: m[1] as View, id } : { view: m[1] as View };
}

/** Pure: the hash of a route (the inverse of parseHash). */
export const hashOf = (r: Route) => `#${r.view}${r.id ? `/${encodeURIComponent(r.id)}` : ""}`;

// ---------------------------------------------------------------- machines

export const online = (n: Pick<NodeInfo, "seen">, now: string) => isOnline(n, Date.parse(now));

/** Pure: the order of the nodes the account set, kept for the nodes that still exist, then the others by name. */
export function orderOf(order: string[], names: string[]): string[] {
  const known = order.filter((n, i) => names.includes(n) && order.indexOf(n) === i);
  return [...known, ...names.filter((n) => !known.includes(n)).sort()];
}

/** Pure: the list with the item at `i` moved by `by` places (up is -1); the list itself when it cannot move. */
export function moved<T>(list: T[], i: number, by: number): T[] {
  const j = i + by;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

// ---------------------------------------------------------------- notifications

export type PushAdvice = "install" | "unsupported" | "denied" | "ready";

/** Pure: what the Settings view says about notifications. iOS gives a web page push only once it is added to
 *  the home screen (16.4 and later), and in a Safari tab has no push API at all: say so before anything else. */
export function pushAdvice(env: { hasApi: boolean; ios: boolean; standalone: boolean; permission: string }): PushAdvice {
  if (env.ios && !env.standalone) return "install";
  if (!env.hasApi) return "unsupported";
  return env.permission === "denied" ? "denied" : "ready";
}

/** Pure: whether a user agent is an iPhone or iPad (an iPad asking for the desktop site says it is a Mac, with touch). */
export const isIos = (ua: string, touchPoints = 0) => /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);

/** Pure: a short name for the device, for the list of subscriptions. */
export function deviceName(ua: string, touchPoints = 0): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || isIos(ua, touchPoints)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Linux/.test(ua)) return "Linux";
  return "Browser";
}

/** Pure: the VAPID public key (URL-safe base64) as the bytes the push API takes. */
export function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------- what waits (G5)

/** A request or a question a child of a node waits on (PUT /api/node/requests, read back by GET /api/waiting). */
export interface Waiting {
  /** `<child>/<request>` */
  id: string;
  child: string;
  request: string;
  profile: string;
  project: string;
  kind: "request" | "question";
  what: string;
  questions?: Question[];
  node: string;
}

/** One question of a child's AskUserQuestion. */
export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** A job a node or the service proposed (shared/mcp/lib/nodes.ts's Job, the part the phone shows). */
export interface ProposedJob {
  id: string;
  node: string;
  kind: "routine" | "resume";
  spec: { name: string; repo: string; path: string; action: { kind: string; [k: string]: unknown }; account?: string; id?: string; from?: string };
  status: string;
  reason?: string;
  expires?: string;
  created: string;
  by: string;
}

export interface WaitingState {
  requests: Waiting[];
  jobs: ProposedJob[];
}

/** Pure: how many things wait for the person's yes: the requests, and the jobs still only proposed. */
export const waitingCount = (w: WaitingState | null) =>
  w ? w.requests.length + w.jobs.filter((j) => j.status === "proposed").length : 0;

/** Pure: the passkeys as the phone uses them. A passkey with no endorsement is pending: it cannot say yes yet. */
export interface Passkey {
  id: string;
  name: string;
  publicKey: string;
  endorsement: string | null;
  created: string;
}
export const endorsed = (keys: Passkey[]) => keys.filter((k) => !!k.endorsement);
export const pending = (keys: Passkey[]) => keys.filter((k) => !k.endorsement);

/** Pure: the questions of a request with the answers chosen so far, as the `answers` map of the contract
 *  (question text to the label chosen; several labels joined by a comma for a multi-select). */
export function answersOf(questions: Question[], chosen: Record<string, string[]>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const c = chosen[q.question] ?? [];
    if (!c.length) return null;
    out[q.question] = c.join(", ");
  }
  return out;
}

/** Pure: a chat's turn can be asked again from the same question when it failed or was cancelled. */
export const retryable = (t: Pick<Turn, "state">) => t.state === "failed" || t.state === "cancelled";

/** Pure: a turn the machine is still working on or has yet to take: it can be cancelled. */
export const cancellable = (t: Pick<Turn, "state">) => t.state === "waiting" || t.state === "running";

/** Pure: the chats whose title has every word the person typed (any case, any order); all of them for an empty search. */
export function filterChats<T extends { title: string }>(chats: T[], query: string, untitled = ""): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return chats;
  return chats.filter((c) => {
    const title = (c.title || untitled).toLowerCase();
    return words.every((w) => title.includes(w));
  });
}

/** What a failed passkey call shows: the browser's error name and message as they are, and the key of the hint
 *  for the names a person can do something about. A server's error (not a DOMException) has no name to show. */
export interface Explained {
  name: string | null;
  message: string;
  hint: "NotAllowedError" | "InvalidStateError" | "SecurityError" | "NotSupportedError" | "AbortError" | "ConstraintError" | null;
}
const HINTED = ["NotAllowedError", "InvalidStateError", "SecurityError", "NotSupportedError", "AbortError", "ConstraintError"] as const;

/** Pure: the name, the message and the hint of an error from `navigator.credentials` (`dom`: it is a DOMException). */
export function explainError(e: { name?: string; message?: string }, dom: boolean): Explained {
  const name = dom && e.name ? e.name : null;
  const hint = HINTED.find((h) => h === name) ?? null;
  return { name, message: e.message || name || "error", hint };
}

/** Pure: a short human line for a change Claude made, from its tool name (`tasks_add`, `brain_edit`...). */
export function actKind(n: string): "task" | "brain" | "calendar" | "mail" | "job" | "other" {
  if (n.startsWith("tasks_")) return "task";
  if (n.startsWith("brain_")) return "brain";
  if (n.startsWith("calendar_")) return "calendar";
  if (n.startsWith("gmail_")) return "mail";
  if (/^(job|routine|agent|workflow)_/.test(n)) return "job";
  return "other";
}

/** Pure: the theme choices, and the one stored when it is something else. */
export type ThemePref = "system" | "light" | "dark";
export const themeOf = (s: string | null): ThemePref => (s === "light" || s === "dark" ? s : "system");

/** Pure: whether Enter sends. On a device with a fine pointer (a desktop) Enter sends and Shift+Enter breaks the
 *  line; on a touch screen Enter is a new line and the button sends. Ctrl or Cmd+Enter sends everywhere. */
export function sendsOnEnter(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing?: boolean }, finePointer: boolean): boolean {
  if (e.key !== "Enter" || e.isComposing) return false;
  if (e.ctrlKey || e.metaKey) return true;
  return finePointer && !e.shiftKey;
}

// ---------------------------------------------------------------- pairing

/** Pure: what the person typed as a pairing code, read as the service reads it: Crockford base32 (O is 0, I and L
 *  are 1), upper case, no separators, at most eight characters. */
export function normalizeCode(s: string): string {
  return s.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1").slice(0, 8);
}

/** Pure: a code as it is shown, `XXXX-XXXX`. */
export const showCode = (c: string) => (c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c);

/** Pure: how much of a node's memory is in use, 0 to 100 (0 when it did not say). */
export const memUsed = (n: Pick<NodeInfo, "memTotal" | "memFree">) =>
  n.memTotal > 0 ? Math.round(100 * (1 - Math.min(n.memFree, n.memTotal) / n.memTotal)) : 0;

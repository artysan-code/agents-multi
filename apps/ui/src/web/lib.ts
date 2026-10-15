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

export type TurnState = "waiting" | "running" | "done" | "failed";

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
}

export interface ChatHead {
  id: string;
  title: string;
  updated: string;
  node: string | null;
}

/** Pure: the turns after one Server-Sent Event of the chat (`turn`, `text`, `act`, `done`), or null when the
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
      next = { ...t, a: typeof data.a === "string" ? data.a : t.a, state: t.state === "failed" ? "failed" : "done" };
      break;
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

export type View = "chat" | "tasks" | "brain" | "machines" | "settings";
export interface Route {
  view: View;
  /** a chat's id (`new` for one not started), or a brain page's path */
  id?: string;
}

const VIEWS: View[] = ["chat", "tasks", "brain", "machines", "settings"];

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

/** Pure: a pairing code as it is typed: letters and digits only, capitals, a dash after the fourth (XXXX-XXXX), at most
 *  eight. The service reads it tolerantly anyway; this is for the eye. */
export function tidyCode(typed: string): string {
  const s = typed.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}

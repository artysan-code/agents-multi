// model.ts — what the Tasks page and its sheet share: the board and the filters as signals, and the small
// rules about where a task belongs, whose it is and how a day reads.

import { signal } from "@preact/signals";
import { lang, t } from "../../i18n.ts";
import { owner } from "../../state.ts";
import { type Board, type BoardTask, loadBoard } from "./api.ts";

export const COLS = ["todo", "doing", "waiting", "done"] as const;
export const NONE = "~none";

export type OwnerFilter = "all" | "me" | "claude" | "others";

export const board = signal<Board | null>(null);
export const query = signal("");
export const ownerFilter = signal<OwnerFilter>("all");
export const allFolders = signal(false);

/** Reads the board again: the page does it on each "tasks" event, an action of its own right after it. */
export async function refreshBoard(): Promise<void> {
  board.value = await loadBoard();
}

const KEY = "cm-tproject";
/** The project on screen: a folder, `~none`, `~other:<name>`, or null for all of them. */
export const project = signal<string | null>(stored());

function stored(): string | null {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null; // storage blocked: all projects
  }
}

export function pickProject(k: string | null): void {
  project.value = k || null;
  try {
    localStorage.setItem(KEY, project.value ?? "");
  } catch { /* not remembered */ }
}

export const isMine = (x: { owner?: string }): boolean =>
  !x.owner || x.owner === owner.value.id;
export const isOpen = (x: { status: string }): boolean =>
  x.status !== "done" && x.status !== "dropped";

export function dayLabel(day: string | undefined, time?: string): string {
  if (!day) return "";
  const today = board.value?.today ?? new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(new Date(today + "T12:00").getTime() + 86400000)
    .toISOString().slice(0, 10);
  const label = day === today
    ? t("tb.today")
    : day === tomorrow
    ? t("tb.tomorrow")
    : new Date(day + "T12:00").toLocaleDateString(lang(), {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  return time ? `${label}, ${time}` : label;
}

export const byDue = (a: BoardTask, b: BoardTask): number =>
  (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
  (a.time ?? "99").localeCompare(b.time ?? "99") ||
  (a.priority ?? 2) - (b.priority ?? 2);
export const byWeight = (a: BoardTask, b: BoardTask): number =>
  (a.priority ?? 2) - (b.priority ?? 2) || byDue(a, b) ||
  a.title.localeCompare(b.title);

/** The project a task belongs to, as the left column keys it: its folder, the name a chat gave it
 *  when that is no folder, or none. */
export const projectOf = (x: BoardTask): string =>
  x.folder ?? (x.project ? `~other:${x.project}` : NONE);
export const projectLabel = (k: string): string =>
  k === NONE
    ? t("tb.noProject")
    : (k.startsWith("~other:") ? k.slice(7) : k).split("/").pop()!;
export const openCount = (n: number): string =>
  t(n === 1 ? "tb.sum1" : "tb.sum", { n });
/** What a new task in that project is told about where it belongs. */
export const projectValue = (k: string | null): string | null =>
  k === NONE || !k ? null : k.startsWith("~other:") ? k.slice(7) : k;
export const inProject = (x: BoardTask, k: string): boolean =>
  k === NONE || k.startsWith("~other:")
    ? projectOf(x) === k
    : !!x.folder && (x.folder === k || x.folder.startsWith(k + "/"));

/** The project on screen; one that has gone (its last task moved) falls back to the overview. */
export function currentProject(): string | null {
  const b = board.value, p = project.value;
  if (!b || !p) return p;
  return b.tasks.some((x) => inProject(x, p)) ||
      b.projects.some((n) => n.path === p)
    ? p
    : null;
}

export function visible(): BoardTask[] {
  const b = board.value;
  if (!b) return [];
  const q = query.value.toLowerCase(),
    p = currentProject(),
    o = ownerFilter.value;
  return b.tasks.filter((x) =>
    (!p || inProject(x, p)) &&
    (o === "all" || (o === "me"
      ? isMine(x)
      : o === "claude"
      ? x.owner === "claude"
      : !isMine(x) && x.owner !== "claude")) &&
    (!q ||
      `${x.ref ?? ""} ${x.title} ${x.project ?? ""} ${x.folder ?? ""} ${
        x.stage ?? ""
      } ${(x.labels ?? []).join(" ")}`
        .toLowerCase().includes(q))
  );
}

export const stepsOf = (xs: BoardTask[]): { d: number; n: number } =>
  xs.reduce(
    (a, x) =>
      x.progress ? { d: a.d + x.progress.done, n: a.n + x.progress.total } : a,
    { d: 0, n: 0 },
  );

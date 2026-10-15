// tasks-view.ts — the Tasks view: what the day holds with its times, what is late, and the rest of the
// open tasks by project. Pure; the route (server.ts) gives it the brain's tasks and the calendar's day.

import { dayOf, type Task } from "../../../shared/mcp/lib/tasks.ts";

/** The part of a task the view shows (no notes: they can be long and nobody reads them here). */
export interface TaskRow {
  id: string;
  ref?: string;
  title: string;
  status: Task["status"];
  due?: string;
  time?: string;
  end?: string;
  project?: string;
  priority?: 1 | 2 | 3;
  /** an agenda entry that is not a task ("calendar"): shown, never marked done here */
  source?: string;
  color?: string;
  link?: string;
}

export interface TasksView {
  day: string;
  /** today's, timed ones first in time order, then the rest */
  today: TaskRow[];
  /** open since an earlier day, oldest first */
  overdue: TaskRow[];
  /** everything else open, grouped by project (null: no project, last) */
  projects: { project: string | null; tasks: TaskRow[] }[];
}

const open = (t: Task) => t.status === "todo" || t.status === "doing" || t.status === "waiting";
const row = (t: Task): TaskRow => {
  const { id, ref, title, status, due, time, end, project, priority, source, color, link } = t;
  return { id, ref, title, status, due, time, end, project, priority, source, color, link };
};
const byTime = (a: Task, b: Task) =>
  (a.time ?? "99:99").localeCompare(b.time ?? "99:99") || (a.priority ?? 2) - (b.priority ?? 2) ||
  a.title.localeCompare(b.title);
const byDay = (a: Task, b: Task) => (a.due ?? "9").localeCompare(b.due ?? "9") || byTime(a, b);

/** Pure: the view of `tasks` (the brain's and the calendar's entries) seen from `now`. */
export function tasksView(tasks: Task[], now: Date): TasksView {
  const day = dayOf(now);
  const live = tasks.filter(open);
  const today = live.filter((t) => t.due === day).sort(byTime);
  const overdue = live.filter((t) => t.due && t.due < day && !t.source).sort(byDay);
  const rest = live.filter((t) => !t.source && (!t.due || t.due > day)).sort(byDay);
  const groups = new Map<string | null, Task[]>();
  for (const t of rest) groups.set(t.project ?? null, [...groups.get(t.project ?? null) ?? [], t]);
  const projects = [...groups].sort(([a], [b]) => a === null ? 1 : b === null ? -1 : a.localeCompare(b))
    .map(([project, ts]) => ({ project, tasks: ts.map(row) }));
  return { day, today: today.map(row), overdue: overdue.map(row), projects };
}

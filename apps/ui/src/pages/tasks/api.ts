// api.ts — what Tasks reads and does: the view (/api/tasks/view: apps/cli/console/tasks-view.ts), the
// one write (/api/tasks/done) and where the brain's own board is (/api/brain/info).

import { get, post, type Result } from "../../api.ts";

export interface TaskRow {
  id: string;
  ref?: string;
  title: string;
  status: "todo" | "doing" | "waiting" | "done" | "dropped";
  due?: string;
  time?: string;
  end?: string;
  project?: string;
  priority?: 1 | 2 | 3;
  source?: string;
  color?: string;
  link?: string;
}

export interface TasksView {
  day: string;
  today: TaskRow[];
  overdue: TaskRow[];
  projects: { project: string | null; tasks: TaskRow[] }[];
  calendarErrors?: string[];
}

export const loadTasks = () => get<TasksView>("/api/tasks/view");
export const markDone = (id: string) => post<Result>("/api/tasks/done", { id });
export const loadBrainInfo = () => get<{ url: string | null; board: string | null }>("/api/brain/info");

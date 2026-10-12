// types.ts — the shapes of a task, its input and the settings; no behaviour.

export type Status = "todo" | "doing" | "waiting" | "done" | "dropped";
export const STATUSES: Status[] = ["todo", "doing", "waiting", "done", "dropped"];
export type Repeat = "daily" | "weekdays" | "weekly" | "monthly";
export const REPEATS: Repeat[] = ["daily", "weekdays", "weekly", "monthly"];

export interface Task {
  id: string;
  title: string;
  status: Status;
  due?: string; // YYYY-MM-DD
  time?: string; // HH:MM
  remind?: number; // minutes before `time`
  owner?: string; // the setup's owner (owner.ts) · claude · someone else
  project?: string;
  priority?: 1 | 2 | 3; // 1 high
  repeat?: Repeat;
  ref?: string; // the project's own name for it: TASK-495
  stage?: string; // spec, discovery, release pending…: free, lower case
  parent?: string; // the id of the task this is part of
  blocked_by?: string[]; // ids of the tasks that have to be done first
  labels?: string[];
  detail?: string; // where the full detail lives: a path, a path#anchor, a URL, [[page]]
  created: string;
  updated: string;
  done?: string;
  notes?: string;
  /** where an agenda entry comes from when it is not a task ("calendar"): never written to a file */
  source?: string;
  /** a calendar entry: the calendar it is in and that calendar's colour (a CSS colour) */
  calendar?: string;
  color?: string;
  /** a calendar entry: when it ends (HH:MM, only when that is the same day) and its page in the calendar */
  end?: string;
  link?: string;
}

export interface TaskSettings {
  /** local times of the day at which the desktop brief is sent */
  briefs: string[];
  /** default minutes of warning before a timed task */
  remind: number;
}

export interface TaskInput {
  title?: string;
  status?: Status;
  due?: string | null;
  time?: string | null;
  remind?: number | null;
  owner?: string | null;
  project?: string | null;
  priority?: 1 | 2 | 3 | null;
  repeat?: Repeat | null;
  notes?: string | null;
  ref?: string | null;
  stage?: string | null;
  parent?: string | null;
  blocked_by?: string[] | null;
  labels?: string[] | null;
  detail?: string | null;
}

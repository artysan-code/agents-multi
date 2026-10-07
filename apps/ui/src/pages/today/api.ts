// api.ts — what the Today page reads beyond the shared report and the task board: the day's list
// (/api/tasks), the saved sessions and the debrief.

export interface DayItem {
  id: string;
  title: string;
  time?: string | null;
  /** an event's end, the same day ("HH:MM"); absent for all-day events and tasks */
  end?: string | null;
  due?: string | null;
  project?: string | null;
  owner?: string | null;
  status?: string;
  priority?: number;
  notes?: string | null;
  source?: string | null;
  calendar?: string | null;
  color?: string | null;
  /** the event in its calendar */
  link?: string | null;
}

/** /api/tasks: the day, grouped as the server sorts it. */
export interface Day {
  day: string;
  today: DayItem[];
  earlier?: DayItem[];
  overdue: DayItem[];
  missed: DayItem[];
  tomorrow: DayItem[];
  upcoming: DayItem[];
  waiting: DayItem[];
  doneToday?: number;
  moment?: string;
}

/** One row of /api/sessions: a finished or running session, by directory. */
export interface SessionRow {
  cwd: string | null;
  project: string;
  ended: string;
  profile: string;
  session_id: string;
}

export interface DebriefDone {
  text?: string;
  error?: string;
}

// api.ts — what the Today page reads beyond the shared report: the day's task list, the saved
// sessions and the debrief.

export interface DayItem {
  id: string;
  title: string;
  time?: string | null;
  due?: string | null;
  project?: string | null;
  owner?: string | null;
  priority?: number;
  notes?: string | null;
  source?: string;
  calendar?: string | null;
  color?: string | null;
}

/** /api/tasks: the day, grouped as the server sorts it. */
export interface Day {
  today: DayItem[];
  earlier?: DayItem[];
  overdue: DayItem[];
  missed: DayItem[];
  tomorrow: DayItem[];
  upcoming: DayItem[];
  waiting: DayItem[];
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

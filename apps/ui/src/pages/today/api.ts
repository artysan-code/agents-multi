// api.ts — what the Today page reads beyond the shared report and the task board: the day's list
// (/api/tasks), the saved sessions, the usage limits and the debrief.

import { api, get, post, postRaw, type Result } from "../../api.ts";

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

export const loadDay = () => get<Day>("/api/tasks");

/** The last sessions, newest first. */
export const loadSessions = () => get<SessionRow[]>("/api/sessions?" + new URLSearchParams({ since: "7d", limit: "60" }));

export interface Limit {
  used: number;
  resets: number | null;
}
/** /api/live: each profile's limits and tokens, each running session's context (apps/cli/live.ts). */
export interface LiveView {
  profiles: Record<string, { limits: { five_hour?: Limit; seven_day?: Limit } | null; at: number | null; tokens: number }>;
  sessions: Record<string, { context?: { used: number | null; size: number | null } | null; at: number }>;
  errors?: Record<string, string>;
}

export const loadLive = () => get<LiveView>("/api/live");
/** Asks Anthropic for the limits now. */
export const refreshLive = () => post<LiveView>("/api/live/refresh", {});

/** Resumes a saved session in a terminal. */
export const resumeSession = (r: SessionRow) => api.terminal({ cwd: r.cwd, profile: r.profile, resume: r.session_id });
/** Opens a profile's Claude Desktop. */
export const openDesktop = (profile: string) => api.launch(profile);
/** Brings a running Claude's window forward. */
export const focusWindow = (pid: number): Promise<Result> => post("/api/focus", { pid });

/** The debrief written today, if there is one. */
export const loadDebrief = () => get<{ debrief?: { text: string } | null }>("/api/debrief");
/** Has it written (NDJSON: text pieces, then done). */
export const writeDebrief = () => postRaw("/api/debrief", {});

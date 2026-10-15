// api.ts — what Runs reads and does: the agents hub (/api/runs: apps/cli/console/runs.ts), each running
// session's context (/api/live), the last sessions (/api/sessions), resuming one in a terminal and
// bringing a running Claude's window forward.

import { api, get, post, type Result } from "../../api.ts";
import type { LiveView } from "../limits/api.ts";

export interface StepRow {
  id: string;
  profile: string;
  status: string;
  error?: string;
}

export interface RunRow {
  id: string;
  name: string;
  status: string;
  alive: boolean;
  project?: string;
  started: string | null;
  steps: StepRow[];
}

export interface AgentRow {
  id: string;
  profile: string;
  provider: string;
  project?: string;
  dir: string;
  task: string;
  started: string;
  phase: string;
  turns: number;
  pending: number;
  said: string | null;
  error: string | null;
  run?: { id: string; step: string };
}

/** One row of /api/sessions: a finished or running session, by directory. */
export interface SessionRow {
  cwd: string | null;
  project: string;
  ended: string;
  profile: string;
  session_id: string;
}

export const loadRuns = () => get<{ runs: RunRow[]; agents: AgentRow[] }>("/api/runs");
export const loadLive = () => get<LiveView>("/api/live");
/** The last sessions, newest first. */
export const loadSessions = () => get<SessionRow[]>("/api/sessions?" + new URLSearchParams({ since: "7d", limit: "60" }));
/** Resumes a saved session in a terminal. */
export const resumeSession = (r: SessionRow) => api.terminal({ cwd: r.cwd, profile: r.profile, resume: r.session_id });
/** Brings a running Claude's window forward. */
export const focusWindow = (pid: number): Promise<Result> => post("/api/focus", { pid });

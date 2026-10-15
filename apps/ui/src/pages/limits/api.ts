// api.ts — what Accounts & limits reads and does: every account's usage windows, Claude's and Codex's
// (/api/limits, apps/cli/limits.ts), today's tokens (/api/live, apps/cli/live.ts), asking Anthropic for
// Claude's limits now, and opening a profile's Claude Desktop.

import { api, get, post } from "../../api.ts";

export interface Limit {
  used: number;
  resets: number | null;
}

/** /api/live: each profile's limits and tokens, each running session's context. */
export interface LiveView {
  profiles: Record<string, { limits: { five_hour?: Limit; seven_day?: Limit } | null; at: number | null; tokens: number }>;
  sessions: Record<string, { context?: { used: number | null; size: number | null } | null; at: number }>;
  errors?: Record<string, string>;
}

/** One usage window of an account, as `agents limits` reads it; `stale` past half an hour. */
export interface Window {
  window: string;
  usedPercent: number;
  resetsAt: number | null;
  source: string;
  at: number | null;
  stale: boolean;
}

export interface AccountLimits {
  account: { id: string; profile: string; provider: string };
  windows: Window[];
}

export const loadLimits = () => get<{ now: number; accounts: AccountLimits[] }>("/api/limits");
export const loadLive = () => get<LiveView>("/api/live");
/** Asks Anthropic for the limits now. */
export const refreshLive = () => post<LiveView>("/api/live/refresh", {});
/** Opens a profile's Claude Desktop, or brings it forward. */
export const openDesktop = (profile: string) => api.launch(profile);

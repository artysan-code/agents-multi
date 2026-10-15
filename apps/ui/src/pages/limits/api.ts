// api.ts — what Accounts & limits reads and does: each profile's usage limits and today's tokens
// (/api/live, apps/cli/live.ts), asking Anthropic for them now, and opening a profile's Claude Desktop.

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

export const loadLive = () => get<LiveView>("/api/live");
/** Asks Anthropic for the limits now. */
export const refreshLive = () => post<LiveView>("/api/live/refresh", {});
/** Opens a profile's Claude Desktop, or brings it forward. */
export const openDesktop = (profile: string) => api.launch(profile);

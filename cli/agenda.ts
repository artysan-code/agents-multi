// agenda.ts — the day is tasks and appointments: today's calendar events, from every connected
// Google account, in the shape of tasks, so the brief, the reminders and the console treat them the
// same way. Marked `source: "calendar"` (and never written back: they are not tasks), with the
// account as their project. Any account that cannot be read is skipped, and said in `errors`.

import { ACCOUNTS } from "./mcp.ts";
import { loadAccounts } from "../shared/mcp/lib/accounts.ts";
import { accessToken, loadClient } from "../shared/mcp/lib/google.ts";
import { addDays, dayOf, hhmm, type Task } from "../shared/mcp/lib/tasks.ts";
import { getSecret } from "../shared/mcp/lib/vault.ts";

// deno-lint-ignore no-explicit-any
type Doc = any;

/** Pure: a Google Calendar event as a task-shaped entry of the agenda. */
export function eventAsTask(e: Doc, account: string): Task | null {
  if (e.status === "cancelled") return null;
  // an invitation declined is not something to do
  if (e.attendees?.find((a: Doc) => a.self)?.responseStatus === "declined") return null;
  const start = e.start?.dateTime ? new Date(e.start.dateTime) : null;
  const due = start ? dayOf(start) : e.start?.date;
  if (!due) return null;
  return {
    id: `ev-${account}-${e.id}`, title: e.summary ?? "(no title)", status: "todo", due, ...(start ? { time: hhmm(start) } : {}),
    project: account, owner: "samuel", source: "calendar", created: e.created ?? "", updated: e.updated ?? "",
  };
}

/** Events from `fromDay` (today by default) for `days` days. */
export async function calendarAsTasks(days = 2, fromDay?: string): Promise<{ tasks: Task[]; errors: string[] }> {
  const google = loadAccounts(ACCOUNTS).filter((a) => a.service === "google");
  if (!google.length) return { tasks: [], errors: [] };
  const tasks: Task[] = [], errors: string[] = [];
  let client;
  try { client = await loadClient(); } catch { return { tasks, errors }; } // not set up yet: nothing to say
  const today = fromDay ?? dayOf(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const from = new Date(y, m - 1, d).toISOString();
  const [y2, m2, d2] = addDays(today, days).split("-").map(Number);
  const to = new Date(y2, m2 - 1, d2).toISOString();
  for (const a of google) {
    try {
      const refresh = await getSecret("google", a.name);
      if (!refresh) continue; // not connected on this machine yet
      const token = await accessToken(client, refresh);
      const q = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: "true", orderBy: "startTime", maxResults: "250" });
      const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) { errors.push(`${a.name}: HTTP ${r.status}`); continue; }
      for (const e of (await r.json()).items ?? []) {
        const t = eventAsTask(e, a.name);
        if (t) tasks.push(t);
      }
    } catch (e) {
      errors.push(`${a.name}: ${(e as Error).message}`);
    }
  }
  return { tasks, errors };
}

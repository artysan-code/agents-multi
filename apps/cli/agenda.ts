// agenda.ts — the day is tasks and appointments: today's calendar events, from every connected
// Google account, in the shape of tasks, so the brief, the reminders and the console treat them the
// same way. Marked `source: "calendar"` (and never written back: they are not tasks), with the
// account as their project. Any account that cannot be read is skipped, and said in `errors`.

import { owner } from "../../shared/mcp/lib/owner.ts";
import { ACCOUNTS } from "./mcp/registry.ts";
import { loadAccounts } from "../../shared/mcp/lib/accounts.ts";
import { accessToken, loadClient } from "../../shared/mcp/lib/google.ts";
import { addDays, dayOf, hhmm, type Task } from "../../shared/mcp/lib/tasks.ts";
import { getSecret } from "../../shared/mcp/lib/vault.ts";
import { type CalendarInfo, listCalendars } from "./calendars.ts";

// deno-lint-ignore no-explicit-any
type Doc = any;

/** Pure: a Google Calendar event as a task-shaped entry of the agenda. */
export function eventAsTask(e: Doc, account: string, cal?: Pick<CalendarInfo, "name" | "color">): Task | null {
  if (e.status === "cancelled") return null;
  // an invitation declined is not something to do
  if (e.attendees?.find((a: Doc) => a.self)?.responseStatus === "declined") return null;
  const start = e.start?.dateTime ? new Date(e.start.dateTime) : null;
  const due = start ? dayOf(start) : e.start?.date;
  if (!due) return null;
  return {
    id: `ev-${account}-${e.id}`,
    title: e.summary ?? "(no title)",
    status: "todo",
    due,
    ...(start ? { time: hhmm(start) } : {}),
    project: account,
    ...(cal ? { calendar: cal.name, color: cal.color } : {}),
    owner: owner().id,
    source: "calendar",
    created: e.created ?? "",
    updated: e.updated ?? "",
  };
}

/** Pure: the same event can sit in several calendars (an invitation, a shared one): shown once. */
export function dedupeEvents(tasks: Task[], uids: Map<string, string>): Task[] {
  const seen = new Set<string>();
  return tasks.filter((t) => {
    const key = `${uids.get(t.id) ?? t.id}|${t.due}|${t.time ?? ""}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

/** The choice of calendars changed: the next ask reads them again. */
export const resetAgenda = () => memo.clear();

/** Today's and tomorrow's events. Kept two minutes: Today asks on every redraw, and Google
 *  answers in about a second. */
const memo = new Map<string, { at: number; value: Promise<{ tasks: Task[]; errors: string[] }> }>();
export function calendarAsTasks(): Promise<{ tasks: Task[]; errors: string[] }> {
  const key = dayOf(new Date()), days = 2;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < 120000) return hit.value;
  const value = fetchCalendar(days);
  memo.set(key, { at: Date.now(), value });
  value.then((r) => {
    if (r.errors.length) memo.delete(key);
  }, () => memo.delete(key)); // failures are not kept
  return value;
}

async function fetchCalendar(days: number): Promise<{ tasks: Task[]; errors: string[] }> {
  const google = loadAccounts(ACCOUNTS).filter((a) => a.service === "google");
  if (!google.length) return { tasks: [], errors: [] };
  const tasks: Task[] = [], errors: string[] = [];
  let client;
  try {
    client = await loadClient();
  } catch {
    return { tasks, errors };
  } // not set up yet: nothing to say
  const today = dayOf(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const from = new Date(y, m - 1, d).toISOString();
  const [y2, m2, d2] = addDays(today, days).split("-").map(Number);
  const to = new Date(y2, m2 - 1, d2).toISOString();
  const uids = new Map<string, string>();
  const lists = await listCalendars();
  await Promise.all(google.map(async (a) => {
    try {
      const refresh = await getSecret("google", a.name);
      if (!refresh) return; // not connected on this machine yet
      const token = await accessToken(client, refresh);
      const mine = lists.find((l) => l.account === a.name);
      // the list failed (offline, an old token): the main calendar, as before, rather than nothing
      const cals = mine?.state === "ok" ? mine.calendars.filter((c) => c.shown) : [{
        id: "primary",
        name: a.name,
        color: "#888888",
        shown: true,
        primary: true,
        role: "owner",
        noisy: false,
      }];
      await Promise.all(cals.map(async (c) => {
        const q = new URLSearchParams({
          timeMin: from,
          timeMax: to,
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: "250",
        });
        const r = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.id)}/events?${q}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        if (!r.ok) {
          errors.push(`${a.name}/${c.name}: HTTP ${r.status}`);
          return;
        }
        for (const e of (await r.json()).items ?? []) {
          const t = eventAsTask(e, a.name, c);
          if (!t) continue;
          t.id = `ev-${a.name}-${c.id}-${e.id}`;
          if (e.iCalUID) uids.set(t.id, e.iCalUID);
          tasks.push(t);
        }
      }));
    } catch (e) {
      errors.push(`${a.name}: ${(e as Error).message}`);
    }
  }));
  tasks.sort((x, y) => `${x.due}${x.time ?? ""}`.localeCompare(`${y.due}${y.time ?? ""}`));
  return { tasks: dedupeEvents(tasks, uids), errors };
}

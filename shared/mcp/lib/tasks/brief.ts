// brief.ts — what the day holds, and the reminders and briefs that are due; all pure.

import { owner } from "../owner.ts";
import type { Task, TaskSettings } from "./types.ts";
import { addDays, at, dayOf, hhmm, hourOf, validTime } from "./dates.ts";

// ---------------------------------------------------------------- the brief
const open = (t: Task) => t.status === "todo" || t.status === "doing";
const byTimeThenPriority = (a: Task, b: Task) =>
  (a.time ?? "99:99").localeCompare(b.time ?? "99:99") || (a.priority ?? 2) - (b.priority ?? 2) ||
  a.title.localeCompare(b.title);

type Moment = "morning" | "afternoon" | "evening";
export const momentOf = (now: Date): Moment =>
  hourOf(now) < 13 ? "morning" : hourOf(now) < 18 ? "afternoon" : "evening";

/** Pure: what the day holds, seen from `now`. `later` is the rest of today still ahead; in the
 *  evening `tomorrow` is what comes next. Tasks owned by someone else are listed as waiting. */
export function brief(tasks: Task[], now: Date, horizon = 3, me = owner().id) {
  const today = dayOf(now), clock = hhmm(now);
  const mine = tasks.filter((t) => open(t) && (!t.owner || t.owner === me || t.owner === "claude"));
  const todayAll = mine.filter((t) => t.due === today).sort(byTimeThenPriority);
  return {
    day: today,
    moment: momentOf(now),
    overdue: mine.filter((t) => t.due && t.due < today).sort((a, b) =>
      a.due!.localeCompare(b.due!) || byTimeThenPriority(a, b)
    ),
    // timed tasks already past this hour, still open: missed today (a past appointment is just past)
    missed: todayAll.filter((t) => t.time && t.time < clock && !t.source),
    today: todayAll.filter((t) => !t.time || t.time >= clock),
    tomorrow: mine.filter((t) => t.due === addDays(today, 1)).sort(byTimeThenPriority),
    upcoming: mine.filter((t) => t.due && t.due > addDays(today, 1) && t.due <= addDays(today, horizon)).sort((a, b) =>
      a.due!.localeCompare(b.due!) || byTimeThenPriority(a, b)
    ),
    undated: mine.filter((t) => !t.due).sort(byTimeThenPriority),
    waiting: tasks.filter((t) =>
      t.status === "waiting" || (open(t) && t.owner && t.owner !== me && t.owner !== "claude")
    ),
    doneToday: tasks.filter((t) => t.status === "done" && t.done && dayOf(new Date(t.done)) === today).length,
  };
}

// ---------------------------------------------------------------- reminders
/** Pure: the timed tasks whose warning is due now and was not sent yet. A warning is not sent
 *  more than an hour late: a machine woken in the evening does not replay the morning. */
export function dueReminders(
  tasks: Task[],
  now: Date,
  sent: Set<string>,
  defaultRemind: number,
): { task: Task; key: string }[] {
  const out = [];
  for (const t of tasks) {
    if (!open(t) || !t.due || !t.time) continue;
    const start = at(t.due, t.time);
    const warn = new Date(start.getTime() - (t.remind ?? defaultRemind) * 60000);
    const key = `${t.id}@${t.due}T${t.time}`;
    if (now >= warn && now.getTime() - start.getTime() < 3600000 && !sent.has(key)) out.push({ task: t, key });
  }
  return out;
}

/** Pure: the brief times of today already reached (within the hour) and not sent yet. */
export function dueBriefs(settings: TaskSettings, now: Date, sent: Set<string>): string[] {
  const today = dayOf(now);
  return settings.briefs.filter(validTime).filter((b) => {
    const t = at(today, b).getTime();
    return now.getTime() >= t && now.getTime() - t < 3600000 && !sent.has(`brief@${today}T${b}`);
  });
}

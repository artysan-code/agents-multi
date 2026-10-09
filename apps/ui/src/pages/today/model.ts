// model.ts — the rules of the Today page, as pure functions: which group a task falls in, the lanes of
// the day's line, what comes next, and the debrief's first sentence. No imports: the tests read it as
// it is (apps/cli/tests/ui_today_test.ts).

/** The part of a board task the groups read (BoardTask in pages/tasks/api.ts fits it). */
export interface GroupTask {
  id: string;
  status: string;
  owner?: string;
  due?: string;
  time?: string;
  priority?: number;
  updated?: string;
}

export type GroupName = "late" | "today" | "doing" | "wait";
export const GROUPS: GroupName[] = ["late", "today", "doing", "wait"];

const open = (x: GroupTask) => x.status === "todo" || x.status === "doing" || x.status === "waiting";

/** The group of a task, or null when Today does not show it (done, or open with nothing pressing):
 *  waiting, or someone else's (Claude's included) → wait; then late, due today, in progress. */
export function groupOf(x: GroupTask, today: string, me: string): GroupName | null {
  if (!open(x)) return null;
  if (x.status === "waiting" || (x.owner && x.owner !== me)) return "wait";
  if (x.due && x.due < today) return "late";
  if (x.due === today) return "today";
  if (x.status === "doing") return "doing";
  return null;
}

const byDue = (a: GroupTask, b: GroupTask) =>
  (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.time ?? "99").localeCompare(b.time ?? "99") ||
  (a.priority ?? 2) - (b.priority ?? 2);
const byRecent = (a: GroupTask, b: GroupTask) =>
  (a.priority ?? 2) - (b.priority ?? 2) || (b.updated ?? "").localeCompare(a.updated ?? "");

/** The four groups, each in its order: by when it was due, by the time today, the rest most recent first. */
export function groupTasks<T extends GroupTask>(tasks: T[], today: string, me: string): Record<GroupName, T[]> {
  const out: Record<GroupName, T[]> = { late: [], today: [], doing: [], wait: [] };
  for (const x of tasks) {
    const g = groupOf(x, today, me);
    if (g) out[g].push(x);
  }
  out.late.sort(byDue);
  out.today.sort(byDue);
  out.doing.sort(byRecent);
  // Claude's first: its work moves on its own
  out.wait.sort((a, b) => Number(b.owner === "claude") - Number(a.owner === "claude") || byDue(a, b) || byRecent(a, b));
  return out;
}

/** "HH:MM" as minutes from midnight; null when it is not a time. */
export function minutes(hm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hm ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Calendar days from `a` to `b` (YYYY-MM-DD). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);
}

export interface Span {
  start: number;
  end: number;
}

/** One lane per item, so that items in a lane do not overlap: the first lane free at its start, else
 *  the one that frees up first (it overlaps there, but stays on the line). Items in start order. */
export function lanes(items: Span[], n = 3): number[] {
  const ends: number[] = Array(n).fill(-Infinity);
  return items.map((x) => {
    let i = ends.findIndex((e) => e <= x.start);
    if (i < 0) i = ends.indexOf(Math.min(...ends));
    ends[i] = Math.max(ends[i], x.end);
    return i;
  });
}

/** Pure: the agenda's columns, as a calendar draws them side by side: items that overlap, directly
 *  or through others, share the width; each gets its column and how many there are in its group.
 *  Items in start order. */
export function columns(items: Span[]): { col: number; cols: number }[] {
  const out = items.map(() => ({ col: 0, cols: 1 }));
  let first = 0, end = -Infinity;
  const close = (to: number) => {
    const group = items.slice(first, to);
    const l = lanes(group, group.length);
    const cols = Math.max(...l) + 1;
    l.forEach((col, k) => (out[first + k] = { col, cols }));
  };
  items.forEach((x, i) => {
    if (i > first && x.start >= end) {
      close(i);
      first = i;
    }
    end = i === first ? x.end : Math.max(end, x.end);
  });
  if (items.length) close(items.length);
  return out;
}

/** The first two items starting after `now` (minutes), in time order. */
export function upNext<T extends { time?: string | null }>(items: T[], now: number): T[] {
  return items
    .filter((x) => (minutes(x.time) ?? -1) > now)
    .sort((a, b) => minutes(a.time)! - minutes(b.time)!)
    .slice(0, 2);
}

/** "in 50 min", "in 2 h 10": the countdown's number and the rest. */
export function countdown(from: number, to: number): { n: number; unit: "min" | "h"; rest: number } {
  const d = Math.max(0, to - from);
  return d < 60 ? { n: d, unit: "min", rest: 0 } : { n: Math.floor(d / 60), unit: "h", rest: d % 60 };
}

/** The debrief in one sentence: its first, without Markdown, cut at `max` characters on a word. */
export function firstSentence(text: string, max = 180): string {
  const plain = text
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(plain);
  const s = m ? m[1] : plain;
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2)).replace(/[\s,;:]+$/, "") + "…";
}

/** The window of the day's line: 08–21, widened to what is planned outside it. */
export function dayWindow(spans: Span[]): { from: number; to: number } {
  let from = 8 * 60, to = 21 * 60;
  for (const s of spans) {
    from = Math.min(from, Math.floor(s.start / 60) * 60);
    to = Math.max(to, Math.ceil(s.end / 60) * 60);
  }
  return { from: Math.max(0, from), to: Math.min(24 * 60, to) };
}

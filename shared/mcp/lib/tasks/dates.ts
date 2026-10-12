// dates.ts — days and hours in the owner's zone, and the next day of a repeating task.

import type { Repeat } from "./types.ts";

// several people (the brain), the zone of the person the request is for, given by useZone(). Only
// turning an instant into a day or an hour, and back, needs the zone; counting days on the calendar
// (addDays, nextDue) is done at UTC, where every day has 24 hours.
export const pad = (n: number) => String(n).padStart(2, "0");

let zoneOf: (() => string | undefined) | null = null;
/** A process that serves several people says, per request, whose zone the days are in. */
export function useZone(fn: () => string | undefined) {
  zoneOf = fn;
}
/** The zone days and hours are in now (an IANA name), or undefined for this machine's own. */
export const zone = (): string | undefined => zoneOf?.() || undefined;

/** Pure: whether a name is a time zone this runtime knows. */
export function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();
/** The wall clock of an instant: in `tz`, or this machine's own zone. */
function wall(d: Date, tz = zone()): { y: number; m: number; d: number; h: number; mi: number } {
  if (!tz) return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formats.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute };
}
/** The day of an instant, in the owner's zone. */
export const dayOf = (d: Date) => {
  const w = wall(d);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
};
/** The hour and minute of an instant, in the owner's zone. */
export const hhmm = (d: Date) => {
  const w = wall(d);
  return `${pad(w.h)}:${pad(w.mi)}`;
};
/** The hour of an instant, in the owner's zone. */
export const hourOf = (d: Date) => wall(d).h;

const cal = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return { y, m, d };
};
const calDay = (t: number) => {
  const x = new Date(t);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
};
/** A day plus n days, as a day. */
export function addDays(day: string, n: number): string {
  const { y, m, d } = cal(day);
  return calDay(Date.UTC(y, m - 1, d + n));
}
/** The instant a day's hour starts, in the owner's zone. */
export const at = (day: string, time: string) => {
  const { y, m, d } = cal(day);
  const [h, mi] = time.split(":").map(Number);
  const tz = zone();
  if (!tz) return new Date(y, m - 1, d, h, mi);
  // the wall time read as if it were UTC, then moved by the zone's offset at that instant (twice:
  // the offset can change between the guess and the answer, around a change of summer time)
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const offset = (t: number) => {
    const w = wall(new Date(t), tz);
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi) - Math.floor(t / 60000) * 60000;
  };
  const first = guess - offset(guess);
  return new Date(guess - offset(first));
};
export const validDay = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const { y, m, d } = cal(s);
  return calDay(Date.UTC(y, m - 1, d)) === s;
};
export const validTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** Pure: the next due day of a repeating task, after `from`. */
export function nextDue(from: string, repeat: Repeat): string {
  if (repeat === "daily") return addDays(from, 1);
  if (repeat === "weekly") return addDays(from, 7);
  if (repeat === "monthly") {
    const { y, m, d } = cal(from);
    // the same day next month, or its last day when it has fewer (31 Jan → 28/29 Feb)
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return calDay(Date.UTC(y, m, Math.min(d, last)));
  }
  let next = addDays(from, 1);
  const weekday = (day: string) => new Date(Date.UTC(cal(day).y, cal(day).m - 1, cal(day).d)).getUTCDay();
  while ([0, 6].includes(weekday(next))) next = addDays(next, 1);
  return next;
}

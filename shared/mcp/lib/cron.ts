// cron.ts — when a routine fires (ADR 0010): five-field cron in the machine's local time, and the
// one-shot `at` written the way a person says it. Pure: every function takes its `now`.

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** day-of-month and day-of-week both restricted: a day matches when either does (Vixie cron) */
  either: boolean;
}

const FIELDS: [string, number, number][] = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day of month", 1, 31],
  ["month", 1, 12],
  ["day of week", 0, 7],
];

function field(text: string, name: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cron ${name}: not understood: ${part || "(empty)"}`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) throw new Error(`cron ${name}: step must be at least 1`);
    let from = lo, to = hi;
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-").map(Number);
      from = a;
      to = b ?? (m[2] === undefined ? a : hi);
    }
    if (from < lo || to > hi || from > to) throw new Error(`cron ${name}: ${part} is outside ${lo}-${hi}`);
    for (let n = from; n <= to; n += step) out.add(n);
  }
  return out;
}

/** Pure: a cron expression (`m h dom mon dow`; lists, ranges, steps; dow 0 or 7 is Sunday). Throws with
 *  the field at fault. */
export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron needs five fields: minute hour day-of-month month day-of-week");
  const sets = parts.map((p, i) => field(p, FIELDS[i][0], FIELDS[i][1], FIELDS[i][2]));
  const dow = new Set([...sets[4]].map((d) => d % 7));
  return {
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow,
    either: parts[2] !== "*" && parts[4] !== "*",
  };
}

const dayMatches = (c: Cron, d: Date) => {
  const dom = c.dom.has(d.getDate()), dow = c.dow.has(d.getDay());
  return c.either ? dom || dow : dom && dow;
};

/** Pure: the first minute strictly after `after` that the expression names, in local time; null when it
 *  never comes within five years (31 February). */
export function nextFire(expr: string | Cron, after: Date): Date | null {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 864e5;
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getMonth() + 1) || !dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  return null;
}

/** Pure: a one-shot time from what a person writes, as an ISO string in UTC:
 *  an ISO date-time (`2026-10-15T02:00`, local unless it carries a zone), `HH:MM` (the next time the clock
 *  says it: "tonight at 02:00"), or `+90m` / `+2h` / `+1d` from now. Throws when it is none, or already past. */
export function parseAt(text: string, now: Date): string {
  const t = text.trim();
  let when: Date;
  let m: RegExpExecArray | null;
  if ((m = /^\+(\d+)([mhd])$/.exec(t))) {
    when = new Date(now.getTime() + Number(m[1]) * { m: 6e4, h: 36e5, d: 864e5 }[m[2] as "m" | "h" | "d"]);
  } else if ((m = /^(\d{1,2}):(\d{2})$/.exec(t))) {
    if (Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`not a time: ${t}`);
    when = new Date(now.getTime());
    when.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (when.getTime() <= now.getTime()) when.setDate(when.getDate() + 1);
  } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?$/.test(t)) {
    when = new Date(t.replace(" ", "T"));
  } else {
    throw new Error(`not understood: "${t}" — use 2026-10-15T02:00, 02:00 or +90m`);
  }
  if (Number.isNaN(when.getTime())) throw new Error(`not a date: ${t}`);
  if (when.getTime() <= now.getTime()) throw new Error(`${t} is already past`);
  return when.toISOString();
}

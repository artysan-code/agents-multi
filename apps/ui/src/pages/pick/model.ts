// model.ts — the picker's rules on the day's next appointment, as pure functions: what comes next and
// how far off it is. No imports: the tests read it as it is (apps/cli/tests/ui_pick_test.ts).

/** "HH:MM" as minutes from midnight; null when it is not a time. */
export function minutes(hm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hm ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
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

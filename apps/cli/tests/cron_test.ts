// cron_test.ts — when a routine fires (shared/mcp/lib/cron.ts): cron expressions and the one-shot `at`.
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { nextFire, parseAt, parseCron } from "../../../shared/mcp/lib/cron.ts";

// local-time dates: the machine's zone does not matter, both sides are built the same way
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const fire = (expr: string, after: Date) => nextFire(expr, after)?.getTime();

Deno.test("cron: fields — lists, ranges, steps, Sunday as 0 or 7", () => {
  const c = parseCron("*/15 9-11 1,15 * 0");
  assertEquals([...c.minute], [0, 15, 30, 45]);
  assertEquals([...c.hour], [9, 10, 11]);
  assertEquals([...c.dom], [1, 15]);
  assertEquals([...parseCron("0 0 * * 7").dow], [0]);
  assertEquals([...parseCron("5/20 * * * *").minute], [5, 25, 45]);
});

Deno.test("cron: an expression with a mistake says which field", () => {
  assertThrows(() => parseCron("* * * *"), Error, "five fields");
  assertThrows(() => parseCron("61 * * * *"), Error, "minute");
  assertThrows(() => parseCron("* 24 * * *"), Error, "hour");
  assertThrows(() => parseCron("* * 0 * *"), Error, "day of month");
  assertThrows(() => parseCron("* * * 13 *"), Error, "month");
  assertThrows(() => parseCron("*/0 * * * *"), Error, "step");
  assertThrows(() => parseCron("a * * * *"), Error, "not understood");
});

Deno.test("cron: the next fire is strictly after, and skips to the right day", () => {
  assertEquals(fire("0 2 * * *", at(2026, 10, 14, 14, 42)), at(2026, 10, 15, 2, 0).getTime());
  assertEquals(fire("0 2 * * *", at(2026, 10, 15, 2, 0)), at(2026, 10, 16, 2, 0).getTime());
  assertEquals(fire("*/5 * * * *", at(2026, 10, 14, 14, 42)), at(2026, 10, 14, 14, 45).getTime());
  // 2026-10-14 is a Wednesday: weekdays at 9 → the next is Thursday
  assertEquals(fire("0 9 * * 1-5", at(2026, 10, 14, 9, 0)), at(2026, 10, 15, 9, 0).getTime());
  // Friday → Monday
  assertEquals(fire("0 9 * * 1-5", at(2026, 10, 16, 9, 0)), at(2026, 10, 19, 9, 0).getTime());
  // a month in the year, and the end of the year
  assertEquals(fire("30 8 1 1 *", at(2026, 10, 14)), at(2027, 1, 1, 8, 30).getTime());
});

Deno.test("cron: day of month and day of week together mean either", () => {
  // the 15th, or any Monday
  assertEquals(fire("0 0 15 * 1", at(2026, 10, 13)), at(2026, 10, 15).getTime()); // Thu 15th beats Mon 19th
  assertEquals(fire("0 0 15 * 1", at(2026, 10, 15)), at(2026, 10, 19).getTime());
});

Deno.test("cron: a day that never comes gives null", () => {
  assertEquals(nextFire("0 0 31 2 *", at(2026, 1, 1)), null);
});

Deno.test("at: a clock time is the next time the clock says it; relative; ISO; past and nonsense refused", () => {
  const now = at(2026, 10, 14, 14, 42);
  assertEquals(new Date(parseAt("02:00", now)).getTime(), at(2026, 10, 15, 2, 0).getTime());
  assertEquals(new Date(parseAt("23:30", now)).getTime(), at(2026, 10, 14, 23, 30).getTime());
  assertEquals(new Date(parseAt("+90m", now)).getTime(), now.getTime() + 90 * 60_000);
  assertEquals(new Date(parseAt("+2h", now)).getTime(), now.getTime() + 2 * 3_600_000);
  assertEquals(new Date(parseAt("2026-10-15T02:00", now)).getTime(), at(2026, 10, 15, 2, 0).getTime());
  assertEquals(parseAt("2026-10-15T02:00:00Z", now), "2026-10-15T02:00:00.000Z");
  assertThrows(() => parseAt("2026-10-13T02:00", now), Error, "already past");
  assertThrows(() => parseAt("25:00", now), Error, "not a time");
  assertThrows(() => parseAt("tonight", now), Error, "not understood");
});

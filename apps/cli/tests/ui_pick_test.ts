// Tests for the picker's rules (apps/ui/src/pages/pick/model.ts): what comes next and how far off it is.
import { assertEquals } from "jsr:@std/assert@1";
import { countdown, minutes, upNext } from "../../ui/src/pages/pick/model.ts";

Deno.test("minutes: HH:MM from midnight, nothing else", () => {
  assertEquals(minutes("09:30"), 570);
  assertEquals(minutes(null), null);
  assertEquals(minutes("all day"), null);
});

Deno.test("upNext: the first two after now, in time order", () => {
  const xs = [{ time: "18:30" }, { time: "09:00" }, { time: "17:30" }, { time: null }, { time: "20:00" }];
  assertEquals(upNext(xs, 16 * 60 + 40), [{ time: "17:30" }, { time: "18:30" }]);
  assertEquals(upNext(xs, 22 * 60), []);
});

Deno.test("countdown: minutes under the hour, then hours and the rest", () => {
  assertEquals(countdown(1000, 1050), { n: 50, unit: "min", rest: 0 });
  assertEquals(countdown(600, 730), { n: 2, unit: "h", rest: 10 });
  assertEquals(countdown(700, 600), { n: 0, unit: "min", rest: 0 });
});

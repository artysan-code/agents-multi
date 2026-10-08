// Tests for the Today page's rules (apps/ui/src/pages/today/model.ts): the task groups, the lanes of
// the day's line, what comes next and the debrief in one sentence.
import { assertEquals } from "jsr:@std/assert@1";
import {
  countdown,
  daysBetween,
  dayWindow,
  firstSentence,
  groupOf,
  groupTasks,
  lanes,
  minutes,
  seenEnd,
  upNext,
} from "../../ui/src/pages/today/model.ts";

const T = "2026-10-07";

Deno.test("groupOf: waiting and other people's first, then late, today, in progress", () => {
  assertEquals(groupOf({ id: "1", status: "todo", due: "2026-10-01" }, T, "me"), "late");
  assertEquals(groupOf({ id: "2", status: "todo", due: T }, T, "me"), "today");
  assertEquals(groupOf({ id: "3", status: "doing" }, T, "me"), "doing");
  assertEquals(groupOf({ id: "4", status: "doing", due: T }, T, "me"), "today");
  assertEquals(groupOf({ id: "5", status: "waiting", due: "2026-10-01" }, T, "me"), "wait");
  assertEquals(groupOf({ id: "6", status: "doing", owner: "claude" }, T, "me"), "wait");
  assertEquals(groupOf({ id: "7", status: "todo", owner: "me", due: T }, T, "me"), "today");
  assertEquals(groupOf({ id: "8", status: "todo" }, T, "me"), null);
  assertEquals(groupOf({ id: "9", status: "done", due: T }, T, "me"), null);
  assertEquals(groupOf({ id: "10", status: "dropped", due: "2026-10-01" }, T, "me"), null);
});

Deno.test("groupTasks: late by due, today by time, Claude first among the waiting", () => {
  const g = groupTasks(
    [
      { id: "b", status: "todo", due: "2026-10-05" },
      { id: "a", status: "todo", due: "2026-10-02" },
      { id: "d", status: "todo", due: T, time: "18:00" },
      { id: "c", status: "todo", due: T, time: "09:00" },
      { id: "e", status: "todo", due: T },
      { id: "w", status: "waiting", owner: "ann" },
      { id: "cl", status: "doing", owner: "claude" },
    ],
    T,
    "me",
  );
  assertEquals(g.late.map((x) => x.id), ["a", "b"]);
  assertEquals(g.today.map((x) => x.id), ["c", "d", "e"]);
  assertEquals(g.wait.map((x) => x.id), ["cl", "w"]);
  assertEquals(g.doing, []);
});

Deno.test("minutes and daysBetween", () => {
  assertEquals(minutes("09:30"), 570);
  assertEquals(minutes(null), null);
  assertEquals(minutes("all day"), null);
  assertEquals(daysBetween("2026-10-05", T), 2);
  assertEquals(daysBetween("2026-10-31", "2026-11-01"), 1);
});

Deno.test("lanes: overlapping items go to separate lanes, freed lanes are reused", () => {
  assertEquals(lanes([{ start: 0, end: 30 }, { start: 10, end: 40 }, { start: 30, end: 60 }]), [0, 1, 0]);
  // a fourth overlap goes to the lane that frees first
  assertEquals(lanes([{ start: 0, end: 50 }, { start: 0, end: 20 }, { start: 0, end: 40 }, { start: 5, end: 10 }]), [
    0,
    1,
    2,
    1,
  ]);
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

Deno.test("firstSentence: the first sentence, plain, cut on a word", () => {
  assertEquals(
    firstSentence("**Light** afternoon: one [[progetti/x|release]]. Then more."),
    "Light afternoon: one release.",
  );
  assertEquals(firstSentence("no full stop at all"), "no full stop at all");
  const long = "word ".repeat(60) + ".";
  const s = firstSentence(long, 40);
  assertEquals(s.endsWith("…"), true);
  assertEquals(s.length <= 40, true);
});

Deno.test("dayWindow: 08–21, widened to what lies outside", () => {
  assertEquals(dayWindow([]), { from: 480, to: 1260 });
  assertEquals(dayWindow([{ start: 7 * 60 + 30, end: 8 * 60 }, { start: 21 * 60, end: 22 * 60 + 15 }]), {
    from: 420,
    to: 1380,
  });
});

Deno.test("seenEnd: a short item keeps its lane until its title ends, so the next one goes below", () => {
  // 2 px a minute: a 60-minute event with a 30-character title is seen until 0 + (34 + 192) / 2 = 113
  const a = { start: 0, end: 60 }, b = { start: 90, end: 150 };
  assertEquals(seenEnd(a, 30, 2), 113);
  assertEquals(seenEnd(a, 2, 2), 60); // a title that fits ends with the item
  assertEquals(seenEnd(a, 30, 0), 60); // not measured yet: the time alone
  assertEquals(lanes([a, b]), [0, 0]);
  assertEquals(lanes([{ ...a, end: seenEnd(a, 30, 2) }, b]), [0, 1]);
});

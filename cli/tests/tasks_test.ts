// Tests for shared/mcp/lib/tasks.ts: the file format, repeats, the brief and the reminders, with a
// fixed clock; the store on a throwaway directory.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";

const dir = await Deno.makeTempDir();
Deno.env.set("CLAUDE_MULTI_TASKS", dir);
const T = await import("../../shared/mcp/lib/tasks.ts");

const at = (s: string) => new Date(s); // local time, no Z
const task = (over: Partial<import("../../shared/mcp/lib/tasks.ts").Task>) =>
  ({ id: "t-x", title: "x", status: "todo" as const, created: "2026-09-29T08:00:00.000Z", updated: "2026-09-29T08:00:00.000Z", owner: "samuel", ...over });

Deno.test("file format: round trip, quoting, notes after the title", () => {
  const t = task({ id: "t-20260930-abcdef", title: 'Chiamare "Mario": fattura', due: "2026-10-01", time: "10:30", priority: 1, notes: "riga uno\n\nriga due" });
  const back = T.fromFile(T.toFile(t));
  assertEquals(back, t);
  assertEquals(T.fromFile("not a task"), null);
});

Deno.test("nextDue: daily, weekly, monthly clamped to the month's end, weekdays skip the weekend", () => {
  assertEquals(T.nextDue("2026-09-30", "daily"), "2026-10-01");
  assertEquals(T.nextDue("2026-09-30", "weekly"), "2026-10-07");
  assertEquals(T.nextDue("2026-01-31", "monthly"), "2026-02-28");
  assertEquals(T.nextDue("2026-10-02", "weekdays"), "2026-10-05"); // Friday → Monday
});

Deno.test("applyInput: checks what it is given, null clears", () => {
  const now = at("2026-09-30T10:00:00");
  assertThrows(() => T.applyInput(task({}), { due: "2026-02-30" }, now), Error, "due");
  assertThrows(() => T.applyInput(task({}), { time: "25:00", due: "2026-10-01" }, now), Error, "time");
  assertThrows(() => T.applyInput(task({}), { time: "10:00" }, now), Error, "needs a day");
  assertEquals(T.applyInput(task({ due: "2026-10-01" }), { due: null }, now).due, undefined);
  assertEquals(T.applyInput(task({}), { status: "done" }, now).done, now.toISOString());
});

Deno.test("brief: overdue, missed, the rest of today by time, tomorrow, waiting on others", () => {
  const now = at("2026-09-30T11:00:00");
  const b = T.brief([
    task({ id: "a", title: "old", due: "2026-09-28" }),
    task({ id: "b", title: "at 9", due: "2026-09-30", time: "09:00" }),
    task({ id: "c", title: "at 15", due: "2026-09-30", time: "15:00" }),
    task({ id: "d", title: "sometime today", due: "2026-09-30" }),
    task({ id: "e", title: "tomorrow", due: "2026-10-01" }),
    task({ id: "f", title: "in two days", due: "2026-10-02" }),
    task({ id: "g", title: "Luca sends the quote", owner: "luca" }),
    task({ id: "h", title: "done", status: "done", done: at("2026-09-30T09:30:00").toISOString() }),
  ], now);
  assertEquals(b.overdue.map((t) => t.id), ["a"]);
  assertEquals(b.missed.map((t) => t.id), ["b"]);
  assertEquals(b.today.map((t) => t.id), ["c", "d"]);
  assertEquals(b.tomorrow.map((t) => t.id), ["e"]);
  assertEquals(b.upcoming.map((t) => t.id), ["f"]);
  assertEquals(b.waiting.map((t) => t.id), ["g"]);
  assertEquals(b.doneToday, 1);
  assertEquals(b.moment, "morning");
});

Deno.test("reminders: from the warning time, once, never more than an hour late", () => {
  const t = task({ id: "r", due: "2026-09-30", time: "15:00", remind: 10 });
  assertEquals(T.dueReminders([t], at("2026-09-30T14:49:00"), new Set(), 15).length, 0);
  const due = T.dueReminders([t], at("2026-09-30T14:51:00"), new Set(), 15);
  assertEquals(due.length, 1);
  assertEquals(T.dueReminders([t], at("2026-09-30T14:55:00"), new Set([due[0].key]), 15).length, 0);
  assertEquals(T.dueReminders([t], at("2026-09-30T16:30:00"), new Set(), 15).length, 0);
});

Deno.test("dueBriefs: reached today, within the hour, once", () => {
  const s = { briefs: ["08:30", "13:30", "bad"], remind: 15 };
  assertEquals(T.dueBriefs(s, at("2026-09-30T08:40:00"), new Set()), ["08:30"]);
  assertEquals(T.dueBriefs(s, at("2026-09-30T08:40:00"), new Set(["brief@2026-09-30T08:30"])), []);
  assertEquals(T.dueBriefs(s, at("2026-09-30T12:00:00"), new Set()), []);
});

Deno.test("store: add, complete a repeating task and get the next one, drop instead of delete", async () => {
  const now = at("2026-09-30T10:00:00");
  const t = await T.addTask({ title: "Backup", due: "2026-09-30", repeat: "weekly" }, now);
  assertEquals(t.owner, "samuel");
  const { task: done, next } = await T.updateTask(t.id, { status: "done" }, now);
  assertEquals(done.status, "done");
  assertEquals(next?.due, "2026-10-07");
  assertEquals(next?.status, "todo");
  await T.updateTask(next!.id, { status: "dropped" }, now);
  const all = await T.listTasks();
  assertEquals(all.length, 2);
  assert(all.every((x) => x.status === "done" || x.status === "dropped"));
});

Deno.test("briefText: evening looks at tomorrow; nothing to say is marked empty", async () => {
  const { briefText } = await import("../tasks.ts");
  const evening = T.brief([task({ id: "e", title: "Dentista", due: "2026-10-01", time: "09:00" })], at("2026-09-30T19:00:00"));
  const t = briefText(evening, "it");
  assertEquals(t.title, "claude-multi — Stasera");
  assertEquals(t.body, "domani: 09:00 Dentista");
  assertEquals(briefText(T.brief([], at("2026-09-30T08:30:00")), "it").empty, true);
});

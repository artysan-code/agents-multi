// The Tasks view (console/tasks-view.ts): the day with its times first, late ones apart, the rest by project.
import { assertEquals } from "jsr:@std/assert@1";
import type { Task } from "../../../shared/mcp/lib/tasks.ts";
import { tasksView } from "../console/tasks-view.ts";
import { boardUrl, upstream } from "../memory.ts";

const now = new Date(2026, 9, 15, 10, 0);
const t = (id: string, o: Partial<Task> = {}): Task => ({
  id,
  title: id,
  status: "todo",
  created: "2026-10-01T00:00:00Z",
  updated: "2026-10-01T00:00:00Z",
  ...o,
});

Deno.test("tasksView: today by time, late apart, the rest by project", () => {
  const v = tasksView([
    t("a-untimed", { due: "2026-10-15" }),
    t("b-late", { due: "2026-10-12", project: "work/x" }),
    t("c-timed", { due: "2026-10-15", time: "09:30" }),
    t("d-cal", { due: "2026-10-15", time: "08:00", source: "calendar" }),
    t("e-later", { due: "2026-10-20", project: "work/x" }),
    t("f-free"),
    t("g-other", { project: "personal/y" }),
    t("h-done", { status: "done", due: "2026-10-15" }),
    t("i-dropped", { status: "dropped", project: "work/x" }),
    t("j-waiting", { status: "waiting", project: "personal/y" }),
  ], now);
  assertEquals(v.day, "2026-10-15");
  assertEquals(v.today.map((x) => x.id), ["d-cal", "c-timed", "a-untimed"]);
  assertEquals(v.overdue.map((x) => x.id), ["b-late"]);
  assertEquals(v.projects.map((p) => [p.project, p.tasks.map((x) => x.id)]), [
    ["personal/y", ["g-other", "j-waiting"]],
    ["work/x", ["e-later"]],
    [null, ["f-free"]],
  ]);
});

Deno.test("tasksView: an overdue calendar entry is not a task to be late on", () => {
  const v = tasksView([t("old-event", { due: "2026-10-01", source: "calendar" })], now);
  assertEquals([v.today, v.overdue, v.projects], [[], [], []]);
});

Deno.test("memory: only the page and the search reach the brain, with only their parameters", () => {
  assertEquals(
    upstream("https://b.example/", new URL("http://x/api/brain/search?q=a+b&limit=5&evil=1")),
    "https://b.example/api/brain/search?q=a+b&limit=5",
  );
  assertEquals(
    upstream("https://b.example", new URL("http://x/api/brain/page?path=progetti%2Ffoo")),
    "https://b.example/api/brain/page?path=progetti%2Ffoo",
  );
  assertEquals(upstream("https://b.example", new URL("http://x/api/brain/pages")), null);
  assertEquals(upstream("https://b.example", new URL("http://x/api/brain/health")), null);
  assertEquals(boardUrl("https://b.example//"), "https://b.example/board");
});

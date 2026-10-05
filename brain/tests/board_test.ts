// Tests for the board (board.ts): what each column shows, the edit form as a task input, where a
// change may send the browser back to, and the routes on a list of tasks kept in memory.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { backTo, boardRoute, columns, editInput } from "../board.ts";
import { type Task, useTaskStore } from "../../shared/mcp/lib/tasks.ts";
import { ownerFrom, useOwner } from "../../shared/mcp/lib/owner.ts";

const NOW = new Date("2026-10-05T10:00:00");
const T = (id: string, x: Partial<Task> = {}): Task => ({ id, title: id, status: "todo", created: "2026-10-01T00:00:00Z", updated: "2026-10-01T00:00:00Z", ...x });

function memory(tasks: Task[]) {
  const m = new Map(tasks.map((t) => [t.id, structuredClone(t)]));
  useTaskStore({ list: () => Promise.resolve([...m.values()]), get: (id) => Promise.resolve(m.get(id) ?? null), write: (t) => { m.set(t.id, structuredClone(t)); return Promise.resolve(); } });
  return m;
}
const render = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html" } });
const me = { id: "ann", name: "Ann" };
useOwner(() => ownerFrom({ id: "ann", name: "Ann", language: "Italian" })); // what main.ts does for the signed-in account
const post = (path: string, f: Record<string, string>) => new Request(`https://b.test${path}`, { method: "POST", body: new URLSearchParams(f) });
const go = (req: Request) => boardRoute(req, new URL(req.url), me, render, NOW);

Deno.test("board: columns by status, late first, done only from the last week, filters by project and words", () => {
  const cols = columns([
    T("t-1-a", { due: "2026-10-09" }), T("t-1-b", { due: "2026-10-01", project: "work/x" }), T("t-1-c"),
    T("t-1-d", { status: "done", done: "2026-10-04T10:00:00Z" }), T("t-1-e", { status: "done", done: "2026-09-01T10:00:00Z" }),
    T("t-1-f", { status: "dropped" }), T("t-1-g", { status: "waiting", labels: ["cliente"] }),
  ], {}, NOW);
  assertEquals(cols.get("todo")!.map((t) => t.id), ["t-1-b", "t-1-a", "t-1-c"]);
  assertEquals(cols.get("done")!.map((t) => t.id), ["t-1-d"]);
  assertEquals(cols.get("waiting")!.length, 1);
  assertEquals(columns([T("t-1-b", { project: "work/x/y" }), T("t-1-c", { project: "work/xy" })], { project: "work/x" }, NOW).get("todo")!.map((t) => t.id), ["t-1-b"]);
  assertEquals(columns([T("t-1-g", { labels: ["cliente"] }), T("t-1-h")], { q: "CLIENTE" }, NOW).get("todo")!.map((t) => t.id), ["t-1-g"]);
});

Deno.test("board: the edit form clears empty fields; back goes to board pages only", () => {
  const i = editInput(new URLSearchParams({ title: " Ciao ", status: "doing", due: "", priority: "1", labels: "a, b", project: "" }));
  assertEquals([i.title, i.due, i.priority, i.labels, i.project, i.time], ["Ciao", null, 1, ["a", " b"], null, null]);
  assertEquals(editInput(new URLSearchParams({ priority: "" })).priority, null);
  assertEquals(backTo("/tasks?project=work%2Fx", "/x"), "/tasks?project=work%2Fx");
  assertEquals(backTo("/tasks/t-1-a", "/x"), "/tasks/t-1-a");
  for (const bad of ["https://evil.example/", "//evil.example", "/account", "/tasks/../x", null]) assertEquals(backTo(bad, "/tasks"), "/tasks");
});

Deno.test("board routes: the page, add, start, tick a step, a note, edit; errors come back on the page", async () => {
  const m = memory([T("t-1-a", { notes: "Il perché.\n\n## Steps\n\n- [ ] uno\n- [ ] due", project: "p" }), T("t-1-r", { repeat: "weekly", due: "2026-10-05" })]);
  const page = await (await go(new Request("https://b.test/tasks"))).text();
  assertStringIncludes(page, "Le task di Ann");
  assertStringIncludes(page, "0/2");
  let r = await go(post("/tasks/add", { title: "Nuova <b>", project: "p", due: "2026-10-06", back: "/tasks?project=p" }));
  assertEquals([r.status, r.headers.get("location")], [303, "/tasks?project=p"]);
  const added = [...m.values()].find((t) => t.title === "Nuova <b>")!;
  assertEquals([added.owner, added.due], ["ann", "2026-10-06"]);
  assert(!(await (await go(new Request("https://b.test/tasks"))).text()).includes("Nuova <b>"), "titles are escaped");
  await go(post("/tasks/t-1-a/status", { status: "doing", back: "/tasks" }));
  assertEquals(m.get("t-1-a")!.status, "doing");
  await go(post("/tasks/t-1-a/step", { index: "1" }));
  assertStringIncludes(m.get("t-1-a")!.notes!, "- [x] due");
  await go(post("/tasks/t-1-a/note", { section: "decisions", text: "si fa così" }));
  assertStringIncludes(m.get("t-1-a")!.notes!, "2026-10-05 · si fa così");
  const detail = await (await go(new Request("https://b.test/tasks/t-1-a"))).text();
  assertStringIncludes(detail, "si fa così");
  assertStringIncludes(detail, "Il perché.");
  assert(!detail.includes("## Steps"), "the sections are not shown as text");
  r = await go(post("/tasks/t-1-a/edit", { base: m.get("t-1-a")!.updated, title: "Rinominata", status: "doing", time: "10:00", labels: "x" }));
  assertEquals(r.headers.get("location"), "/tasks/t-1-a?err=" + encodeURIComponent("a time needs a day: set due too"));
  r = await go(post("/tasks/t-1-a/edit", { base: "vecchio", title: "Rinominata", status: "doing" }));
  assertStringIncludes(decodeURIComponent(r.headers.get("location")!), "Qualcuno l'ha cambiata");
  await go(post("/tasks/t-1-a/edit", { base: m.get("t-1-a")!.updated, title: "Rinominata", status: "doing", labels: "x, y" }));
  assertEquals([m.get("t-1-a")!.title, m.get("t-1-a")!.labels], ["Rinominata", ["x", "y"]]);
  // a repeating task done on the board makes its next one, as in a chat
  await go(post("/tasks/t-1-r/status", { status: "done" }));
  assertEquals([...m.values()].filter((t) => t.repeat === "weekly" && t.status === "todo").map((t) => t.due), ["2026-10-12"]);
  assertEquals((await go(new Request("https://b.test/tasks/t-9-zz"))).status, 404);
});

// Tests for shared/mcp/tasks/tools.ts: the task tools on a throwaway file store, called the way an
// MCP client calls them — references by ref, notes that grow without being rewritten, what a
// completed task unblocks.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

Deno.env.set("CLAUDE_MULTI_TASKS", await Deno.makeTempDir());
Deno.env.set("CLAUDE_MULTI_OWNER_ID", "samuel");
const { registerTaskTools } = await import("../../../shared/mcp/tasks/tools.ts");

type Handler = (input: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
const tools = new Map<string, Handler>();
registerTaskTools({ registerTool: (name: string, _def: unknown, h: Handler) => tools.set(name, h) } as never);
// deno-lint-ignore no-explicit-any
const call = async (name: string, input: Record<string, unknown>): Promise<any> =>
  JSON.parse((await tools.get(name)!(input)).content[0].text);

Deno.test("task tools: a project's tasks by ref, phases and blockers, log and decisions, the archive", async () => {
  const p = "work/acme/site";
  const big = (await call("tasks_add", {
    title: "Permessi v2",
    project: p,
    ref: "TASK-430",
    stage: "spec",
    detail: "TASKS.md#task-430",
  })).task;
  await assertRejects(() => call("tasks_add", { title: "doppione", project: p, ref: "task-430" }), Error, "already");
  const f0 =
    (await call("tasks_add", { title: "F0 catalogo", project: p, ref: "TASK-430-F0", parent: "TASK-430" })).task;
  const f1 = (await call("tasks_add", {
    title: "F1 identità",
    project: p,
    ref: "TASK-430-F1",
    parent: "TASK-430",
    blocked_by: ["TASK-430-F0"],
  })).task;
  assertEquals([f0.parent, f1.blocked_by], [big.id, [f0.id]]);
  await assertRejects(() => call("tasks_update", { id: "TASK-430", parent: "TASK-430-F0" }), Error, "circle");

  const got = await call("tasks_get", { id: "TASK-430", project: p });
  assertEquals(got.parts_done, "0/2");
  assert((await call("tasks_get", { id: f1.id })).waiting_for[0].includes("TASK-430-F0"));
  assert(
    (await call("tasks_list", { project: "work/acme" })).tasks.find((t: { id: string; blocked?: boolean }) =>
      t.id === f1.id
    ).blocked,
  );

  await call("tasks_note", { id: "TASK-430", section: "decisions", text: "ruoli in DB (Samuel)" });
  await call("tasks_note", { id: "TASK-430", section: "log", text: "F0 su dev" });
  await call("tasks_edit", { id: "TASK-430", find: "F0 su dev", replace: "F0 su dev, CI verde" });
  const notes = (await call("tasks_get", { id: big.id })).task.notes as string;
  assert(
    /## Decisions\n\n- \d{4}-\d{2}-\d{2} · ruoli in DB \(Samuel\)/.test(notes) &&
      notes.includes("· F0 su dev, CI verde"),
  );

  await call("tasks_update", { id: big.id, notes: "x".repeat(400) + "\n\n" + notes });
  assert((await call("tasks_list", { ref: "TASK-430" })).tasks[0].notes.endsWith("full: true)"));
  assertEquals((await call("tasks_list", { ref: "TASK-430", full: true })).tasks[0].notes.length, 402 + notes.length);

  const d0 = await call("tasks_done", { id: "TASK-430-F0" });
  assert(d0.unblocked[0].includes("TASK-430-F1") && !d0.all_parts_done);
  const d1 = await call("tasks_done", { id: "TASK-430-F1", project: p });
  assert(d1.all_parts_done.includes("TASK-430"));
  assertEquals((await call("tasks_list", { project: p })).count, 1);
  assertEquals((await call("tasks_list", { project: p, status: "all" })).count, 3);
  assertEquals((await call("tasks_list", { parent: "TASK-430", status: "done" })).count, 2);
});

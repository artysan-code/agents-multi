// refs.ts — how tasks refer to each other: ref, parent, blocked_by.

import type { Task, TaskInput } from "./types.ts";

export const ID = /^t-[\w-]+$/;

// ---------------------------------------------------------------- references between tasks
/** Pure: the task a reference names — its id (t-…, #t-…) or its ref (TASK-495, any case). A ref is
 *  looked for in `project` first; one that names several tasks, or none, is an error that says so. */
export function resolveTask(tasks: Task[], key: string, project?: string): Task {
  const k = key.trim().replace(/^#(?=t-)/, "");
  if (ID.test(k)) {
    const t = tasks.find((x) => x.id === k);
    if (!t) throw new Error(`no task ${k}`);
    return t;
  }
  const named = tasks.filter((x) => x.ref?.toLowerCase() === k.toLowerCase());
  const here = project ? named.filter((x) => x.project === project) : [];
  const pick = here.length ? here : named;
  if (pick.length === 1) return pick[0];
  if (!pick.length) throw new Error(`no task with id or ref ${k}`);
  const live = pick.filter((x) => x.status !== "done" && x.status !== "dropped");
  if (live.length === 1) return live[0];
  throw new Error(
    `${pick.length} tasks have ref ${k} (${
      pick.map((x) => `${x.id} in ${x.project ?? "no project"}`).join(", ")
    }): give the project or the id`,
  );
}
/** Pure: another open task of the same project already called `ref`, if there is one. */
export function refTaken(tasks: Task[], ref: string, project: string | undefined, self?: string): Task | null {
  return tasks.find((x) =>
    x.id !== self && x.project === project && x.ref?.toLowerCase() === ref.toLowerCase() && x.status !== "dropped"
  ) ?? null;
}
const closed = (t: Task) => t.status === "done" || t.status === "dropped";
/** Pure: how a task stands with the others — its parts, what it waits for still open, what waits for it. */
export function relations(tasks: Task[], t: Task) {
  const byId = new Map(tasks.map((x) => [x.id, x]));
  const parts = tasks.filter((x) => x.parent === t.id);
  return {
    parent: t.parent ? byId.get(t.parent) ?? null : null,
    parts,
    parts_done: parts.filter(closed).length,
    waiting_for: (t.blocked_by ?? []).map((id) => byId.get(id)).filter((x): x is Task => !!x && !closed(x)),
    blocking: tasks.filter((x) => !closed(x) && x.blocked_by?.includes(t.id)),
  };
}
/** Pure: whether anything the task waits for is still open. */
export function isBlocked(tasks: Task[], t: Task): boolean {
  return relations(tasks, t).waiting_for.length > 0;
}
/** Pure: whether making `parent` the parent of `id` would go round in a circle. */
export function wouldLoop(tasks: Task[], id: string, parent: string): boolean {
  const byId = new Map(tasks.map((x) => [x.id, x]));
  for (let cur: string | undefined = parent, n = 0; cur && n < 100; cur = byId.get(cur)?.parent, n++) {
    if (cur === id) return true;
  }
  return false;
}

/** Pure: an input with its references to other tasks turned into ids and checked against the list:
 *  a ref taken in the project, a parent that would go round in a circle. */
export function resolveRefs(all: Task[], input: TaskInput, self: Task | null): TaskInput {
  const project = input.project === undefined ? self?.project : input.project ?? undefined;
  const out = { ...input };
  if (input.parent) {
    out.parent = resolveTask(all, input.parent, project).id;
    if (self && wouldLoop(all, self.id, out.parent)) {
      throw new Error("that parent is a part of this task: it would go round in a circle");
    }
  }
  if (input.blocked_by) out.blocked_by = input.blocked_by.map((b) => resolveTask(all, b, project).id);
  const ref = input.ref === undefined ? self?.ref : input.ref ?? undefined;
  if (ref && (input.ref !== undefined || input.project !== undefined)) {
    const other = refTaken(all, ref, project, self?.id);
    if (other) {
      throw new Error(`${ref} is already ${other.id} (${other.title}) in ${project ?? "no project"}: update that one`);
    }
  }
  return out;
}

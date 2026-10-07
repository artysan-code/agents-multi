// tools.ts — the task tools, registered on any MCP server: the local one (server.ts, stdio, the
// files under ~/brains/tasks) and the brain service (brain/, over HTTP, its own database). What
// they read and write is whichever store shared/mcp/lib/tasks.ts was given.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { z } from "npm:zod@4.6.5";
import {
  addAttachment,
  addNote,
  addStep,
  addTask,
  attachments,
  brief,
  dayOf,
  editNotes,
  getTask,
  hhmm,
  isBlocked,
  listTasks,
  progress,
  relations,
  REPEATS,
  resolveRefs,
  resolveTask,
  setStep,
  STATUSES,
  steps,
  type Task,
  type TaskInput,
  updateTask,
  zone,
} from "../lib/tasks.ts";
import { owner } from "../lib/owner.ts";

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });
const clock = () => {
  const now = new Date();
  return {
    today: dayOf(now),
    now: hhmm(now),
    weekday: now.toLocaleDateString("en-GB", { weekday: "long", timeZone: zone() }),
  };
};
/** A task as a line: easy to read back to the owner, the id kept for the next call. `all` (the
 *  whole list) lets it say when the task waits for another still open. */
const line = (t: Task, all?: Task[]) => {
  const p = progress(t.notes);
  return [
    t.due && t.due !== dayOf(new Date()) ? t.due : null,
    t.time,
    t.ref,
    t.title,
    t.project ? `[${t.project}]` : null,
    t.owner && t.owner !== owner().id ? `(${t.owner})` : null,
    t.status === "doing" ? "in progress" : null,
    t.stage,
    all && isBlocked(all, t) ? "blocked" : null,
    p ? `${p.done}/${p.total}` : null,
    t.priority === 1 ? "!" : null,
    `#${t.id}`,
  ]
    .filter(Boolean).join(" · ");
};

const key = z.string().describe("the task: its id (t-…) or its ref in its project (TASK-495)");
/** The fields of a task as tools take them; built per server, so `owner` names the person it serves. */
const taskFields = () => ({
  due: z.string().nullable().optional().describe(
    "day, YYYY-MM-DD (resolve relative days from `today` in any answer); null clears",
  ),
  time: z.string().nullable().optional().describe("hour of that day, HH:MM, 24h; null clears"),
  remind: z.number().int().nullable().optional().describe("minutes of warning before `time` (default 15)"),
  owner: z.string().nullable().optional().describe(
    `who has to move: ${owner().id} (default: the owner), claude, or someone's name — then it is waiting on them`,
  ),
  project: z.string().nullable().optional().describe(
    "the project's folder under $HOME when there is one (work/acme/site, personal/blog), otherwise a short name (agents-multi)",
  ),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable().optional().describe(
    "1 high, 2 normal, 3 low",
  ),
  repeat: z.enum(REPEATS as [string, ...string[]]).nullable().optional().describe("completing it creates the next one"),
  ref: z.string().nullable().optional().describe(
    "the project's own name for the task (TASK-495, P2-45): one open task per ref in a project",
  ),
  stage: z.string().nullable().optional().describe(
    "where it is in the project's own flow (spec, discovery, release pending…); the board column stays `status`",
  ),
  parent: z.string().nullable().optional().describe("the task this is a part of (a phase of a larger task): id or ref"),
  blocked_by: z.array(z.string()).nullable().optional().describe(
    "the tasks that have to be done first: ids or refs; the whole list, [] or null clears",
  ),
  labels: z.array(z.string()).nullable().optional().describe("free labels, the whole list"),
  detail: z.string().nullable().optional().describe(
    "where the full detail lives when the project keeps it elsewhere: a path in the repository (TASKS.md#task-495), a URL, a [[page]]",
  ),
  notes: z.string().nullable().optional().describe(
    "the whole Markdown body: description, `- [ ]` steps, `## Log`, `## Decisions`, `## Attachments`. It replaces what is there: to change a part use tasks_edit, to add use tasks_note / tasks_steps / tasks_attach",
  ),
});

/** The task a key names, read fresh. */
async function find(k: string, project?: string): Promise<Task> {
  const id = k.trim().replace(/^#(?=t-)/, "");
  if (/^t-[\w-]+$/.test(id)) {
    const t = await getTask(id);
    if (!t) throw new Error(`no task ${id}`);
    return t;
  }
  return resolveTask(await listTasks(), id, project);
}

const open = (t: Task) => t.status !== "done" && t.status !== "dropped";

export function registerTaskTools(server: McpServer) {
  const fields = taskFields();
  server.registerTool("tasks_brief", {
    description:
      "The owner's debrief: what is overdue, what was missed earlier today, the rest of today by time, tomorrow, the next days, what waits on others. " +
      "Call it when the owner asks for a debrief, what they have today or tomorrow, or when the day's plan is the topic. For the full picture add their calendar " +
      "(the google server's calendar tools). Read it back briefly: times first, then the rest; mention overdue items plainly.",
    inputSchema: {},
  }, async () => {
    const all = await listTasks();
    const b = brief(all, new Date());
    const l = (t: Task) => line(t, all);
    return text({
      ...clock(),
      moment: b.moment,
      overdue: b.overdue.map(l),
      missed: b.missed.map(l),
      later_today: b.today.map(l),
      tomorrow: b.tomorrow.map(l),
      next_days: b.upcoming.map(l),
      no_date: b.undated.slice(0, 10).map(l),
      waiting_on_others: b.waiting.map(l),
      done_today: b.doneToday,
    });
  });

  server.registerTool("tasks_list", {
    description:
      "Search the tasks: by status, project (with its subfolders), owner, a day range, ref, stage, label, parent, or words in the title and notes. " +
      "Open tasks only unless a status is given; `all` includes the done and dropped ones (the archive). Notes are cut at 300 characters unless `full`.",
    inputSchema: {
      status: z.enum(["all", ...STATUSES] as [string, ...string[]]).optional(),
      project: z.string().optional(),
      owner: z.string().optional(),
      from: z.string().optional().describe("due on or after, YYYY-MM-DD"),
      to: z.string().optional().describe("due on or before, YYYY-MM-DD"),
      ref: z.string().optional(),
      stage: z.string().optional(),
      label: z.string().optional(),
      parent: z.string().optional().describe("the parts of this task: id or ref"),
      text: z.string().optional(),
      full: z.boolean().optional().describe("the whole notes of each task"),
      limit: z.number().int().min(1).max(500).optional(),
    },
  }, async (q: {
    status?: string;
    project?: string;
    owner?: string;
    from?: string;
    to?: string;
    ref?: string;
    stage?: string;
    label?: string;
    parent?: string;
    text?: string;
    full?: boolean;
    limit?: number;
  }) => {
    const all = await listTasks();
    const words = q.text?.toLowerCase();
    const parent = q.parent ? resolveTask(all, q.parent, q.project).id : undefined;
    const hits = all.filter((t) =>
      (q.status === "all" ||
        (q.status ? t.status === q.status : t.status === "todo" || t.status === "doing" || t.status === "waiting")) &&
      (!q.project || t.project === q.project || !!t.project?.startsWith(`${q.project}/`)) &&
      (!q.owner || (t.owner ?? owner().id) === q.owner.toLowerCase()) &&
      (!q.from || (t.due ?? "") >= q.from) && (!q.to || (!!t.due && t.due <= q.to)) &&
      (!q.ref || t.ref?.toLowerCase() === q.ref.toLowerCase()) &&
      (!q.stage || t.stage === q.stage.toLowerCase()) &&
      (!q.label || !!t.labels?.includes(q.label.toLowerCase())) &&
      (!parent || t.parent === parent) &&
      (!words || `${t.ref ?? ""} ${t.title} ${t.notes ?? ""}`.toLowerCase().includes(words))
    ).sort((a, b) =>
      (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.time ?? "99").localeCompare(b.time ?? "99")
    );
    return text({
      ...clock(),
      count: hits.length,
      tasks: hits.slice(0, q.limit ?? 50).map((t) => ({
        ...t,
        ...(isBlocked(all, t) ? { blocked: true } : {}),
        ...(t.notes && !q.full && t.notes.length > 300
          ? { notes: `${t.notes.slice(0, 300)}… (cut: tasks_get, or full: true)` }
          : {}),
      })),
    });
  });

  server.registerTool("tasks_add", {
    description:
      'Add a task. Use it whenever the owner says there is something to do ("I need to…", "remind me…", "by Friday…", in whatever language they speak), in any conversation, ' +
      "and say in one line what you added. Put a time only when they gave one. A task of a project that names its tasks gets their `ref`, " +
      "and `detail` when the full story lives in the project (its TASKS.md, a decision file).",
    inputSchema: { title: z.string(), ...fields },
  }, async (input: TaskInput & { title: string }) => {
    const t = await addTask(resolveRefs(await listTasks(), input, null));
    return text({ ...clock(), added: line(t), task: t });
  });

  server.registerTool("tasks_update", {
    description:
      "Change a task: its day, time, owner, project, priority, ref, stage, parent, blocked_by, labels, detail, notes, or status (todo, doing, waiting, done, dropped) — " +
      "the status is its column on the owner's board: set `doing` when work on it starts. Dropped instead of deleting.",
    inputSchema: {
      id: key,
      title: z.string().optional(),
      status: z.enum(STATUSES as [string, ...string[]]).optional(),
      ...fields,
    },
  }, async ({ id, ...input }: TaskInput & { id: string }) => {
    const all = await listTasks();
    const cur = resolveTask(all, id);
    const r = await updateTask(cur.id, resolveRefs(all, input, cur));
    return text({ ...clock(), updated: line(r.task, all), ...(r.next ? { next_occurrence: line(r.next) } : {}) });
  });

  server.registerTool("tasks_get", {
    description:
      "One task in full: its fields, its notes (description, steps, log, decisions, attachments), the steps with their index, the progress, " +
      "and how it stands with the others: its parent, its parts, what it waits for, what waits for it.",
    inputSchema: { id: key, project: z.string().optional().describe("where to look for a ref") },
  }, async ({ id, project }: { id: string; project?: string }) => {
    const all = await listTasks();
    const t = resolveTask(all, id, project);
    const r = relations(all, t);
    return text({
      ...clock(),
      task: t,
      steps: steps(t.notes).map((s, i) => ({ index: i, ...s })),
      progress: progress(t.notes),
      attachments: attachments(t.notes),
      ...(r.parent ? { part_of: line(r.parent, all) } : {}),
      ...(r.parts.length
        ? {
          parts: r.parts.map((x) => `${x.status} · ${line(x, all)}`),
          parts_done: `${r.parts_done}/${r.parts.length}`,
        }
        : {}),
      ...(r.waiting_for.length ? { waiting_for: r.waiting_for.map((x) => line(x, all)) } : {}),
      ...(r.blocking.length ? { blocking: r.blocking.map((x) => line(x, all)) } : {}),
    });
  });

  server.registerTool(
    "tasks_note",
    {
      description:
        "Add a dated line to a task, without rewriting its notes: to its `log` (what happened: released, tried, found) or its `decisions` " +
        "(what was decided, and by whom). A line or two: the story in full belongs where the project keeps it (`detail`).",
      inputSchema: {
        id: key,
        project: z.string().optional().describe("where to look for a ref"),
        section: z.enum(["log", "decisions"]),
        text: z.string().min(1).max(2000),
      },
    },
    async (
      { id, project, section, text: note }: {
        id: string;
        project?: string;
        section: "log" | "decisions";
        text: string;
      },
    ) => {
      const t = await find(id, project);
      const r = await updateTask(
        t.id,
        (cur) => ({ notes: addNote(cur.notes ?? "", section, note, dayOf(new Date())) }),
      );
      return text({ ...clock(), updated: line(r.task) });
    },
  );

  server.registerTool(
    "tasks_edit",
    {
      description:
        "Change part of a task's notes: replace one exact passage with another (it must occur exactly once). Safer than rewriting the notes with tasks_update.",
      inputSchema: {
        id: key,
        project: z.string().optional().describe("where to look for a ref"),
        find: z.string().min(1),
        replace: z.string(),
      },
    },
    async (
      { id, project, find: passage, replace }: { id: string; project?: string; find: string; replace: string },
    ) => {
      const t = await find(id, project);
      const r = await updateTask(t.id, (cur) => ({ notes: editNotes(cur.notes ?? "", passage, replace) || null }));
      return text({ ...clock(), updated: line(r.task) });
    },
  );

  server.registerTool(
    "tasks_steps",
    {
      description:
        "The steps of a task (its checklist, which gives the progress the owner sees on the board): add steps, and tick or untick them by index (from tasks_get). " +
        "Use it to break a task down, and to tick what is done as you work — in any chat.",
      inputSchema: {
        id: key,
        project: z.string().optional().describe("where to look for a ref"),
        add: z.array(z.string()).optional().describe("steps to append, in order"),
        check: z.array(z.number().int().min(0)).optional().describe("indexes to tick"),
        uncheck: z.array(z.number().int().min(0)).optional().describe("indexes to untick"),
      },
    },
    async (
      { id, project, add, check, uncheck }: {
        id: string;
        project?: string;
        add?: string[];
        check?: number[];
        uncheck?: number[];
      },
    ) => {
      const t = await find(id, project);
      const r = await updateTask(t.id, (cur) => {
        let notes = cur.notes ?? "";
        for (const i of check ?? []) notes = setStep(notes, i, true);
        for (const i of uncheck ?? []) notes = setStep(notes, i, false);
        for (const s of add ?? []) notes = addStep(notes, s);
        return { notes };
      });
      return text({
        ...clock(),
        updated: line(r.task),
        steps: steps(r.task.notes).map((s, i) => ({ index: i, ...s })),
      });
    },
  );

  server.registerTool("tasks_attach", {
    description:
      "Attach something to a task: a link (https://…), a file or folder on this computer (absolute path or ~/…), or a brain page ([[progetti/x/y]]). " +
      "Links only: to copy a file into the task, the owner drops it on the task in the console.",
    inputSchema: {
      id: key,
      project: z.string().optional().describe("where to look for a ref"),
      target: z.string(),
      label: z.string().optional(),
    },
  }, async ({ id, project, target, label }: { id: string; project?: string; target: string; label?: string }) => {
    const t = await find(id, project);
    const r = await updateTask(t.id, (cur) => ({ notes: addAttachment(cur.notes ?? "", target, label) }));
    return text({ ...clock(), updated: line(r.task), attachments: attachments(r.task.notes) });
  });

  server.registerTool("tasks_done", {
    description:
      "Mark a task done — when the owner says it is done, or when you finished it yourself. A repeating task gets its next occurrence. " +
      "The answer says which tasks it unblocked, and when it was the last open part of a larger task.",
    inputSchema: { id: key, project: z.string().optional().describe("where to look for a ref") },
  }, async ({ id, project }: { id: string; project?: string }) => {
    const t = await find(id, project);
    const r = await updateTask(t.id, { status: "done" });
    const all = (await listTasks()).map((x) => x.id === r.task.id ? r.task : x);
    const unblocked = all.filter((x) => open(x) && x.blocked_by?.includes(r.task.id) && !isBlocked(all, x));
    const parent = r.task.parent ? all.find((x) => x.id === r.task.parent) : undefined;
    const lastPart = parent && open(parent) && relations(all, parent).parts.every((x) => !open(x));
    return text({
      ...clock(),
      done: line(r.task),
      ...(r.next ? { next_occurrence: line(r.next) } : {}),
      ...(unblocked.length ? { unblocked: unblocked.map((x) => line(x, all)) } : {}),
      ...(lastPart ? { all_parts_done: line(parent!, all) } : {}),
    });
  });
}

#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
// tasks — MCP server on Samuel's tasks (shared/mcp/lib/tasks.ts): the same list from every
// profile, every surface, every machine. Registered everywhere, so any chat can read the day and
// keep it current: a thing to do said in passing becomes a task, a thing done is marked done.
//
// No deletion: a task that no longer matters is `dropped` (it survives Syncthing, and stays visible
// in the history). Every answer carries today's date and the time, so "tomorrow at ten" resolves to
// a real day.
import { McpServer } from "npm:@modelcontextprotocol/sdk@^1.18/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@^1.18/server/stdio.js";
import { z } from "npm:zod@^3.23";
import {
  addTask, brief, dayOf, hhmm, listTasks, REPEATS, STATUSES, type Task, type TaskInput, updateTask,
} from "../lib/tasks.ts";

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });
const clock = () => {
  const now = new Date();
  return { today: dayOf(now), now: hhmm(now), weekday: now.toLocaleDateString("en-GB", { weekday: "long" }) };
};
/** A task as a line: easy to read back to Samuel, the id kept for the next call. */
const line = (t: Task) =>
  [t.due && t.due !== dayOf(new Date()) ? t.due : null, t.time, t.title, t.project ? `[${t.project}]` : null, t.owner && t.owner !== "samuel" ? `(${t.owner})` : null, t.priority === 1 ? "!" : null, `#${t.id}`]
    .filter(Boolean).join(" · ");

const fields = {
  due: z.string().nullable().optional().describe("day, YYYY-MM-DD (resolve relative days from `today` in any answer); null clears"),
  time: z.string().nullable().optional().describe("hour of that day, HH:MM, 24h; null clears"),
  remind: z.number().int().nullable().optional().describe("minutes of warning before `time` (default 15)"),
  owner: z.string().nullable().optional().describe("who has to move: samuel (default), claude, or someone's name — then it is waiting on them"),
  project: z.string().nullable().optional().describe("short project name, e.g. acme, claude-multi"),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullable().optional().describe("1 high, 2 normal, 3 low"),
  repeat: z.enum(REPEATS as [string, ...string[]]).nullable().optional().describe("completing it creates the next one"),
  notes: z.string().nullable().optional(),
};

const server = new McpServer({ name: "tasks", version: "0.1.0" });

server.registerTool("tasks_brief", {
  description:
    "Samuel's debrief: what is overdue, what was missed earlier today, the rest of today by time, tomorrow, the next days, what waits on others. " +
    "Call it when he asks for a debrief, what he has today or tomorrow, or when the day's plan is the topic. For the full picture add his calendar " +
    "(the google server's calendar tools). Read it back briefly: times first, then the rest; mention overdue items plainly.",
  inputSchema: {},
}, async () => {
  const b = brief(await listTasks(), new Date());
  return text({
    ...clock(),
    moment: b.moment,
    overdue: b.overdue.map(line),
    missed: b.missed.map(line),
    later_today: b.today.map(line),
    tomorrow: b.tomorrow.map(line),
    next_days: b.upcoming.map(line),
    no_date: b.undated.slice(0, 10).map(line),
    waiting_on_others: b.waiting.map(line),
    done_today: b.doneToday,
  });
});

server.registerTool("tasks_list", {
  description: "Search the tasks: by status, project, owner, a day range, or words in the title and notes. Open tasks only unless a status is given.",
  inputSchema: {
    status: z.enum(STATUSES as [string, ...string[]]).optional(),
    project: z.string().optional(),
    owner: z.string().optional(),
    from: z.string().optional().describe("due on or after, YYYY-MM-DD"),
    to: z.string().optional().describe("due on or before, YYYY-MM-DD"),
    text: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
}, async (q: { status?: string; project?: string; owner?: string; from?: string; to?: string; text?: string; limit?: number }) => {
  const words = q.text?.toLowerCase();
  const hits = (await listTasks()).filter((t) =>
    (q.status ? t.status === q.status : t.status === "todo" || t.status === "doing" || t.status === "waiting") &&
    (!q.project || t.project === q.project) &&
    (!q.owner || (t.owner ?? "samuel") === q.owner.toLowerCase()) &&
    (!q.from || (t.due ?? "") >= q.from) && (!q.to || (!!t.due && t.due <= q.to)) &&
    (!words || `${t.title} ${t.notes ?? ""}`.toLowerCase().includes(words))
  ).sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.time ?? "99").localeCompare(b.time ?? "99"));
  return text({ ...clock(), count: hits.length, tasks: hits.slice(0, q.limit ?? 50).map((t) => ({ ...t, notes: t.notes?.slice(0, 300) })) });
});

server.registerTool("tasks_add", {
  description:
    "Add a task. Use it whenever Samuel says there is something to do (\"devo…\", \"ricordami…\", \"entro venerdì…\"), in any conversation, " +
    "and say in one line what you added. Put a time only when he gave one.",
  inputSchema: { title: z.string(), ...fields },
}, async (input: TaskInput) => {
  const t = await addTask(input);
  return text({ ...clock(), added: line(t), task: t });
});

server.registerTool("tasks_update", {
  description: "Change a task: its day, time, owner, priority, notes, or status (todo, doing, waiting, done, dropped). Dropped instead of deleting.",
  inputSchema: { id: z.string(), title: z.string().optional(), status: z.enum(STATUSES as [string, ...string[]]).optional(), ...fields },
}, async ({ id, ...input }: TaskInput & { id: string }) => {
  const r = await updateTask(id.replace(/^#/, ""), input);
  return text({ ...clock(), updated: line(r.task), ...(r.next ? { next_occurrence: line(r.next) } : {}) });
});

server.registerTool("tasks_done", {
  description: "Mark a task done — when Samuel says it is done, or when you finished it yourself. A repeating task gets its next occurrence.",
  inputSchema: { id: z.string() },
}, async ({ id }: { id: string }) => {
  const r = await updateTask(id.replace(/^#/, ""), { status: "done" });
  return text({ ...clock(), done: line(r.task), ...(r.next ? { next_occurrence: line(r.next) } : {}) });
});

await server.connect(new StdioServerTransport());

// tasks.ts — Samuel's tasks: what there is to do, by when, at what time, and who has to move.
//
// One Markdown file per task in ~/brains/tasks/items (CLAUDE_MULTI_TASKS overrides the root): a
// Syncthing folder, so every machine and every Claude session sees the same list, and an Obsidian
// vault, so the files read well by hand too. One file per task means two machines only collide on
// the same task at the same moment; a task is never deleted, it is `dropped` — a write, which
// travels through Syncthing where a removal can get lost (see references/syncthing-operative-rules).
//
// The owner is who has to move: `samuel` (the default), `claude` (work a session can pick up), or
// anyone else — then the task is usually `waiting` on them. Dates and times are local (Europe/Rome
// on these machines): `due` is a day, `time` an hour of that day, `remind` minutes before it.
//
// Everything below the store is pure and takes `now`, so the brief and the reminders are tested
// without a clock.

export type Status = "todo" | "doing" | "waiting" | "done" | "dropped";
export const STATUSES: Status[] = ["todo", "doing", "waiting", "done", "dropped"];
export type Repeat = "daily" | "weekdays" | "weekly" | "monthly";
export const REPEATS: Repeat[] = ["daily", "weekdays", "weekly", "monthly"];

export interface Task {
  id: string;
  title: string;
  status: Status;
  due?: string; // YYYY-MM-DD
  time?: string; // HH:MM
  remind?: number; // minutes before `time`
  owner?: string; // samuel · claude · someone else
  project?: string;
  priority?: 1 | 2 | 3; // 1 high
  repeat?: Repeat;
  created: string;
  updated: string;
  done?: string;
  notes?: string;
  /** where an agenda entry comes from when it is not a task ("calendar"): never written to a file */
  source?: string;
}

export interface TaskSettings {
  /** local times of the day at which the desktop brief is sent */
  briefs: string[];
  /** default minutes of warning before a timed task */
  remind: number;
}
export const DEFAULT_SETTINGS: TaskSettings = { briefs: ["08:30", "13:30", "19:00"], remind: 15 };

const HOME = Deno.env.get("HOME") ?? "";
export const tasksRoot = () => Deno.env.get("CLAUDE_MULTI_TASKS") ?? `${HOME}/brains/tasks`;
const itemsDir = () => `${tasksRoot()}/items`;

// ---------------------------------------------------------------- dates (local)
export const pad = (n: number) => String(n).padStart(2, "0");
export const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** A day plus n days, as a day. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return dayOf(new Date(y, m - 1, d + n));
}
const at = (day: string, time: string) => {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(y, m - 1, d, h, mi);
};
export const validDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(at(s, "00:00").getTime()) && dayOf(at(s, "00:00")) === s;
export const validTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** Pure: the next due day of a repeating task, after `from`. */
export function nextDue(from: string, repeat: Repeat): string {
  if (repeat === "daily") return addDays(from, 1);
  if (repeat === "weekly") return addDays(from, 7);
  if (repeat === "monthly") {
    const [y, m, d] = from.split("-").map(Number);
    // the same day next month, or its last day when it has fewer (31 Jan → 28/29 Feb)
    const last = new Date(y, m + 1, 0).getDate();
    return dayOf(new Date(y, m, Math.min(d, last)));
  }
  let next = addDays(from, 1);
  while ([0, 6].includes(at(next, "12:00").getDay())) next = addDays(next, 1);
  return next;
}

// ---------------------------------------------------------------- files
const ORDER: (keyof Task)[] = ["id", "title", "status", "due", "time", "remind", "owner", "project", "priority", "repeat", "created", "updated", "done"];

/** Pure: a task as its file. Values are JSON-quoted where YAML could misread them. */
export function toFile(t: Task): string {
  const lines = ["---"];
  for (const k of ORDER) {
    const v = t[k];
    if (v === undefined || v === "") continue;
    lines.push(`${k}: ${typeof v === "number" ? v : JSON.stringify(v)}`);
  }
  lines.push("---", "", `# ${t.title}`, "");
  if (t.notes?.trim()) lines.push(t.notes.trim(), "");
  return lines.join("\n");
}

/** Pure: a file back to a task; null when it is not one. Notes are the body after the title. */
export function fromFile(text: string): Task | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const t: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let v: unknown = kv[2].trim();
    try { v = JSON.parse(v as string); } catch { /* a bare word */ }
    t[kv[1]] = v;
  }
  if (typeof t.id !== "string" || typeof t.title !== "string") return null;
  const body = m[2].replace(/^\s*#\s.*\r?\n?/, "").trim();
  return {
    ...(t as unknown as Task),
    status: STATUSES.includes(t.status as Status) ? t.status as Status : "todo",
    ...(body ? { notes: body } : {}),
  };
}

export function newId(now = new Date()): string {
  const r = crypto.getRandomValues(new Uint8Array(3));
  return `t-${dayOf(now).replaceAll("-", "")}-${[...r].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------- store
export async function listTasks(): Promise<Task[]> {
  const out: Task[] = [];
  try {
    for await (const e of Deno.readDir(itemsDir())) {
      if (!e.isFile || !/^t-[\w-]+\.md$/.test(e.name)) continue; // conflict copies are not tasks
      const t = fromFile(await Deno.readTextFile(`${itemsDir()}/${e.name}`).catch(() => ""));
      if (t) out.push(t);
    }
  } catch { /* no tasks yet */ }
  return out;
}

export async function getTask(id: string): Promise<Task | null> {
  if (!/^t-[\w-]+$/.test(id)) return null;
  return fromFile(await Deno.readTextFile(`${itemsDir()}/${id}.md`).catch(() => ""));
}

async function write(t: Task) {
  await Deno.mkdir(itemsDir(), { recursive: true });
  const p = `${itemsDir()}/${t.id}.md`, tmp = `${p}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(tmp, toFile(t));
  await Deno.rename(tmp, p);
}

export async function loadSettings(): Promise<TaskSettings> {
  try {
    const s = JSON.parse(await Deno.readTextFile(`${tasksRoot()}/settings.json`));
    return { ...DEFAULT_SETTINGS, ...s };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export interface TaskInput {
  title?: string; status?: Status; due?: string | null; time?: string | null; remind?: number | null;
  owner?: string | null; project?: string | null; priority?: 1 | 2 | 3 | null; repeat?: Repeat | null; notes?: string | null;
}

/** Pure: an input checked and applied onto a task (null clears a field). Throws with what is wrong. */
export function applyInput(base: Task, input: TaskInput, now: Date): Task {
  const t: Task = { ...base };
  if (input.title !== undefined) {
    if (!input.title.trim()) throw new Error("a task needs a title");
    t.title = input.title.trim().replace(/\s+/g, " ").slice(0, 200);
  }
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw new Error(`status is one of ${STATUSES.join(", ")}`);
    t.status = input.status;
    if (input.status === "done") t.done = now.toISOString(); else delete t.done;
  }
  const set = <K extends keyof Task>(k: K, v: Task[K] | null | undefined, ok = true, what = "") => {
    if (v === undefined) return;
    if (v === null || v === "") { delete t[k]; return; }
    if (!ok) throw new Error(what);
    t[k] = v;
  };
  set("due", input.due, !input.due || validDay(input.due), "due is a day, YYYY-MM-DD");
  set("time", input.time, !input.time || validTime(input.time), "time is HH:MM");
  set("remind", input.remind, input.remind == null || (Number.isInteger(input.remind) && input.remind >= 0 && input.remind <= 1440), "remind is minutes, 0 to 1440");
  set("owner", input.owner?.trim().toLowerCase());
  set("project", input.project?.trim());
  set("priority", input.priority, input.priority == null || [1, 2, 3].includes(input.priority), "priority is 1 (high), 2 or 3");
  set("repeat", input.repeat, input.repeat == null || REPEATS.includes(input.repeat), `repeat is one of ${REPEATS.join(", ")}`);
  set("notes", input.notes ?? undefined);
  if (t.time && !t.due) throw new Error("a time needs a day: set due too");
  if (t.repeat && !t.due) throw new Error("a repeating task needs a first day: set due");
  t.updated = now.toISOString();
  return t;
}

export async function addTask(input: TaskInput, now = new Date()): Promise<Task> {
  const base: Task = { id: newId(now), title: "", status: "todo", created: now.toISOString(), updated: now.toISOString() };
  const t = applyInput(base, { owner: "samuel", ...input }, now);
  if (!t.title) throw new Error("a task needs a title");
  await write(t);
  return t;
}

/** Changes a task. Completing a repeating one also creates its next occurrence, returned as `next`. */
export async function updateTask(id: string, input: TaskInput, now = new Date()): Promise<{ task: Task; next?: Task }> {
  const cur = await getTask(id);
  if (!cur) throw new Error(`no task ${id}`);
  const t = applyInput(cur, input, now);
  await write(t);
  let next: Task | undefined;
  if (input.status === "done" && cur.status !== "done" && t.repeat && t.due) {
    next = { ...t, id: newId(now), status: "todo", due: nextDue(t.due, t.repeat), created: now.toISOString(), updated: now.toISOString() };
    delete next.done;
    await write(next);
  }
  return { task: t, next };
}

// ---------------------------------------------------------------- the brief
const open = (t: Task) => t.status === "todo" || t.status === "doing";
const byTimeThenPriority = (a: Task, b: Task) =>
  (a.time ?? "99:99").localeCompare(b.time ?? "99:99") || (a.priority ?? 2) - (b.priority ?? 2) || a.title.localeCompare(b.title);

export type Moment = "morning" | "afternoon" | "evening";
export const momentOf = (now: Date): Moment => now.getHours() < 13 ? "morning" : now.getHours() < 18 ? "afternoon" : "evening";

/** Pure: what the day holds, seen from `now`. `later` is the rest of today still ahead; in the
 *  evening `tomorrow` is what comes next. Tasks owned by someone else are listed as waiting. */
export function brief(tasks: Task[], now: Date, horizon = 3) {
  const today = dayOf(now), clock = hhmm(now);
  const mine = tasks.filter((t) => open(t) && (!t.owner || t.owner === "samuel" || t.owner === "claude"));
  const todayAll = mine.filter((t) => t.due === today).sort(byTimeThenPriority);
  return {
    day: today,
    moment: momentOf(now),
    overdue: mine.filter((t) => t.due && t.due < today).sort((a, b) => a.due!.localeCompare(b.due!) || byTimeThenPriority(a, b)),
    // timed tasks already past this hour, still open: missed today (a past appointment is just past)
    missed: todayAll.filter((t) => t.time && t.time < clock && !t.source),
    today: todayAll.filter((t) => !t.time || t.time >= clock),
    tomorrow: mine.filter((t) => t.due === addDays(today, 1)).sort(byTimeThenPriority),
    upcoming: mine.filter((t) => t.due && t.due > addDays(today, 1) && t.due <= addDays(today, horizon)).sort((a, b) => a.due!.localeCompare(b.due!) || byTimeThenPriority(a, b)),
    undated: mine.filter((t) => !t.due).sort(byTimeThenPriority),
    waiting: tasks.filter((t) => t.status === "waiting" || (open(t) && t.owner && t.owner !== "samuel" && t.owner !== "claude")),
    doneToday: tasks.filter((t) => t.status === "done" && t.done && dayOf(new Date(t.done)) === today).length,
  };
}

// ---------------------------------------------------------------- reminders
/** Pure: the timed tasks whose warning is due now and was not sent yet. A warning is not sent
 *  more than an hour late: a machine woken in the evening does not replay the morning. */
export function dueReminders(tasks: Task[], now: Date, sent: Set<string>, defaultRemind: number): { task: Task; key: string }[] {
  const out = [];
  for (const t of tasks) {
    if (!open(t) || !t.due || !t.time) continue;
    const start = at(t.due, t.time);
    const warn = new Date(start.getTime() - (t.remind ?? defaultRemind) * 60000);
    const key = `${t.id}@${t.due}T${t.time}`;
    if (now >= warn && now.getTime() - start.getTime() < 3600000 && !sent.has(key)) out.push({ task: t, key });
  }
  return out;
}

/** Pure: the brief times of today already reached (within the hour) and not sent yet. */
export function dueBriefs(settings: TaskSettings, now: Date, sent: Set<string>): string[] {
  const today = dayOf(now);
  return settings.briefs.filter(validTime).filter((b) => {
    const t = at(today, b).getTime();
    return now.getTime() >= t && now.getTime() - t < 3600000 && !sent.has(`brief@${today}T${b}`);
  });
}

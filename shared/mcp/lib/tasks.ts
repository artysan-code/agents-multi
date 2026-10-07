// tasks.ts — the owner's tasks: what there is to do, by when, at what time, and who has to move.
//
// One Markdown file per task. Where the files are is the store's business: in the owner's brain when
// there is a brain account (brain-tasks.ts, the only list from 2026-10-02 on), otherwise in
// ~/brains/tasks/items (CLAUDE_MULTI_TASKS overrides the root), a Syncthing folder. That root also
// keeps settings.json and the files attached from the console. A task is never deleted, it is
// `dropped`: a write, which keeps it in the history (and on Syncthing, where a removal can get lost).
//
// The owner is who has to move: the setup's owner (owner.ts, the default), `claude` (work a session
// can pick up), or anyone else — then the task is usually `waiting` on them. Dates and times are local
// (the machine's time zone): `due` is a day, `time` an hour of that day, `remind` minutes before it.
//
// A task of a project can carry how that project names and tracks it: its `ref` there (TASK-495),
// a free `stage` (spec, release pending…; the column stays `status`), the task it is part of
// (`parent`), the tasks it waits for (`blocked_by`), `labels`, and `detail`: where the full story
// lives when it is not in the notes (a file of the repository, a page). The brain holds the card of
// every task; the detail lives wherever the project keeps it.
//
// Everything below the store is pure and takes `now`, so the brief and the reminders are tested
// without a clock.

import { owner } from "./owner.ts";

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
  owner?: string; // the setup's owner (owner.ts) · claude · someone else
  project?: string;
  priority?: 1 | 2 | 3; // 1 high
  repeat?: Repeat;
  ref?: string; // the project's own name for it: TASK-495
  stage?: string; // spec, discovery, release pending…: free, lower case
  parent?: string; // the id of the task this is part of
  blocked_by?: string[]; // ids of the tasks that have to be done first
  labels?: string[];
  detail?: string; // where the full detail lives: a path, a path#anchor, a URL, [[page]]
  created: string;
  updated: string;
  done?: string;
  notes?: string;
  /** where an agenda entry comes from when it is not a task ("calendar"): never written to a file */
  source?: string;
  /** a calendar entry: the calendar it is in and that calendar's colour (a CSS colour) */
  calendar?: string;
  color?: string;
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

// ---------------------------------------------------------------- dates
// A day and an hour are the owner's: on a machine, its clock's own zone; in a process that serves
// several people (the brain), the zone of the person the request is for, given by useZone(). Only
// turning an instant into a day or an hour, and back, needs the zone; counting days on the calendar
// (addDays, nextDue) is done at UTC, where every day has 24 hours.
export const pad = (n: number) => String(n).padStart(2, "0");

let zoneOf: (() => string | undefined) | null = null;
/** A process that serves several people says, per request, whose zone the days are in. */
export function useZone(fn: () => string | undefined) {
  zoneOf = fn;
}
/** The zone days and hours are in now (an IANA name), or undefined for this machine's own. */
export const zone = (): string | undefined => zoneOf?.() || undefined;

/** Pure: whether a name is a time zone this runtime knows. */
export function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();
/** The wall clock of an instant: in `tz`, or this machine's own zone. */
function wall(d: Date, tz = zone()): { y: number; m: number; d: number; h: number; mi: number } {
  if (!tz) return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formats.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute };
}
/** The day of an instant, in the owner's zone. */
export const dayOf = (d: Date) => {
  const w = wall(d);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
};
/** The hour and minute of an instant, in the owner's zone. */
export const hhmm = (d: Date) => {
  const w = wall(d);
  return `${pad(w.h)}:${pad(w.mi)}`;
};
/** The hour of an instant, in the owner's zone. */
export const hourOf = (d: Date) => wall(d).h;

const cal = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return { y, m, d };
};
const calDay = (t: number) => {
  const x = new Date(t);
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
};
/** A day plus n days, as a day. */
export function addDays(day: string, n: number): string {
  const { y, m, d } = cal(day);
  return calDay(Date.UTC(y, m - 1, d + n));
}
/** The instant a day's hour starts, in the owner's zone. */
const at = (day: string, time: string) => {
  const { y, m, d } = cal(day);
  const [h, mi] = time.split(":").map(Number);
  const tz = zone();
  if (!tz) return new Date(y, m - 1, d, h, mi);
  // the wall time read as if it were UTC, then moved by the zone's offset at that instant (twice:
  // the offset can change between the guess and the answer, around a change of summer time)
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const offset = (t: number) => {
    const w = wall(new Date(t), tz);
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi) - Math.floor(t / 60000) * 60000;
  };
  const first = guess - offset(guess);
  return new Date(guess - offset(first));
};
export const validDay = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const { y, m, d } = cal(s);
  return calDay(Date.UTC(y, m - 1, d)) === s;
};
export const validTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** Pure: the next due day of a repeating task, after `from`. */
export function nextDue(from: string, repeat: Repeat): string {
  if (repeat === "daily") return addDays(from, 1);
  if (repeat === "weekly") return addDays(from, 7);
  if (repeat === "monthly") {
    const { y, m, d } = cal(from);
    // the same day next month, or its last day when it has fewer (31 Jan → 28/29 Feb)
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return calDay(Date.UTC(y, m, Math.min(d, last)));
  }
  let next = addDays(from, 1);
  const weekday = (day: string) => new Date(Date.UTC(cal(day).y, cal(day).m - 1, cal(day).d)).getUTCDay();
  while ([0, 6].includes(weekday(next))) next = addDays(next, 1);
  return next;
}

// ---------------------------------------------------------------- files
const ORDER: (keyof Task)[] = [
  "id",
  "title",
  "status",
  "due",
  "time",
  "remind",
  "owner",
  "project",
  "priority",
  "repeat",
  "ref",
  "stage",
  "parent",
  "blocked_by",
  "labels",
  "detail",
  "created",
  "updated",
  "done",
];

/** Pure: a task as its file. Values are JSON-quoted where YAML could misread them. */
export function toFile(t: Task): string {
  const lines = ["---"];
  // the known fields in their order, then whatever else the file had (Obsidian's tags, say)
  const extra = Object.keys(t).filter((k) =>
    !ORDER.includes(k as keyof Task) && k !== "notes" && k !== "source" && /^\w+$/.test(k)
  );
  for (const k of [...ORDER, ...extra]) {
    const v = (t as unknown as Record<string, unknown>)[k];
    if (v === undefined || v === "" || v === null || (Array.isArray(v) && !v.length)) continue;
    lines.push(`${k}: ${typeof v === "number" ? v : JSON.stringify(v)}`);
  }
  lines.push("---", "", `# ${t.title}`, "");
  if (t.notes?.trim()) lines.push(t.notes.trim(), "");
  return lines.join("\n");
}

/** Pure: a file back to a task; null when it is not one. Notes are the body after the title. */
export function fromFile(text: string): Task | null {
  // one line ending from here on: a file saved on Windows would otherwise hide its steps
  const m = text.replace(/\r\n?/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const t: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let v: unknown = kv[2].trim();
    try {
      v = JSON.parse(v as string);
    } catch { /* a bare word */ }
    t[kv[1]] = v;
  }
  if (typeof t.id !== "string" || typeof t.title !== "string") return null;
  const body = m[2].replace(/^\s*#\s.*\n?/, "").trim();
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
/** Where tasks are kept: one file each under the tasks root, unless a process says otherwise (the
 *  brain service keeps them in its own database, with the same rules on top). */
export interface TaskStore {
  list(): Promise<Task[]>;
  get(id: string): Promise<Task | null>;
  /** `base` is the `updated` of the version the change was made from: a store several machines
   *  write to refuses with StaleError when the task has changed since. */
  write(t: Task, base?: string): Promise<void>;
}

const fileStore: TaskStore = {
  async list() {
    const out: Task[] = [];
    try {
      for await (const e of Deno.readDir(itemsDir())) {
        if (!e.isFile || !/^t-[\w-]+\.md$/.test(e.name)) continue; // conflict copies are not tasks
        const t = fromFile(await Deno.readTextFile(`${itemsDir()}/${e.name}`).catch(() => ""));
        if (t) out.push(t);
      }
    } catch { /* no tasks yet */ }
    return out;
  },
  async get(id) {
    return fromFile(await Deno.readTextFile(`${itemsDir()}/${id}.md`).catch(() => ""));
  },
  async write(t) {
    await Deno.mkdir(itemsDir(), { recursive: true });
    const p = `${itemsDir()}/${t.id}.md`, tmp = `${p}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(tmp, toFile(t));
    await Deno.rename(tmp, p);
  },
};
let store: TaskStore = fileStore;
/** Where the tasks are kept from now on; returns where they were. */
export function useTaskStore(s: TaskStore): TaskStore {
  const before = store;
  store = s;
  return before;
}

export function listTasks(): Promise<Task[]> {
  return store.list();
}

export async function getTask(id: string): Promise<Task | null> {
  if (!/^t-[\w-]+$/.test(id)) return null;
  return await store.get(id);
}

const write = (t: Task, base?: string) => store.write(t, base);

export async function loadSettings(): Promise<TaskSettings> {
  try {
    const s = JSON.parse(await Deno.readTextFile(`${tasksRoot()}/settings.json`));
    return { ...DEFAULT_SETTINGS, ...s };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export interface TaskInput {
  title?: string;
  status?: Status;
  due?: string | null;
  time?: string | null;
  remind?: number | null;
  owner?: string | null;
  project?: string | null;
  priority?: 1 | 2 | 3 | null;
  repeat?: Repeat | null;
  notes?: string | null;
  ref?: string | null;
  stage?: string | null;
  parent?: string | null;
  blocked_by?: string[] | null;
  labels?: string[] | null;
  detail?: string | null;
}

const ID = /^t-[\w-]+$/;
const oneLine = (s: string, max: number) => !/\n/.test(s) && s.length <= max;
/** Pure: a list of words kept once each, in order, empty ones out. */
const words = (
  xs: string[],
  lower = false,
) => [...new Set(xs.map((x) => (lower ? x.toLowerCase() : x).trim().replace(/\s+/g, " ")).filter(Boolean))];

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
    if (input.status === "done") t.done = now.toISOString();
    else delete t.done;
  }
  const set = <K extends keyof Task>(k: K, v: Task[K] | null | undefined, ok = true, what = "") => {
    if (v === undefined) return;
    if (v === null || v === "") {
      delete t[k];
      return;
    }
    if (!ok) throw new Error(what);
    t[k] = v;
  };
  set("due", input.due, !input.due || validDay(input.due), "due is a day, YYYY-MM-DD");
  set("time", input.time, !input.time || validTime(input.time), "time is HH:MM");
  set(
    "remind",
    input.remind,
    input.remind == null || (Number.isInteger(input.remind) && input.remind >= 0 && input.remind <= 1440),
    "remind is minutes, 0 to 1440",
  );
  set("owner", input.owner === null ? null : input.owner?.trim().toLowerCase());
  set("project", input.project === null ? null : input.project?.trim());
  set(
    "priority",
    input.priority,
    input.priority == null || [1, 2, 3].includes(input.priority),
    "priority is 1 (high), 2 or 3",
  );
  set(
    "repeat",
    input.repeat,
    input.repeat == null || REPEATS.includes(input.repeat),
    `repeat is one of ${REPEATS.join(", ")}`,
  );
  set("notes", input.notes);
  set(
    "ref",
    input.ref === null ? null : input.ref?.trim(),
    !input.ref || oneLine(input.ref.trim(), 40),
    "ref is the project's name for the task, one line, at most 40 characters",
  );
  set(
    "stage",
    input.stage === null ? null : input.stage?.trim().toLowerCase().replace(/\s+/g, " "),
    !input.stage || oneLine(input.stage.trim(), 40),
    "stage is a word or two, at most 40 characters",
  );
  set(
    "parent",
    input.parent === null ? null : input.parent?.trim().replace(/^#/, ""),
    !input.parent || ID.test(input.parent.trim().replace(/^#/, "")),
    "parent is a task id, t-…",
  );
  if (input.blocked_by !== undefined) {
    const ids = input.blocked_by === null ? [] : words(input.blocked_by.map((x) => x.replace(/^#/, "")));
    if (!ids.every((x) => ID.test(x))) throw new Error("blocked_by lists task ids, t-…");
    set("blocked_by", ids.length ? ids : null);
  }
  if (input.labels !== undefined) {
    const ls = input.labels === null ? [] : words(input.labels, true);
    if (ls.length > 12 || !ls.every((l) => oneLine(l, 30))) {
      throw new Error("labels: at most 12, each at most 30 characters");
    }
    set("labels", ls.length ? ls : null);
  }
  set(
    "detail",
    input.detail === null ? null : input.detail?.trim(),
    !input.detail || oneLine(input.detail.trim(), 500),
    "detail is one link or path, at most 500 characters",
  );
  if (t.parent === t.id) throw new Error("a task cannot be part of itself");
  if (t.blocked_by?.includes(t.id)) throw new Error("a task cannot wait for itself");
  if (t.time && !t.due) throw new Error("a time needs a day: set due too");
  if (t.repeat && !t.due) throw new Error("a repeating task needs a first day: set due");
  t.updated = now.toISOString();
  return t;
}

/** Changes run one at a time in a process: a server answers several tool calls at once, and two
 *  read-modify-writes of the same task would otherwise lose one of them. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job);
  chain = run.catch(() => {});
  return run;
}

export function addTask(input: TaskInput, now = new Date()): Promise<Task> {
  return serial(() => addTaskNow(input, now));
}
async function addTaskNow(input: TaskInput, now: Date): Promise<Task> {
  const base: Task = {
    id: newId(now),
    title: "",
    status: "todo",
    created: now.toISOString(),
    updated: now.toISOString(),
  };
  const t = applyInput(base, { owner: owner().id, ...input }, now);
  if (!t.title) throw new Error("a task needs a title");
  await write(t);
  return t;
}

/** Changes a task. Completing a repeating one also creates its next occurrence, returned as `next`. */
export function updateTask(
  id: string,
  input: TaskInput | ((cur: Task) => TaskInput),
  now = new Date(),
  base?: string,
): Promise<{ task: Task; next?: Task }> {
  return serial(async () => {
    // a change made elsewhere between reading and writing (another machine, a chat on the brain)
    // is read again and the change applied on top of it; an editor that named its `base` is told
    for (let attempt = 1;; attempt++) {
      try {
        return await updateTaskNow(id, input, now, base);
      } catch (e) {
        if (!(e instanceof StaleError) || base || attempt === 3) throw e;
      }
    }
  });
}
/** `input` may be a function of the task as it is now: the way to edit its notes without racing. */
async function updateTaskNow(
  id: string,
  change: TaskInput | ((cur: Task) => TaskInput),
  now: Date,
  base?: string,
): Promise<{ task: Task; next?: Task }> {
  const cur = await getTask(id);
  if (!cur) throw new Error(`no task ${id}`);
  // an editor that read the task at `base` does not overwrite a change made since (a chat, another machine)
  if (base && cur.updated !== base) throw new StaleError(cur);
  const input = typeof change === "function" ? change(cur) : change;
  const t = applyInput(cur, input, now);
  await write(t, cur.updated);
  let next: Task | undefined;
  if (input.status === "done" && cur.status !== "done" && t.repeat && t.due) {
    next = {
      ...t,
      id: newId(now),
      status: "todo",
      due: nextDue(t.due, t.repeat),
      created: now.toISOString(),
      updated: now.toISOString(),
    };
    delete next.done;
    await write(next);
  }
  return { task: t, next };
}

export class StaleError extends Error {
  constructor(public current: Task) {
    super("the task changed meanwhile: reload it");
  }
}

// ---------------------------------------------------------------- the body: steps and attachments
// A task's notes are plain Markdown, the way Obsidian writes them: a description, then optionally
// a checklist (`- [ ]` / `- [x]` lines, anywhere) whose ticks give the progress, and a section of
// attachments (`## Attachments`, or `## Allegati`): one link per line — a URL, a local path, a file
// stored with the task (`files/<id>/…`, under the tasks root), or a wiki page (`[[page]]`).

const STEP = /^(\s*)[-*] \[([ xX])\] (.*)$/;
const ATT_HEAD = /^##\s+(attachments|allegati)\s*$/i;
const STEPS_HEAD = /^##\s+(steps|passi)\s*$/i;
const LOG_HEAD = /^##\s+(log|diario)\s*$/i;
const DECISIONS_HEAD = /^##\s+(decisions|decisioni)\s*$/i;

export interface Step {
  text: string;
  done: boolean;
}
/** Pure: the checklist of a task's notes, in order. */
export function steps(notes = ""): Step[] {
  return notes.split("\n").map((l) => l.match(STEP)).filter((m): m is RegExpMatchArray => !!m).map((m) => ({
    text: m[3].trim(),
    done: m[2] !== " ",
  }));
}
/** Pure: how much of the checklist is ticked; null when there is none. */
export function progress(notes = ""): { done: number; total: number; pct: number } | null {
  const s = steps(notes);
  if (!s.length) return null;
  const done = s.filter((x) => x.done).length;
  return { done, total: s.length, pct: Math.round(done / s.length * 100) };
}
/** Pure: the notes with step `index` ticked or unticked (toggled when `done` is not given). */
export function setStep(notes: string, index: number, done?: boolean): string {
  let i = -1;
  return notes.split("\n").map((l) => {
    const m = l.match(STEP);
    if (!m || ++i !== index) return l;
    return `${m[1]}- [${(done ?? m[2] === " ") ? "x" : " "}] ${m[3]}`;
  }).join("\n");
}

/** Pure: `line` appended at the end of the section whose heading matches, the section created
 *  (as `## <title>`) where it belongs: steps before the attachments, attachments last. */
function appendTo(notes: string, head: RegExp, title: string, line: string): string {
  const lines = notes.replace(/\s+$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") lines.length = 0;
  const at = lines.findIndex((l) => head.test(l));
  if (at < 0) {
    // a new section goes before the attachments, when they are there
    const att = head === ATT_HEAD ? -1 : lines.findIndex((l) => ATT_HEAD.test(l));
    const block = [`## ${title}`, "", line];
    if (att >= 0) {
      lines.splice(att, 0, ...block, "");
      return lines.join("\n") + "\n";
    }
    return [...lines, ...(lines.length ? [""] : []), ...block].join("\n") + "\n";
  }
  let end = at + 1;
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++;
  let last = end - 1;
  while (last > at && !lines[last].trim()) last--;
  lines.splice(last + 1, 0, line);
  return lines.join("\n") + "\n";
}
export function addStep(notes: string, text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) throw new Error("a step needs some text");
  return appendTo(notes, STEPS_HEAD, "Steps", `- [ ] ${t}`);
}

export type NoteSection = "log" | "decisions";
/** Pure: a dated line added to the task's log (what happened) or its decisions (what was decided,
 *  by whom): the notes grow without being rewritten. */
export function addNote(notes: string, section: NoteSection, text: string, day: string): string {
  const t = text.trim().replace(/\s*\n\s*/g, " ");
  if (!t) throw new Error("a note needs some text");
  return section === "log"
    ? appendTo(notes, LOG_HEAD, "Log", `- ${day} · ${t}`)
    : appendTo(notes, DECISIONS_HEAD, "Decisions", `- ${day} · ${t}`);
}
/** Pure: the dated lines of a section, oldest first. */
export function notesOf(notes = "", section: NoteSection): { day?: string; text: string }[] {
  const head = section === "log" ? LOG_HEAD : DECISIONS_HEAD;
  const lines = notes.split("\n");
  const at = lines.findIndex((l) => head.test(l));
  if (at < 0) return [];
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (/^#{1,2}\s/.test(l)) break;
    const m = l.match(/^\s*[-*]\s+(?:(\d{4}-\d{2}-\d{2})\s*·\s*)?(.+)$/);
    if (m) out.push({ ...(m[1] ? { day: m[1] } : {}), text: m[2].trim() });
  }
  return out;
}
/** Pure: one exact passage of the notes replaced; it has to occur exactly once. */
export function editNotes(notes: string, find: string, replace: string): string {
  if (!find) throw new Error("say what to replace");
  const n = notes.split(find).length - 1;
  if (n !== 1) {
    throw new Error(
      n
        ? `the passage occurs ${n} times: include more context`
        : "the passage is not in the notes: read them again (tasks_get)",
    );
  }
  return notes.replace(find, () => replace);
}

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

export type AttachmentKind = "url" | "file" | "path" | "page";
export interface Attachment {
  label: string;
  target: string;
  kind: AttachmentKind;
}
const kindOf = (target: string): AttachmentKind =>
  /^https?:\/\//.test(target) ? "url" : target.startsWith("files/") ? "file" : "path";

/** Pure: the attachments section, one entry per list line. */
export function attachments(notes = ""): Attachment[] {
  const lines = notes.split("\n");
  const at = lines.findIndex((l) => ATT_HEAD.test(l));
  if (at < 0) return [];
  const out: Attachment[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^#{1,2}\s/.test(l)) break;
    const item = l.match(/^\s*[-*]\s+(.*)$/)?.[1]?.trim();
    if (!item) continue;
    const page = item.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
    if (page) {
      out.push({ label: page[2] ?? page[1].split("/").pop()!, target: page[1], kind: "page" });
      continue;
    }
    const md = item.match(/^\[([^\]]*)\]\((?:<([^>]+)>|([^)\s]+))\)$/);
    const target = (md ? md[2] ?? md[3] : item.replace(/^`|`$/g, "")).trim();
    out.push({ label: md?.[1] || target.split("/").filter(Boolean).pop() || target, target, kind: kindOf(target) });
  }
  return out;
}
/** Pure: an attachment line added. Paths with spaces go in angle brackets, as CommonMark wants. */
export function addAttachment(notes: string, target: string, label?: string): string {
  const t = target.trim();
  if (!t) throw new Error("an attachment needs a link or a path");
  if (/[\n<>]/.test(t)) throw new Error("an attachment cannot contain a line break, < or >");
  const page = t.match(/^\[\[[^\]\n]+\]\]$/);
  const name = ((label ?? "").trim() || t.split("/").filter(Boolean).pop() || t).replace(/[[\]\n]/g, "");
  // spaces and parentheses need the <…> form of a Markdown link target
  const line = page ? `- ${t}` : `- [${name}](${/[\s()]/.test(t) ? `<${t}>` : t})`;
  return appendTo(notes, ATT_HEAD, "Attachments", line);
}
/** Pure: attachment `index` removed. */
export function removeAttachment(notes: string, index: number): string {
  const lines = notes.split("\n");
  const at = lines.findIndex((l) => ATT_HEAD.test(l));
  if (at < 0) return notes;
  let i = -1;
  for (let k = at + 1; k < lines.length; k++) {
    if (/^#{1,2}\s/.test(lines[k])) break;
    if (/^\s*[-*]\s+\S/.test(lines[k]) && ++i === index) {
      lines.splice(k, 1);
      break;
    }
  }
  return lines.join("\n");
}

/** A file stored with a task: under files/<id>/, the name kept readable and made safe. */
export async function storeFile(id: string, name: string, bytes: Uint8Array): Promise<string> {
  if (!/^t-[\w-]+$/.test(id)) throw new Error("bad task id");
  const safe = name.replace(/[/\\\0<>\n\r]/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";
  const dir = `${tasksRoot()}/files/${id}`;
  await Deno.mkdir(dir, { recursive: true });
  let rel = `files/${id}/${safe}`;
  for (let n = 2; await Deno.stat(`${tasksRoot()}/${rel}`).then(() => true, () => false); n++) {
    rel = `files/${id}/${safe.replace(/(\.[^.]*)?$/, `-${n}$1`)}`;
  }
  await Deno.writeFile(`${tasksRoot()}/${rel}`, bytes);
  return rel;
}

// ---------------------------------------------------------------- the brief
const open = (t: Task) => t.status === "todo" || t.status === "doing";
const byTimeThenPriority = (a: Task, b: Task) =>
  (a.time ?? "99:99").localeCompare(b.time ?? "99:99") || (a.priority ?? 2) - (b.priority ?? 2) ||
  a.title.localeCompare(b.title);

export type Moment = "morning" | "afternoon" | "evening";
export const momentOf = (now: Date): Moment =>
  hourOf(now) < 13 ? "morning" : hourOf(now) < 18 ? "afternoon" : "evening";

/** Pure: what the day holds, seen from `now`. `later` is the rest of today still ahead; in the
 *  evening `tomorrow` is what comes next. Tasks owned by someone else are listed as waiting. */
export function brief(tasks: Task[], now: Date, horizon = 3, me = owner().id) {
  const today = dayOf(now), clock = hhmm(now);
  const mine = tasks.filter((t) => open(t) && (!t.owner || t.owner === me || t.owner === "claude"));
  const todayAll = mine.filter((t) => t.due === today).sort(byTimeThenPriority);
  return {
    day: today,
    moment: momentOf(now),
    overdue: mine.filter((t) => t.due && t.due < today).sort((a, b) =>
      a.due!.localeCompare(b.due!) || byTimeThenPriority(a, b)
    ),
    // timed tasks already past this hour, still open: missed today (a past appointment is just past)
    missed: todayAll.filter((t) => t.time && t.time < clock && !t.source),
    today: todayAll.filter((t) => !t.time || t.time >= clock),
    tomorrow: mine.filter((t) => t.due === addDays(today, 1)).sort(byTimeThenPriority),
    upcoming: mine.filter((t) => t.due && t.due > addDays(today, 1) && t.due <= addDays(today, horizon)).sort((a, b) =>
      a.due!.localeCompare(b.due!) || byTimeThenPriority(a, b)
    ),
    undated: mine.filter((t) => !t.due).sort(byTimeThenPriority),
    waiting: tasks.filter((t) =>
      t.status === "waiting" || (open(t) && t.owner && t.owner !== me && t.owner !== "claude")
    ),
    doneToday: tasks.filter((t) => t.status === "done" && t.done && dayOf(new Date(t.done)) === today).length,
  };
}

// ---------------------------------------------------------------- reminders
/** Pure: the timed tasks whose warning is due now and was not sent yet. A warning is not sent
 *  more than an hour late: a machine woken in the evening does not replay the morning. */
export function dueReminders(
  tasks: Task[],
  now: Date,
  sent: Set<string>,
  defaultRemind: number,
): { task: Task; key: string }[] {
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

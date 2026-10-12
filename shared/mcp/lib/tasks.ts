// tasks.ts — the owner's tasks: what there is to do, by when, at what time, and who has to move.
//
// One Markdown file per task. Where the files are is the store's business: in the owner's brain when
// there is a brain account (brain-tasks.ts, the only list from 2026-10-02 on), otherwise in
// ~/brains/tasks/items (AGENTS_MULTI_TASKS overrides the root), a Syncthing folder. That root also
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
import { amEnv } from "./env.ts";
import { serializer, writeAtomic } from "./fs.ts";
import { REPEATS, STATUSES, type Task, type TaskInput, type TaskSettings } from "./tasks/types.ts";
import { dayOf, nextDue, validDay, validTime } from "./tasks/dates.ts";
import { ID } from "./tasks/refs.ts";
import { fromFile, toFile } from "./tasks/format.ts";

// The pieces live in tasks/; this module is the store, and the one place everything is imported from.
export { REPEATS, STATUSES } from "./tasks/types.ts";
export type { Status, Task, TaskInput } from "./tasks/types.ts";
export { addDays, dayOf, hhmm, nextDue, pad, useZone, validDay, validZone, zone } from "./tasks/dates.ts";
export { fromFile, toFile } from "./tasks/format.ts";
export {
  addAttachment,
  addNote,
  addStep,
  type Attachment,
  attachments,
  editNotes,
  type NoteSection,
  notesOf,
  progress,
  removeAttachment,
  setStep,
  type Step,
  steps,
} from "./tasks/body.ts";
export { isBlocked, refTaken, relations, resolveRefs, resolveTask, wouldLoop } from "./tasks/refs.ts";
export { brief, dueBriefs, dueReminders, momentOf } from "./tasks/brief.ts";

const DEFAULT_SETTINGS: TaskSettings = { briefs: ["08:30", "13:30", "19:00"], remind: 15 };

const HOME = Deno.env.get("HOME") ?? "";
export const tasksRoot = () => amEnv("TASKS") ?? `${HOME}/brains/tasks`;
const itemsDir = () => `${tasksRoot()}/items`;

function newId(now = new Date()): string {
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
    await writeAtomic(`${itemsDir()}/${t.id}.md`, toFile(t));
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

const oneLine = (s: string, max: number) => !/\n/.test(s) && s.length <= max;
/** Pure: a list of words kept once each, in order, empty ones out. */
const words = (
  xs: string[],
  lower = false,
) => [...new Set(xs.map((x) => (lower ? x.toLowerCase() : x).trim().replace(/\s+/g, " ")).filter(Boolean))];

/** A task's title names the thing, like a commit's subject: what is to be done, not how or why, which
 *  go in the notes. Longer titles crowd the owner's board and stop reading as a name. */
export const MAX_TITLE = 80;

/** Pure: an input checked and applied onto a task (null clears a field). Throws with what is wrong. */
export function applyInput(base: Task, input: TaskInput, now: Date): Task {
  const t: Task = { ...base };
  if (input.title !== undefined) {
    if (!input.title.trim()) throw new Error("a task needs a title");
    const title = input.title.trim().replace(/\s+/g, " ");
    if (title.length > MAX_TITLE) {
      throw new Error(
        `a task's title is ${title.length} characters, at most ${MAX_TITLE}: name the thing in a few words ` +
          "(what is to be done) and put the how, the why and the details in the notes",
      );
    }
    t.title = title;
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
const serial = serializer();

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

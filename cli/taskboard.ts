// taskboard.ts — the console's Tasks tab: the board, one task's page, its steps and attachments,
// files dropped on it, local files opened with the desktop's default program, and the calendar.
// Every write goes through shared/mcp/lib/tasks.ts, the same code the MCP server uses, so a chat
// and the console change a task the same way; `base` (the version the page holds) keeps the page
// from overwriting a change a chat made meanwhile.

import { calendarAsTasks } from "./agenda.ts";
import { HOME } from "./lib.ts";
import { projectTree, resolveProject } from "./projects.ts";
import {
  addAttachment, addDays, addStep, addTask, attachments, dayOf, getTask, listTasks, progress, removeAttachment, setStep, StaleError, steps,
  storeFile, type Task, type TaskInput, tasksRoot, updateTask, validDay,
} from "../shared/mcp/lib/tasks.ts";

export const TASK_FILE_MAX = 50 * 1024 * 1024;
const OPENABLE = /\.(pdf|txt|md|csv|json|odt|ods|odp|docx?|xlsx?|pptx?|rtf|epub|png|jpe?g|gif|webp|svg|heic|avif|bmp|tiff?|mp3|wav|ogg|opus|flac|m4a|mp4|mkv|webm|mov|avi|zip|7z|tar|gz)$/i;

/** A request body read up to `max` bytes; null past it, whatever the Content-Length claimed. */
async function bodyUpTo(req: Request, max: number): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.body ?? []) {
    size += chunk.length;
    if (size > max) return null;
    parts.push(chunk);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
type Json = (o: unknown, status?: number) => Response;

/** A task as the board shows it: the folder its project means, the checklist's progress, how many
 *  attachments. The notes travel only with the task's own page. */
function card(t: Task, tree: Awaited<ReturnType<typeof projectTree>>) {
  const { notes: _notes, ...rest } = t;
  return { ...rest, folder: resolveProject(t.project, tree), progress: progress(t.notes), attachments: attachments(t.notes).length };
}

const full = (t: Task) => ({ task: t, steps: steps(t.notes), progress: progress(t.notes), attachments: attachments(t.notes) });

/** Where an attachment points on this machine: a stored file under files/, or a path under $HOME.
 *  Null for anything else, so the console never opens a path it was not meant to. */
async function localPath(target: string): Promise<string | null> {
  const root = tasksRoot();
  const abs = target.startsWith("files/") ? `${root}/${target}` : target.startsWith("~/") ? `${HOME}/${target.slice(2)}` : target;
  if (!abs.startsWith("/")) return null;
  let real: string;
  try { real = await Deno.realPath(abs); } catch { return null; }
  const inside = target.startsWith("files/") ? real.startsWith(`${await Deno.realPath(root)}/files/`) : real.startsWith(`${HOME}/`);
  if (!inside) return null;
  const st = await Deno.stat(real);
  if (st.isDirectory) return real;
  // a file opens only when its default program is a viewer: documents, images, sound, video.
  // Anything else (.desktop, .jar, scripts, executables) could run instead of opening.
  if (!OPENABLE.test(real) || ((st.mode ?? 0) & 0o111)) return null;
  return real;
}

export async function taskApi(req: Request, u: URL, json: Json, changed: () => void): Promise<Response | null> {
  const p = u.pathname;
  if (!p.startsWith("/api/tasks/") && p !== "/api/open") return null;
  const write = req.method === "POST";
  if (write && req.headers.get("x-claude-multi") !== "1") return json({ error: "missing header" }, 403);

  if (p === "/api/tasks/board") {
    const [tasks, tree] = await Promise.all([listTasks(), projectTree()]);
    const since = addDays(dayOf(new Date()), -14);
    const shown = tasks.filter((t) => t.status !== "dropped" || u.searchParams.has("dropped"))
      // done tasks stay on the board for two weeks, then only in the files (and in search)
      .filter((t) => t.status !== "done" || (t.done ?? t.updated).slice(0, 10) >= since || u.searchParams.has("done"));
    return json({ today: dayOf(new Date()), tasks: shown.map((t) => card(t, tree)), projects: tree });
  }

  if (p === "/api/tasks/item") {
    const t = await getTask(u.searchParams.get("id") ?? "");
    return t ? json(full(t)) : json({ error: "no such task" }, 404);
  }

  if (p === "/api/tasks/agenda") {
    const from = u.searchParams.get("from") ?? "", to = u.searchParams.get("to") ?? "";
    if (!validDay(from) || !validDay(to) || to < from) return json({ error: "from and to are days, YYYY-MM-DD" }, 400);
    const days = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1;
    if (days > 62) return json({ error: "at most two months at a time" }, 400);
    const [tasks, cal] = await Promise.all([listTasks(), calendarAsTasks(days, from)]);
    const inRange = (t: Task) => !!t.due && t.due >= from && t.due <= to && t.status !== "dropped";
    return json({ tasks: [...tasks.filter(inRange), ...cal.tasks.filter(inRange)], errors: cal.errors });
  }

  if (p === "/api/tasks/op" && write) {
    const b = await req.json().catch(() => ({})) as TaskInput & { op?: string; id?: string; base?: string; index?: number; done?: boolean; text?: string; target?: string; label?: string };
    const { op, id = "", base, index, done, text, target, label, ...input } = b;
    try {
      let r: { task: Task };
      if (op === "add") r = { task: await addTask(input) };
      else if (op === "update") r = await updateTask(id, input, new Date(), base);
      else if (op === "step") {
        if (!Number.isInteger(index)) return json({ ok: false, message: "a step is chosen by its index" });
        r = await updateTask(id, (t) => ({ notes: setStep(t.notes ?? "", index!, done) }));
      }
      else if (op === "addstep") r = await updateTask(id, (t) => ({ notes: addStep(t.notes ?? "", String(text ?? "")) }));
      else if (op === "attach") r = await updateTask(id, (t) => ({ notes: addAttachment(t.notes ?? "", String(target ?? ""), label) }));
      else if (op === "detach") {
        if (!Number.isInteger(index)) return json({ ok: false, message: "an attachment is chosen by its index" });
        r = await updateTask(id, (t) => ({ notes: removeAttachment(t.notes ?? "", index!) }));
      }
      else return json({ ok: false, message: "unknown operation" });
      changed();
      return json({ ok: true, ...full(r.task) });
    } catch (e) {
      if (e instanceof StaleError) return json({ ok: false, stale: true, message: e.message, ...full(e.current) });
      return json({ ok: false, message: (e as Error).message });
    }
  }

  if (p === "/api/tasks/file" && write) {
    const id = req.headers.get("x-task-id") ?? "", name = decodeURIComponent(req.headers.get("x-filename") ?? "");
    if (Number(req.headers.get("content-length") ?? 0) > TASK_FILE_MAX) return json({ ok: false, message: "over 50 MB" });
    try {
      if (!(await getTask(id))) return json({ ok: false, message: "no such task" });
      const bytes = await bodyUpTo(req, TASK_FILE_MAX);
      if (!bytes) return json({ ok: false, message: "over 50 MB" });
      const rel = await storeFile(id, name, bytes);
      const r = await updateTask(id, (t) => ({ notes: addAttachment(t.notes ?? "", rel, name) }));
      changed();
      return json({ ok: true, ...full(r.task) });
    } catch (e) {
      return json({ ok: false, message: (e as Error).message });
    }
  }

  if (p === "/api/open" && write) {
    const { target } = await req.json().catch(() => ({})) as { target?: string };
    const path = await localPath(String(target ?? ""));
    if (!path) return json({ ok: false, message: "not a file or folder this console opens" });
    new Deno.Command("xdg-open", { args: [path], stdout: "null", stderr: "null" }).spawn();
    return json({ ok: true });
  }
  return null;
}

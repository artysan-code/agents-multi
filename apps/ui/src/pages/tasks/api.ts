// api.ts — the Tasks page's endpoints (/api/tasks/*, /api/open) and the shapes they answer with. The data
// is shared/mcp/lib/tasks.ts: the same files a chat changes through the tasks MCP server.

import { get, post, type Result } from "../../api.ts";
import { t } from "../../i18n.ts";
import { toast } from "../../lib/ui.tsx";

export type Status = "todo" | "doing" | "waiting" | "done" | "dropped";
export interface Progress {
  done: number;
  total: number;
  pct: number;
}

/** A task as the board lists it. */
export interface BoardTask {
  id: string;
  title: string;
  status: Status;
  owner?: string;
  project?: string;
  folder: string | null;
  priority?: number;
  due?: string;
  time?: string;
  repeat?: string;
  ref?: string;
  stage?: string;
  labels?: string[];
  detail?: string;
  created?: string;
  updated?: string;
  done?: string;
  progress: Progress | null;
  attachments?: number;
  parts?: { done: number; total: number };
  parent?: string;
  blocked_by?: string[];
  blocked?: boolean;
}

export interface ProjectNode {
  path: string;
  name: string;
  depth: number;
  repo: boolean;
}

export interface Board {
  today: string;
  tasks: BoardTask[];
  projects: ProjectNode[];
}

/** A task with its notes, as the sheet reads it. */
export interface TaskFull extends Omit<BoardTask, "folder" | "progress"> {
  notes?: string;
  remind?: number;
}

export interface LinkedTask {
  id: string;
  ref?: string;
  title: string;
  status: Status;
}

export interface Links {
  parent: LinkedTask | null;
  parts: LinkedTask[];
  blocked_by: LinkedTask[];
  blocking: LinkedTask[];
}

export interface Attachment {
  label: string;
  target: string;
  kind: "url" | "file" | "path" | "page";
}

export interface NoteLine {
  day?: string;
  text: string;
}

/** /api/tasks/item, and what every write answers with. */
export interface Item {
  task: TaskFull;
  steps: { text: string; done: boolean }[];
  progress: Progress | null;
  attachments: Attachment[];
  log?: NoteLine[];
  decisions?: NoteLine[];
  links?: Links;
}

export type OpBody =
  | { op: "update"; id: string; status?: string; base?: string; [field: string]: unknown }
  | { op: "step"; id: string; index: number; done: boolean }
  | { op: "addstep"; id: string; text: string }
  | { op: "note"; id: string; section: "log" | "decisions"; text: string }
  | { op: "attach"; id: string; target: string }
  | { op: "detach"; id: string; index: number };

export type Answer = Item & { ok: true };
type Refused = { ok: false; message?: string; stale?: boolean } & Partial<Item>;

export const loadBoard = () => get<Board>("/api/tasks/board");
export const loadItem = (id: string) => get<Item>(`/api/tasks/item?id=${encodeURIComponent(id)}`);

/** One write. A refusal is a toast and `null`; a stale one (it changed meanwhile) hands the current
 *  version to `onStale`. */
export async function taskOp(body: OpBody, onStale?: (current: Item) => void): Promise<Answer | null> {
  const r = await post<Answer | Refused>("/api/tasks/op", body).catch((e: Error): Refused => ({
    ok: false,
    message: e.message,
  }));
  if (!r.ok) {
    toast(r.stale ? t("ts.stale") : r.message ?? "", true);
    if (r.stale && onStale && r.task) onStale(r as Item);
    return null;
  }
  return r;
}

/** Uploads one file to a task's folder (the request body is the file itself). */
export async function uploadFile(id: string, f: File): Promise<Answer | Refused> {
  try {
    const res = await fetch("/api/tasks/file", {
      method: "POST",
      headers: { "x-claude-multi": "1", "x-task-id": id, "x-filename": encodeURIComponent(f.name) },
      body: f,
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`.trim());
    return await res.json() as Answer | Refused;
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Opens a path on this computer with the desktop's own program. */
export async function openPath(target: string): Promise<void> {
  const r = await post<Result>("/api/open", { target }).catch((e: Error): Result => ({ ok: false, message: e.message }));
  if (!r.ok) toast(r.message ?? "", true);
}

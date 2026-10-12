// format.ts — a task as its Markdown file, and back.

import { type Status, STATUSES, type Task } from "./types.ts";

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

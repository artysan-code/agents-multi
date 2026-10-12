// body.ts — the notes of a task: its checklist, its log and decisions, its attachments.

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

type AttachmentKind = "url" | "file" | "path" | "page";
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

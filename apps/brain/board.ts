// board.ts — the person's tasks on the web: /tasks, a board by status that works from a phone, and
// /tasks/<id>, one task to read and change. Signed in like the account page (a session cookie), and
// running as the account like everything else: every change goes through the task rules of
// shared/mcp/lib/tasks.ts, the same ones the chats and the console use, so a task changed here is
// the task every Claude sees. Plain forms, one redirect after each change: no script.

import {
  addNote,
  addStep,
  addTask,
  attachments,
  dayOf,
  getTask,
  listTasks,
  type NoteSection,
  notesOf,
  progress,
  relations,
  resolveRefs,
  setStep,
  StaleError,
  type Status,
  STATUSES,
  steps,
  type Task,
  type TaskInput,
  updateTask,
} from "../../shared/mcp/lib/tasks.ts";
import { esc, page } from "./pages.ts";

const COLUMNS: { status: Status; label: string }[] = [
  { status: "todo", label: "Da fare" },
  { status: "doing", label: "In corso" },
  { status: "waiting", label: "In attesa" },
  { status: "done", label: "Fatte da poco" },
];
const STATUS_LABEL: Record<Status, string> = {
  todo: "da fare",
  doing: "in corso",
  waiting: "in attesa",
  done: "fatta",
  dropped: "lasciata",
};
const DONE_DAYS = 7;

const dayLabel = (d: string, today: string) => {
  if (d === today) return "oggi";
  const x = new Date(`${d}T12:00:00`);
  return x.toLocaleDateString("it-IT", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(d.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}),
  });
};
const closed = (t: Task) => t.status === "done" || t.status === "dropped";

/** Pure: the order inside a column — late first, then by day and time, then priority, then title. */
export function boardOrder(a: Task, b: Task): number {
  const da = a.due ?? "9999", db = b.due ?? "9999";
  return da.localeCompare(db) || (a.time ?? "99").localeCompare(b.time ?? "99") ||
    (a.priority ?? 2) - (b.priority ?? 2) || a.title.localeCompare(b.title);
}

/** Pure: which tasks the board shows, by column: the filters applied, done ones only from the last days. */
export function columns(tasks: Task[], f: { project?: string; q?: string }, now: Date): Map<Status, Task[]> {
  const since = dayOf(new Date(now.getTime() - DONE_DAYS * 86400_000));
  const q = f.q?.trim().toLowerCase();
  const out = new Map<Status, Task[]>(COLUMNS.map((c) => [c.status, []]));
  for (const t of tasks) {
    if (f.project && t.project !== f.project && !t.project?.startsWith(`${f.project}/`)) continue;
    if (q && ![t.title, t.ref, t.project, t.stage, ...(t.labels ?? [])].some((s) => s?.toLowerCase().includes(q))) {
      continue;
    }
    if (t.status === "done" && (!t.done || dayOf(new Date(t.done)) < since)) continue;
    out.get(t.status)?.push(t);
  }
  for (const [s, list] of out) {
    list.sort(s === "done" ? (a, b) => (b.done ?? "").localeCompare(a.done ?? "") : boardOrder);
  }
  return out;
}

function card(t: Task, all: Task[], me: string, today: string, back: string): string {
  const p = progress(t.notes);
  const rel = relations(all, t);
  const late = !closed(t) && t.due && t.due < today;
  const meta = [
    t.project && `<span>${esc(t.project)}</span>`,
    t.ref && `<span class="ref">${esc(t.ref)}</span>`,
    t.stage && `<span>${esc(t.stage)}</span>`,
    t.due &&
    `<span class="${late ? "late" : ""}">${esc(dayLabel(t.due, today))}${t.time ? ` ${esc(t.time)}` : ""}</span>`,
    t.owner && t.owner !== me && `<span>→ ${esc(t.owner)}</span>`,
    rel.waiting_for.length && `<span class="late">bloccata</span>`,
    rel.parts.length && `<span>parti ${rel.parts_done}/${rel.parts.length}</span>`,
    p && `<span>${p.done}/${p.total}</span>`,
    t.priority === 1 && `<span class="late">!</span>`,
  ].filter(Boolean).join("");
  const move = (to: Status, label: string) =>
    `<form method="post" action="/tasks/${t.id}/status" class="inline"><input type="hidden" name="status" value="${to}"><input type="hidden" name="back" value="${
      esc(back)
    }"><button class="ghost sm">${label}</button></form>`;
  const acts = t.status === "todo"
    ? move("doing", "Inizia") + move("done", "Fatta")
    : t.status === "doing" || t.status === "waiting"
    ? move("done", "Fatta")
    : "";
  return `<li class="card"><a href="/tasks/${t.id}">${esc(t.title)}</a>
    ${meta ? `<div class="meta">${meta}</div>` : ""}
    ${p ? `<div class="bar"><i style="width:${p.pct}%"></i></div>` : ""}
    ${
    t.labels?.length
      ? `<div class="meta">${t.labels.map((l) => `<span class="lab">${esc(l)}</span>`).join("")}</div>`
      : ""
  }
    ${acts ? `<div class="acts">${acts}</div>` : ""}</li>`;
}

/** The board: four columns, a filter by project and words, a line to add a task. */
export function boardPage(
  name: string,
  me: string,
  all: Task[],
  f: { project?: string; q?: string },
  now: Date,
  error = "",
): string {
  const today = dayOf(now);
  const cols = columns(all, f, now);
  const projects = [...new Set(all.filter((t) => !closed(t)).map((t) => t.project).filter((p): p is string => !!p))]
    .sort();
  const back = `/tasks${
    f.project || f.q
      ? `?${new URLSearchParams({ ...(f.project ? { project: f.project } : {}), ...(f.q ? { q: f.q } : {}) })}`
      : ""
  }`;
  return page(
    "Task",
    `
  <header class="top"><h1>Le task di ${esc(name)}</h1>
    <nav><a href="/account">Account</a> · <form method="post" action="/account/logout" class="inline"><button class="link">Esci</button></form></nav></header>
  ${error ? `<p class="err">${esc(error)}</p>` : ""}
  <form method="get" action="/tasks" class="row filters">
    <select name="project"><option value="">Tutti i progetti</option>${
      projects.map((p) => `<option${p === f.project ? " selected" : ""}>${esc(p)}</option>`).join("")
    }</select>
    <input name="q" value="${
      esc(f.q ?? "")
    }" placeholder="cerca" type="search"><button class="ghost">Filtra</button></form>
  <form method="post" action="/tasks/add" class="row add">
    <input name="title" placeholder="Nuova task" required maxlength="200">
    <input name="project" placeholder="progetto" value="${esc(f.project ?? "")}" list="projects">
    <input name="due" type="date"><input name="time" type="time">
    <input type="hidden" name="back" value="${esc(back)}"><button>Aggiungi</button></form>
  <datalist id="projects">${projects.map((p) => `<option>${esc(p)}</option>`).join("")}</datalist>
  <div class="board">${
      COLUMNS.map((c) => {
        const list = cols.get(c.status)!;
        return `<section><h2>${c.label} <span class="sub">${list.length}</span></h2><ul>${
          list.map((t) => card(t, all, me, today, back)).join("") || `<li class="sub">nessuna</li>`
        }</ul></section>`;
      }).join("")
    }</div>`,
    "board",
  );
}

/** One task: its fields to change, its steps to tick, its decisions and log, what it is linked to. */
export function taskPage(t: Task, all: Task[], now: Date, error = ""): string {
  const today = dayOf(now);
  const rel = relations(all, t);
  const st = steps(t.notes);
  // the free text before the first section (steps, log, decisions, attachments: shown on their own)
  const description = (t.notes ?? "").split(/^#{1,2}\s/m)[0].trim();
  const link = (x: Task) =>
    `<a href="/tasks/${x.id}">${esc(x.title)}</a> <span class="sub">${esc(STATUS_LABEL[x.status])}</span>`;
  const field = (label: string, input: string) => `<label>${label}${input}</label>`;
  const v = (k: keyof Task) => esc(String(t[k] ?? ""));
  const list = (section: NoteSection) =>
    notesOf(t.notes, section).reverse().map((n) =>
      `<li>${n.day ? `<span class="sub">${esc(dayLabel(n.day, today))}</span> ` : ""}${esc(n.text)}</li>`
    ).join("");
  const att = attachments(t.notes);
  return page(
    t.title,
    `
  <header class="top"><a href="/tasks${
      t.project ? `?project=${encodeURIComponent(t.project)}` : ""
    }">← Bacheca</a></header>
  <h1>${esc(t.title)}</h1>
  <div class="meta">${
      [t.project, t.ref, STATUS_LABEL[t.status], t.due && dayLabel(t.due, today) + (t.time ? ` ${t.time}` : "")].filter(
        Boolean,
      ).map((s) => `<span>${esc(String(s))}</span>`).join("")
    }</div>
  ${error ? `<p class="err">${esc(error)}</p>` : ""}
  ${description ? `<div class="notes">${esc(description)}</div>` : ""}
  ${
      st.length || !closed(t)
        ? `<h2>Passi${st.length ? ` <span class="sub">${st.filter((s) => s.done).length}/${st.length}</span>` : ""}</h2>
  <ul class="steps">${
          st.map((s, i) =>
            `<li><form method="post" action="/tasks/${t.id}/step" class="inline"><input type="hidden" name="index" value="${i}">
    <button class="tick${s.done ? " on" : ""}" aria-pressed="${s.done}" title="${
              s.done ? "togli la spunta" : "spunta"
            }">${s.done ? "✓" : ""}</button></form><span${s.done ? ' class="sub"' : ""}>${esc(s.text)}</span></li>`
          ).join("")
        }</ul>
  <form method="post" action="/tasks/${t.id}/addstep" class="row"><input name="text" placeholder="nuovo passo" required maxlength="300"><button class="ghost">Aggiungi</button></form>`
        : ""
    }
  ${
      rel.parent || rel.parts.length || rel.waiting_for.length || rel.blocking.length
        ? `<h2>Collegamenti</h2><ul class="plain">
    ${rel.parent ? `<li>Fa parte di ${link(rel.parent)}</li>` : ""}
    ${rel.parts.map((x) => `<li>Parte: ${link(x)}</li>`).join("")}
    ${rel.waiting_for.map((x) => `<li>Aspetta ${link(x)}</li>`).join("")}
    ${rel.blocking.map((x) => `<li>La aspetta ${link(x)}</li>`).join("")}</ul>`
        : ""
    }
  ${
      att.length
        ? `<h2>Allegati</h2><ul class="plain">${
          att.map((a) =>
            `<li>${
              a.kind === "url"
                ? `<a href="${esc(a.target)}" rel="noopener noreferrer" target="_blank">${esc(a.label)}</a>`
                : `${esc(a.label)} <code class="sub">${esc(a.target)}</code>`
            }</li>`
          ).join("")
        }</ul>`
        : ""
    }
  <h2>Note</h2>
  <form method="post" action="/tasks/${t.id}/note" class="row"><select name="section"><option value="log">Fatto</option><option value="decisions">Decisione</option></select>
    <input name="text" placeholder="una riga" required maxlength="500"><button class="ghost">Scrivi</button></form>
  ${list("decisions") ? `<h3>Decisioni</h3><ul class="plain">${list("decisions")}</ul>` : ""}
  ${list("log") ? `<h3>Log</h3><ul class="plain">${list("log")}</ul>` : ""}
  <h2>Dettagli</h2>
  <form method="post" action="/tasks/${t.id}/edit" class="grid">
    <input type="hidden" name="base" value="${v("updated")}">
    ${field("Titolo", `<input name="title" value="${v("title")}" required maxlength="200">`)}
    ${
      field(
        "Stato",
        `<select name="status">${
          STATUSES.map((s) => `<option value="${s}"${s === t.status ? " selected" : ""}>${STATUS_LABEL[s]}</option>`)
            .join("")
        }</select>`,
      )
    }
    ${field("Giorno", `<input name="due" type="date" value="${v("due")}">`)}
    ${field("Ora", `<input name="time" type="time" value="${v("time")}">`)}
    ${field("Progetto", `<input name="project" value="${v("project")}">`)}
    ${field("Di chi", `<input name="owner" value="${v("owner")}" autocapitalize="none">`)}
    ${
      field(
        "Priorità",
        `<select name="priority">${
          [["", "normale"], ["1", "alta"], ["3", "bassa"]].map(([k, l]) =>
            `<option value="${k}"${
              String(t.priority === 2 ? "" : t.priority ?? "") === k ? " selected" : ""
            }>${l}</option>`
          ).join("")
        }</select>`,
      )
    }
    ${field("Ref", `<input name="ref" value="${v("ref")}" maxlength="40">`)}
    ${field("Fase", `<input name="stage" value="${v("stage")}" maxlength="40">`)}
    ${
      field(
        "Etichette",
        `<input name="labels" value="${esc((t.labels ?? []).join(", "))}" placeholder="separate da virgole">`,
      )
    }
    ${field("Dettaglio", `<input name="detail" value="${v("detail")}" maxlength="500">`)}
    <button>Salva</button></form>
  <p class="sub">Creata ${esc(new Date(t.created).toLocaleDateString("it-IT"))} · ${esc(t.id)}</p>`,
    "wide",
  );
}

/** Pure: the edit form as a task input: empty fields clear, labels split on commas. */
export function editInput(f: URLSearchParams): TaskInput {
  const s = (k: string) => (f.get(k) ?? "").trim();
  const opt = (k: string) => s(k) || null;
  return {
    title: s("title"),
    status: s("status") as Status,
    due: opt("due"),
    time: opt("time"),
    project: opt("project"),
    owner: opt("owner"),
    priority: s("priority") ? Number(s("priority")) as 1 | 3 : null,
    ref: opt("ref"),
    stage: opt("stage"),
    labels: s("labels") ? s("labels").split(",") : null,
    detail: opt("detail"),
  };
}

/** Pure: where to go after a change — a page of the board, never elsewhere. */
export const backTo = (b: string | null, fallback: string) =>
  b && /^\/tasks(\/t-[\w-]+)?(\?[^\s]*)?$/.test(b) ? b : fallback;

const see = (location: string) =>
  new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
const withError = (to: string, e: unknown) =>
  `${to}${to.includes("?") ? "&" : "?"}err=${encodeURIComponent((e as Error).message)}`;

/**
 * /tasks and below, for a signed-in account: already running as it (its tasks, its owner).
 * `render` wraps a page in the response the service gives every page.
 */
export async function boardRoute(
  req: Request,
  u: URL,
  me: { id: string; name: string },
  render: (body: string, status?: number) => Response,
  now = new Date(),
): Promise<Response> {
  const p = u.pathname;
  const err = u.searchParams.get("err") ?? "";
  if (p === "/tasks" && req.method === "GET") {
    const f = { project: u.searchParams.get("project") || undefined, q: u.searchParams.get("q") || undefined };
    return render(boardPage(me.name, me.id, await listTasks(), f, now, err));
  }
  if (p === "/tasks/add" && req.method === "POST") {
    const f = new URLSearchParams(await req.text());
    const back = backTo(f.get("back"), "/tasks");
    try {
      const input: TaskInput = {
        title: f.get("title") ?? "",
        project: f.get("project")?.trim() || undefined,
        due: f.get("due") || undefined,
        time: f.get("time") || undefined,
      };
      await addTask(resolveRefs(await listTasks(), input, null), now);
      return see(back);
    } catch (e) {
      return see(withError(back, e));
    }
  }
  const m = p.match(/^\/tasks\/(t-[\w-]+)(?:\/(status|step|addstep|note|edit))?$/);
  if (!m) return render(page("Task", `<h1>Non c'è</h1><p><a href="/tasks">Torna alla bacheca</a></p>`), 404);
  const [, id, op] = m;
  const here = `/tasks/${id}`;
  if (!op && req.method === "GET") {
    const t = await getTask(id);
    if (!t) {
      return render(page("Task", `<h1>Questa task non c'è</h1><p><a href="/tasks">Torna alla bacheca</a></p>`), 404);
    }
    return render(taskPage(t, await listTasks(), now, err));
  }
  if (!op || req.method !== "POST") return render(page("Task", `<h1>Non c'è</h1>`), 405);
  const f = new URLSearchParams(await req.text());
  const back = backTo(f.get("back"), here);
  try {
    if (op === "status") await updateTask(id, { status: f.get("status") as Status }, now);
    else if (op === "step") {
      await updateTask(id, (t) => ({ notes: setStep(t.notes ?? "", Number(f.get("index"))) }), now);
    } else if (op === "addstep") {
      await updateTask(id, (t) => ({ notes: addStep(t.notes ?? "", f.get("text") ?? "") }), now);
    } else if (op === "note") {
      const section = f.get("section") === "decisions" ? "decisions" : "log";
      await updateTask(id, (t) => ({ notes: addNote(t.notes ?? "", section, f.get("text") ?? "", dayOf(now)) }), now);
    } else if (op === "edit") {
      const cur = await getTask(id);
      if (!cur) throw new Error(`no task ${id}`);
      const input = editInput(f);
      if (input.status === cur.status) delete input.status; // saving a done task again keeps the day it was done
      await updateTask(id, resolveRefs(await listTasks(), input, cur), now, f.get("base") || undefined);
    }
    return see(back);
  } catch (e) {
    if (e instanceof StaleError) {
      return see(
        withError(here, new Error("Qualcuno l'ha cambiata nel frattempo: eccola com'è ora, rifai la modifica.")),
      );
    }
    return see(withError(back, e));
  }
}

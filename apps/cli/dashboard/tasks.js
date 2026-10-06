// deno-lint-ignore-file no-window no-unused-vars -- browser scripts sharing one global scope (app.js, brain.js, tasks.js)
/* claude-multi console — the Tasks tab. A task lives in a project: the projects are the owner's
   folders (personal/…, work/…), plus the short names a chat used, plus "no project" for simple
   things. On the left the projects that have something open; on the right either all of them at a
   glance or one project's board, and each task's own page (steps, description, attachments).
   A new task is explained to Claude in the field at the bottom, which writes it down.
   Loaded after app.js, whose helpers it uses ($, esc, api, post, toast, t, lang, drawer, mdToHtml,
   askContext). The data is shared/mcp/lib/tasks.ts through /api/tasks/*: the same files a chat
   changes through the tasks MCP server, so a "tasks" event redraws what is open. */

const COLS = ["todo", "doing", "waiting", "done"];
const NONE = "~none";
let TB = null; // /api/tasks/board
let tProject = null, tQuery = "", tOwner = "all", tAllFolders = false; // tProject: null = all projects
try {
  tProject = localStorage.getItem("cm-tproject") || null;
} catch { /* storage blocked: all projects */ }

async function loadBoard() {
  TB = await api("/api/tasks/board");
  renderBoard();
}

/* ---------------- helpers ---------------- */
const isMine = (x) => !x.owner || x.owner === OWNER.id;
const open = (x) => x.status !== "done" && x.status !== "dropped";
const dayLabel = (day, time) => {
  if (!day) return "";
  const today = TB?.today ?? new Date().toISOString().slice(0, 10);
  const d = new Date(day + "T12:00");
  const tomorrow = new Date(new Date(today + "T12:00").getTime() + 86400000).toISOString().slice(0, 10);
  const label = day === today
    ? t("tb.today")
    : day === tomorrow
    ? t("tb.tomorrow")
    : d.toLocaleDateString(lang(), { weekday: "short", day: "numeric", month: "short" });
  return time ? `${label}, ${time}` : label;
};
/** Progress from notes, for entries that come with their notes (Today's brief). */
const notesProgress = (notes) => {
  const all = (notes ?? "").match(/^\s*[-*] \[[ xX]\] /gm) ?? [];
  if (!all.length) return null;
  const done = all.filter((s) => /\[[xX]\]/.test(s)).length;
  return { done, total: all.length, pct: Math.round(done / all.length * 100) };
};
const bar = (p) =>
  p
    ? `<span class="tbar" title="${p.done}/${p.total}"><i style="width:${p.pct}%"></i></span><small class="tpct">${p.done}/${p.total}</small>`
    : "";
const byDue = (a, b) =>
  (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.time ?? "99").localeCompare(b.time ?? "99") ||
  (a.priority ?? 2) - (b.priority ?? 2);
const byWeight = (a, b) => (a.priority ?? 2) - (b.priority ?? 2) || byDue(a, b) || a.title.localeCompare(b.title);

/** The project a task belongs to, as the left column keys it: its folder, the name a chat gave it
 *  when that is no folder, or none. */
const projectOf = (x) => x.folder ?? (x.project ? `~other:${x.project}` : NONE);
const projectLabel = (k) =>
  k === NONE ? t("tb.noProject") : (k.startsWith("~other:") ? k.slice(7) : k).split("/").pop();
const openCount = (n) => t(n === 1 ? "tb.sum1" : "tb.sum", { n });
/** What a new task in that project is told about where it belongs. */
const projectValue = (k) => k === NONE || !k ? null : k.startsWith("~other:") ? k.slice(7) : k;
const inProject = (x, k) =>
  k === NONE || k.startsWith("~other:")
    ? projectOf(x) === k
    : !!x.folder && (x.folder === k || x.folder.startsWith(k + "/"));

function visible() {
  const q = tQuery.toLowerCase();
  return TB.tasks.filter((x) =>
    (!tProject || inProject(x, tProject)) &&
    (tOwner === "all" || (tOwner === "me"
      ? isMine(x)
      : tOwner === "claude"
      ? x.owner === "claude"
      : !isMine(x) && x.owner !== "claude")) &&
    (!q ||
      `${x.ref ?? ""} ${x.title} ${x.project ?? ""} ${x.folder ?? ""} ${x.stage ?? ""} ${(x.labels ?? []).join(" ")}`
        .toLowerCase().includes(q))
  );
}

/* ---------------- the frame ---------------- */
function renderBoard() {
  if (!TB) return;
  // a project that has gone (its last task moved) falls back to the overview
  if (tProject && !TB.tasks.some((x) => inProject(x, tProject)) && !TB.projects.some((n) => n.path === tProject)) {
    tProject = null;
  }
  $$("#tb-owner [data-owner]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.owner === tOwner)));
  renderFolders();
  renderHead();
  const xs = visible();
  $("#tb-body").innerHTML = tProject ? boardHtml(xs) : overviewHtml(xs);
  // on this page the field writes new tasks, in the project on screen
  if (view === "tasks") askContext("newtask", tProject === NONE ? NONE : projectValue(tProject));
}

function renderFolders() {
  const counts = new Map(), other = new Map();
  let none = 0;
  for (const x of TB.tasks.filter(open)) {
    if (x.folder) {
      const parts = x.folder.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join("/");
        counts.set(p, (counts.get(p) ?? 0) + 1);
      }
    } else if (x.project) other.set(x.project, (other.get(x.project) ?? 0) + 1);
    else none++;
  }
  const nodes = TB.projects.filter((n) =>
    n.depth > 0 && (counts.has(n.path) || (tAllFolders && n.depth <= 2) || n.path === tProject)
  );
  const roots = TB.projects.filter((n) => n.depth === 0 && (counts.has(n.path) || tAllFolders));
  const row = (key, label, n, depth = 0) =>
    `<button class="tf${tProject === key ? " on" : ""}" data-project="${esc(key)}" style="--d:${depth}" title="${
      esc(key)
    }"><span>${esc(label)}</span>${n ? `<i>${n}</i>` : ""}</button>`;
  $("#tb-folders").innerHTML =
    `<button class="tf${tProject === null ? " on" : ""}" data-project=""><span>${esc(t("tb.allProjects"))}</span><i>${
      TB.tasks.filter(open).length
    }</i></button>` +
    row(NONE, t("tb.noProject"), none) +
    roots.map((r) =>
      `<div class="tf root" style="--d:0"><span>${esc(r.name)}</span></div>` +
      nodes.filter((n) => n.path.startsWith(r.path + "/")).map((n) =>
        row(n.path, n.name, counts.get(n.path) ?? 0, n.depth - 1)
      ).join("")
    ).join("") +
    (other.size
      ? `<div class="tf root"><span>${esc(t("tb.other"))}</span></div>` +
        [...other].sort().map(([p, n]) => row(`~other:${p}`, p, n)).join("")
      : "") +
    `<button class="tf-more" id="tb-allf">${esc(t(tAllFolders ? "tb.fewFolders" : "tb.allFolders"))}</button>`;
}

function renderHead() {
  const xs = TB.tasks.filter((x) => !tProject || inProject(x, tProject));
  const openN = xs.filter(open).length;
  const steps = xs.filter(open).reduce(
    (a, x) => x.progress ? { d: a.d + x.progress.done, n: a.n + x.progress.total } : a,
    { d: 0, n: 0 },
  );
  const isFolder = tProject && !tProject.startsWith("~");
  $("#tb-title").innerHTML = `<h2>${esc(tProject ? projectLabel(tProject) : t("tb.allProjects"))}</h2>
    <div class="crumb">
      ${
    isFolder
      ? `<span>~/${esc(tProject)}</span><button data-open-folder="${esc(tProject)}">${esc(t("ts.openFolder"))}</button>`
      : ""
  }
      <span>${esc(openCount(openN))}${steps.n ? `, ${esc(t("tb.steps", { d: steps.d, n: steps.n }))}` : ""}</span>
    </div>`;
}

/* ---------------- cards and boards ---------------- */
function cardHtml(x) {
  const today = TB.today;
  const late = x.due && x.due < today && open(x);
  const where = tProject ? "" : projectLabel(projectOf(x));
  return `<article class="tcard${x.status === "doing" ? " doing" : ""}" draggable="true" data-task="${esc(x.id)}">
    <div class="tc-top">${
    [
      x.ref ? `<span class="tc-ref">${esc(x.ref)}</span>` : "",
      x.priority === 1 ? `<span class="tc-prio">${esc(t("ts.p1"))}</span>` : "",
      where ? `<span class="tc-where">${esc(where)}</span>` : "",
      x.due
        ? `<span class="tc-due${late ? " tc-late" : x.due === today ? " tc-today" : ""}">${
          esc(dayLabel(x.due, x.time))
        }</span>`
        : "",
    ].join("")
  }</div>
    <div class="tc-t">${esc(x.title)}</div>
    ${x.blocked && open(x) ? `<span class="tc-blocked">${esc(t("tb.blocked"))}</span>` : ""}
    <div class="tc-m">${
    [
      x.stage ? `<span class="tc-stage">${esc(x.stage)}</span>` : "",
      ...(x.labels ?? []).map((l) => `<span class="tc-label">${esc(l)}</span>`),
      x.owner && x.owner !== OWNER.id ? `<span class="tc-who"><i>${esc(x.owner[0])}</i>${esc(x.owner)}</span>` : "",
      x.repeat ? `<span title="${esc(t(`ts.r.${x.repeat}`))}">${esc(t(`ts.r.${x.repeat}`))}</span>` : "",
      x.attachments ? `<span>${esc(t("tb.attN", { n: x.attachments }))}</span>` : "",
      x.parts ? `<span>${esc(t("tb.parts", { d: x.parts.done, n: x.parts.total }))}</span>` : "",
    ].join("")
  }</div>
    ${x.progress && x.status !== "done" ? `<div class="tc-pr">${bar(x.progress)}</div>` : ""}
  </article>`;
}

function boardHtml(xs) {
  return `<div class="kanban">` + COLS.map((c) => {
    const cs = xs.filter((x) => x.status === c).sort(
      c === "done" ? (a, b) => (b.done ?? "").localeCompare(a.done ?? "") : byWeight,
    );
    return `<section class="kcol" data-col="${c}">
      <header><b>${esc(t(`tb.col.${c}`))}</b><i>${cs.length}</i></header>
      <div class="kcards">${
      cs.map(cardHtml).join("") ||
      (c === "done" ? "" : `<div class="kempty">${esc(t(c === "todo" ? "tb.emptyTodo" : "tb.dropHere"))}</div>`)
    }</div>
    </section>`;
  }).join("") + `</div>`;
}

/** All projects at a glance: what is open in each, how far along, and what comes next. */
function overviewHtml(xs) {
  const groups = new Map();
  for (const x of xs.filter(open)) {
    const k = projectOf(x);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const keys = [...groups.keys()].sort((a, b) =>
    (a === NONE ? 1 : 0) - (b === NONE ? 1 : 0) || projectLabel(a).localeCompare(projectLabel(b))
  );
  if (!keys.length) return `<div class="kempty">${esc(t("tb.empty"))}</div>`;
  return `<div class="plist">` + keys.map((k) => {
    const g = groups.get(k).sort(byDue);
    const next = g.find((x) => x.status !== "waiting") ?? g[0];
    const steps = g.reduce((a, x) => x.progress ? { d: a.d + x.progress.done, n: a.n + x.progress.total } : a, {
      d: 0,
      n: 0,
    });
    const doing = g.some((x) => x.status === "doing");
    return `<button class="pcard${doing ? " doing" : ""}" data-project="${esc(k)}">
      <span class="pc-h"><b>${esc(projectLabel(k))}</b><span class="pc-n">${esc(openCount(g.length))}</span></span>
      ${k === NONE ? "" : `<small>${esc(k.startsWith("~other:") ? k.slice(7) : `~/${k}`)}</small>`}
      ${
      steps.n
        ? `<span class="tc-pr">${
          bar({ done: steps.d, total: steps.n, pct: Math.round(steps.d / steps.n * 100) })
        }</span>`
        : ""
    }
      <span class="pc-next">${next.due ? `<span>${esc(dayLabel(next.due, next.time))}</span>  ` : ""}${
      esc(next.title)
    }</span>
    </button>`;
  }).join("") + `</div>`;
}

/* ---------------- changes ---------------- */
async function taskOp(body) {
  const r = await post("/api/tasks/op", body).catch((e) => ({ ok: false, message: e.message }));
  if (!r.ok) {
    toast(r.stale ? t("ts.stale") : r.message, true);
    if (r.stale && sheet?.id === body.id) renderSheet(r);
    return null;
  }
  return r;
}
async function moveTask(id, status) {
  const x = TB.tasks.find((y) => y.id === id);
  if (!x || x.status === status) return;
  const was = x.status;
  x.status = status; // optimistic: the card moves now, the event redraws with the truth
  renderBoard();
  const r = await taskOp({ op: "update", id, status });
  if (!r) {
    x.status = was;
    renderBoard();
    return;
  }
  toast(t("tb.moved", { t: r.task.title, s: t(`tb.col.${status}`) }));
  await loadBoard();
}

/* ---------------- one task's page ---------------- */
let sheet = null; // { id, host, data, mode }

async function openTask(id) {
  const data = await api(`/api/tasks/item?id=${encodeURIComponent(id)}`).catch((e) => {
    toast(e.message, true);
    return null;
  });
  if (!data) return;
  const host = drawer(t("title.tasks"), `<div class="tsheet"></div>`);
  $(".drawer", host).classList.add("wide");
  sheet = { id, host, data, mode: "view" };
  const gone = new MutationObserver(() => {
    if (host.isConnected) return;
    if (sheet?.host === host) sheet = null; // not a newer page that replaced this one
    gone.disconnect();
  });
  gone.observe(document.body, { childList: true });
  wireSheet(host);
  renderSheet(data);
}

/** The description is the notes up to the first section the page manages (steps, log, decisions, attachments). */
const MANAGED = /^##\s+(steps|passi|log|diario|decisions|decisioni|attachments|allegati)\s*$/im;
/** Another task as a link on this page: its ref, its title, where it stands. */
const linkHtml = (l) =>
  `<li><button class="ts-link${open(l) ? "" : " closed"}" data-open-task="${esc(l.id)}">
  ${l.ref ? `<span class="tc-ref">${esc(l.ref)}</span>` : ""}<span>${esc(l.title)}</span><small>${
    esc(t(`tb.col.${l.status}`))
  }</small></button></li>`;
const refOf = (l) => l.ref ?? l.id;
/** Where the detail of a task is, as something the console opens: a URL, a brain page, or a file
 *  (a path relative to the project's folder, ~/…, or absolute; the #anchor is dropped). */
function detailTarget(d, folder) {
  if (/^https?:\/\//.test(d)) return { kind: "url", target: d };
  const page = d.match(/^\[\[([^\]|]+)/);
  if (page) return { kind: "page", target: page[1] };
  const path = d.replace(/#.*$/, "");
  return {
    kind: "path",
    target: path.startsWith("/") || path.startsWith("~/") ? path : folder ? `~/${folder}/${path}` : path,
  };
}
function splitNotes(notes = "") {
  const m = notes.match(MANAGED);
  return m
    ? { desc: notes.slice(0, m.index).trim(), rest: notes.slice(m.index).trim() }
    : { desc: notes.trim(), rest: "" };
}

function renderSheet(data) {
  if (!sheet) return;
  // a redraw (an answer, a chat's change) must not take away what is being typed: the text fields
  // keep their draft, and the focus stays where it was
  const box0 = $(".tsheet", sheet.host);
  const drafts = new Map($$("textarea[name=desc], .ts-row input", box0).map((f) => [f.name, f.value]));
  const fa = box0.contains(document.activeElement) ? document.activeElement : null;
  const focused = fa ? { name: fa.name, a: fa.selectionStart, b: fa.selectionEnd } : null;
  const oldDesc = sheet.data ? splitNotes(sheet.data.task.notes).desc : "";
  sheet.data = data;
  const x = data.task, p = data.progress, folder = TB?.tasks.find((y) => y.id === x.id)?.folder ?? null;
  const { desc } = splitNotes(x.notes);
  const opt = (v, l, cur) =>
    `<option value="${esc(v)}"${String(cur ?? "") === String(v) ? " selected" : ""}>${esc(l)}</option>`;
  const icon = (k) =>
    ({
      url:
        `<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>`,
      file: `<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>`,
      path: `<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`,
      page:
        `<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="10" cy="18" r="2.5"/><path d="M8.3 7l7.4.7M7 8.3l2.2 7.4"/>`,
    })[k];
  const projects = (TB?.projects ?? []).map((n) => n.path);
  const stages = [...new Set((TB?.tasks ?? []).map((y) => y.stage).filter(Boolean))].sort();
  const L = data.links ?? { parent: null, parts: [], blocked_by: [], blocking: [] };
  const linked = L.parent || L.parts.length || L.blocked_by.length || L.blocking.length;
  const notesSec = (key, items, ph) =>
    `<section class="ts-sec">
      <h4>${esc(t(`ts.${key}`))}${items.length ? `<span class="sub">${items.length}</span>` : ""}</h4>
      <ul class="ts-log">${
      items.map((n) => `<li>${n.day ? `<small>${esc(dayLabel(n.day))}</small>` : ""}<span>${esc(n.text)}</span></li>`)
        .join("")
    }</ul>
      <form class="ts-row" data-form="${
      key === "log" ? "log" : "decisions"
    }"><input class="search" name="${key}" placeholder="${esc(t(ph))}" autocomplete="off"></form>
    </section>`;
  $(".tsheet", sheet.host).innerHTML = `
    <div class="ts-crumb">
      ${
    folder
      ? `<svg viewBox="0 0 24 24" class="ico">${icon("path")}</svg><span>${esc(folder.split("/").join(" › "))}</span>
        <button class="btn sm" data-open-folder="${esc(folder)}">${esc(t("ts.openFolder"))}</button>`
      : `<span class="sub">${esc(x.project ?? t("tb.noProject"))}</span>`
  }
      ${
    x.detail ? `<button class="btn sm" data-detail title="${esc(x.detail)}">${esc(t("ts.openDetail"))}</button>` : ""
  }
    </div>
    <input class="ts-title" name="title" value="${esc(x.title)}" aria-label="${esc(t("tb.h.title"))}">
    <div class="ts-props">
      <label><span>${esc(t("ts.status"))}</span><select name="status" class="sel">${
    [...COLS, "dropped"].map((s) => opt(s, t(`tb.col.${s}`), x.status)).join("")
  }</select></label>
      <label><span>${esc(t("ts.due"))}</span><input type="date" name="due" class="search" value="${
    esc(x.due ?? "")
  }"></label>
      <label><span>${esc(t("ts.time"))}</span><input type="time" name="time" class="search" value="${
    esc(x.time ?? "")
  }"></label>
      <label><span>${esc(t("ts.priority"))}</span><select name="priority" class="sel">${
    [1, 2, 3].map((n) => opt(n, t(`ts.p${n}`), x.priority ?? 2)).join("")
  }</select></label>
      <label><span>${esc(t("ts.owner"))}</span><input name="owner" class="search" list="ts-owners" value="${
    esc(x.owner ?? OWNER.id)
  }" autocomplete="off"></label>
      <label class="wide"><span>${
    esc(t("ts.project"))
  }</span><input name="project" class="search" list="ts-projects" value="${
    esc(x.project ?? "")
  }" autocomplete="off"></label>
      <label><span>${esc(t("ts.repeat"))}</span><select name="repeat" class="sel">${opt("", t("ts.r.none"), x.repeat)}${
    ["daily", "weekdays", "weekly", "monthly"].map((r) => opt(r, t(`ts.r.${r}`), x.repeat)).join("")
  }</select></label>
      <label><span>${
    esc(t("ts.remind"))
  }</span><input type="number" min="0" max="1440" name="remind" class="search" value="${
    esc(x.remind ?? "")
  }" placeholder="15"></label>
      <label><span>${esc(t("ts.ref"))}</span><input name="ref" class="search" value="${
    esc(x.ref ?? "")
  }" placeholder="TASK-1" autocomplete="off"></label>
      <label><span>${esc(t("ts.stage"))}</span><input name="stage" class="search" list="ts-stages" value="${
    esc(x.stage ?? "")
  }" autocomplete="off"></label>
      <label class="wide"><span>${esc(t("ts.labels"))}</span><input name="labels" class="search" value="${
    esc((x.labels ?? []).join(", "))
  }" autocomplete="off"></label>
      <label><span>${esc(t("ts.parent"))}</span><input name="parent" class="search" value="${
    esc(L.parent ? refOf(L.parent) : x.parent ?? "")
  }" placeholder="${esc(t("ts.refPh"))}" autocomplete="off"></label>
      <label><span>${esc(t("ts.blockedBy"))}</span><input name="blocked_by" class="search" value="${
    esc(L.blocked_by.map(refOf).join(", "))
  }" placeholder="${esc(t("ts.refsPh"))}" autocomplete="off"></label>
      <label class="wide"><span>${esc(t("ts.detail"))}</span><input name="detail" class="search" value="${
    esc(x.detail ?? "")
  }" placeholder="${esc(t("ts.detailPh"))}" autocomplete="off"></label>
      <datalist id="ts-stages">${stages.map((st) => `<option value="${esc(st)}">`).join("")}</datalist>
      <datalist id="ts-owners">${[OWNER.id, "claude"].map((o) => `<option value="${o}">`).join("")}</datalist>
      <datalist id="ts-projects">${projects.map((pp) => `<option value="${esc(pp)}">`).join("")}</datalist>
    </div>

    <section class="ts-sec">
      <h4>${esc(t("ts.steps"))}${p ? `<span class="sub">${p.done}/${p.total} · ${p.pct}%</span>` : ""}</h4>
      ${p ? `<div class="ts-bar"><i style="width:${p.pct}%"></i></div>` : ""}
      <div class="ts-steps">${
    data.steps.map((s, i) =>
      `<label class="ts-step${s.done ? " done" : ""}"><input type="checkbox" data-step="${i}" ${
        s.done ? "checked" : ""
      }><span>${esc(s.text)}</span></label>`
    ).join("")
  }</div>
      <form class="ts-row" data-form="step"><input class="search" name="text" placeholder="${
    esc(t("ts.addStep"))
  }" autocomplete="off"></form>
    </section>

    ${
    linked
      ? `<section class="ts-sec">
      <h4>${esc(t("ts.links"))}</h4>
      ${L.parent ? `<h5>${esc(t("ts.parent"))}</h5><ul class="ts-links">${linkHtml(L.parent)}</ul>` : ""}
      ${
        L.parts.length
          ? `<h5>${esc(t("ts.parts"))} <span class="sub">${
            L.parts.filter((l) => !open(l)).length
          }/${L.parts.length}</span></h5><ul class="ts-links">${L.parts.map(linkHtml).join("")}</ul>`
          : ""
      }
      ${
        L.blocked_by.length
          ? `<h5>${esc(t("ts.blockedBy"))}</h5><ul class="ts-links">${L.blocked_by.map(linkHtml).join("")}</ul>`
          : ""
      }
      ${
        L.blocking.length
          ? `<h5>${esc(t("ts.blocking"))}</h5><ul class="ts-links">${L.blocking.map(linkHtml).join("")}</ul>`
          : ""
      }
    </section>`
      : ""
  }

    <section class="ts-sec">
      <h4>${esc(t("ts.desc"))}<span class="seg sm">
        <button data-desc="view" aria-pressed="${sheet.mode === "view"}">${esc(t("ts.preview"))}</button>
        <button data-desc="edit" aria-pressed="${sheet.mode === "edit"}">${esc(t("ts.edit"))}</button></span></h4>
      ${
    sheet.mode === "edit"
      ? `<textarea class="ts-desc search" name="desc" rows="8" placeholder="${esc(t("ts.descPh"))}">${
        esc(desc)
      }</textarea>`
      : `<div class="md ts-md" data-desc="edit">${
        desc ? mdToHtml(desc) : `<p class="sub">${esc(t("ts.descPh"))}</p>`
      }</div>`
  }
    </section>

    ${notesSec("decisions", data.decisions ?? [], "ts.decPh")}
    ${notesSec("log", data.log ?? [], "ts.logPh")}

    <section class="ts-sec">
      <h4>${esc(t("ts.att"))}</h4>
      <ul class="ts-att">${
    data.attachments.map((a, i) =>
      `<li>
        <svg viewBox="0 0 24 24" class="ico">${icon(a.kind)}</svg>
        <button class="ts-a" data-att="${i}" title="${esc(a.target)}"><b>${esc(a.label)}</b><small>${
        esc(a.target)
      }</small></button>
        <button class="x" data-detach="${i}" aria-label="${esc(t("ts.remove"))}" title="${
        esc(t("ts.remove"))
      }">×</button></li>`
    ).join("")
  }</ul>
      <form class="ts-row" data-form="attach"><input class="search" name="target" placeholder="${
    esc(t("ts.attPh"))
  }" autocomplete="off"><button class="btn" type="submit">${esc(t("mk.add"))}</button></form>
      <label class="ts-drop"><input type="file" multiple hidden>
        <svg viewBox="0 0 24 24" class="ico"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>
        <span>${esc(t("ts.drop"))}</span></label>
    </section>

    <footer class="ts-foot">
      <span class="sub">${esc(t("ts.created", { a: ago(x.created), b: ago(x.updated) }))} · <code>${
    esc(x.id)
  }</code></span>
      <span class="r"></span>
      ${
    x.status === "done"
      ? `<button class="btn" data-set="todo">${esc(t("ts.reopen"))}</button>`
      : `<button class="btn" data-set="dropped">${
        esc(t("ts.drop2"))
      }</button><button class="btn primary" data-set="done">${esc(t("ts.done"))}</button>`
  }
    </footer>`;
  const box = $(".tsheet", sheet.host);
  for (const [name, v] of drafts) {
    const f = $(`[name="${name}"]`, box);
    // the description draft wins only while it differs from what was saved before
    if (f && v && (name !== "desc" || v !== oldDesc)) f.value = v;
  }
  if (focused?.name) {
    const f = $(`[name="${focused.name}"]`, box);
    if (f) {
      f.focus();
      try {
        if (focused.a != null) f.setSelectionRange(focused.a, focused.b);
      } catch { /* a field without a caret */ }
    }
  }
}

function wireSheet(host) {
  const box = $(".tsheet", host);
  const me = sheet; // this page's state: a later page replaces the global, not this
  // Writes of this page run one after the other, each with the version the previous one returned:
  // a status change right after a description edit would otherwise carry a stale base.
  let queue = Promise.resolve();
  const enqueue = (job) => (queue = queue.then(job, job));
  const alive = () => sheet === me;
  const save = (input) =>
    enqueue(async () => {
      const r = await taskOp({ op: "update", id: me.id, base: me.data.task.updated, ...input });
      if (r) {
        me.data = r;
        if (alive()) renderSheet(r);
        loadBoard().catch(() => {});
      } else if (alive()) renderSheet(me.data); // a refused value goes back to the saved one
    });
  box.addEventListener("change", async (e) => {
    const f = e.target;
    if (f.matches("[data-step]")) {
      return enqueue(async () => {
        const r = await taskOp({ op: "step", id: me.id, index: Number(f.dataset.step), done: f.checked });
        if (r) {
          me.data = r;
          if (alive()) renderSheet(r);
          loadBoard().catch(() => {});
        }
      });
    }
    if (f.type === "file") return uploadFiles([...f.files]);
    const name = f.name;
    if (
      ![
        "title",
        "status",
        "due",
        "time",
        "priority",
        "owner",
        "project",
        "repeat",
        "remind",
        "ref",
        "stage",
        "labels",
        "detail",
        "parent",
        "blocked_by",
      ].includes(name)
    ) return;
    const v = f.value.trim();
    if (name === "title" && !v) return renderSheet(me.data);
    const list = (s) => s.split(",").map((y) => y.trim()).filter(Boolean);
    const input = {
      [name]: v === ""
        ? null
        : name === "priority" || name === "remind"
        ? Number(v)
        : name === "labels" || name === "blocked_by"
        ? list(v)
        : v,
    };
    // a time needs a day: the page's own date field decides it, today when empty
    if (name === "time" && v && !me.data.task.due) input.due = TB?.today;
    await save(input);
  });
  // The description saves itself a moment after typing stops, on leaving the field, and on Esc.
  // It never redraws the page: a redraw between a button's press and release loses the click.
  let descTimer = null;
  const saveDesc = (ta) => {
    clearTimeout(descTimer);
    const next = ta.value.trim();
    return enqueue(async () => {
      const { desc, rest } = splitNotes(me.data.task.notes);
      if (next === desc) return;
      const r = await taskOp({
        op: "update",
        id: me.id,
        base: me.data.task.updated,
        notes: [next, rest].filter(Boolean).join("\n\n") || null,
      });
      if (r) {
        me.data = r;
        loadBoard().catch(() => {});
      }
    });
  };
  box.addEventListener("input", (e) => {
    if (!e.target.matches("textarea[name=desc]")) return;
    clearTimeout(descTimer);
    descTimer = setTimeout(() => saveDesc(e.target), 900);
  });
  box.addEventListener("focusout", (e) => {
    if (e.target.matches("textarea[name=desc]")) saveDesc(e.target);
  });
  // Esc closes the drawer by removing it, and a removed field gets no focusout: save first
  const onEsc = (e) => {
    if (e.key !== "Escape") return;
    const ta = $("textarea[name=desc]", box);
    if (ta && document.activeElement === ta) saveDesc(ta);
  };
  document.addEventListener("keydown", onEsc, true);
  new MutationObserver((_, obs) => {
    if (host.isConnected) return;
    document.removeEventListener("keydown", onEsc, true);
    obs.disconnect();
  }).observe(document.body, { childList: true });
  box.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, v = f.elements[0].value.trim();
    if (!v) return;
    f.elements[0].value = ""; // before the redraw, which keeps drafts
    const kind = f.dataset.form;
    const r = await taskOp(
      kind === "step"
        ? { op: "addstep", id: me.id, text: v }
        : kind === "log" || kind === "decisions"
        ? { op: "note", id: me.id, section: kind, text: v }
        : { op: "attach", id: me.id, target: v },
    );
    if (r) {
      me.data = r;
      renderSheet(r);
      loadBoard().catch(() => {});
      $(`form[data-form="${f.dataset.form}"] input`, box)?.focus();
    }
  });
  box.addEventListener("click", async (e) => {
    // a [[wiki page]] in the description opens the brain, before the click edits the text
    const pg = e.target.closest("[data-page]");
    if (pg) return openAttachment({ kind: "page", target: pg.dataset.page });
    if (e.target.closest("a[href]")) return; // a web link in the description opens, it does not edit
    const d = e.target.closest("[data-desc]");
    if (d) {
      me.mode = d.dataset.desc;
      renderSheet(me.data);
      if (me.mode === "edit") $("textarea[name=desc]", box)?.focus();
      return;
    }
    const s = e.target.closest("[data-set]");
    if (s) return save({ status: s.dataset.set });
    const ot = e.target.closest("[data-open-task]");
    if (ot) return openTask(ot.dataset.openTask);
    if (e.target.closest("[data-detail]")) {
      const folder = TB?.tasks.find((y) => y.id === me.id)?.folder ?? null;
      return openAttachment(detailTarget(me.data.task.detail, folder));
    }
    const a = e.target.closest("[data-att]");
    if (a) return openAttachment(me.data.attachments[Number(a.dataset.att)]);
    const x = e.target.closest("[data-detach]");
    if (x) {
      const r = await taskOp({ op: "detach", id: me.id, index: Number(x.dataset.detach) });
      if (r) {
        me.data = r;
        renderSheet(r);
        loadBoard().catch(() => {});
      }
    }
  });
  const drop = () => $(".ts-drop", box);
  box.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      drop()?.classList.add("over");
    }
  });
  box.addEventListener("dragleave", (e) => {
    if (!box.contains(e.relatedTarget)) drop()?.classList.remove("over");
  });
  box.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    drop()?.classList.remove("over");
    uploadFiles([...e.dataTransfer.files]);
  });
}

async function uploadFiles(files) {
  const me = sheet; // the files belong to the task whose page they were dropped on
  if (!me || !files.length) return;
  toast(t("ts.uploading", { n: files.length }));
  let last = null;
  for (const f of files) {
    const r = await api("/api/tasks/file", {
      method: "POST",
      headers: { "x-claude-multi": "1", "x-task-id": me.id, "x-filename": encodeURIComponent(f.name) },
      body: f,
    })
      .catch((e) => ({ ok: false, message: e.message }));
    if (!r.ok) {
      toast(`${f.name}: ${r.message}`, true);
      continue;
    }
    last = r;
  }
  if (last) {
    me.data = last;
    if (sheet === me) renderSheet(last);
    loadBoard().catch(() => {});
  }
}

async function openAttachment(a) {
  if (!a) return;
  if (a.kind === "url") return void window.open(a.target, "_blank", "noopener");
  if (a.kind === "page") {
    $(".scrim")?.parentElement?.remove();
    location.hash = "brain";
    return void openBrainPage(a.target);
  }
  const r = await post("/api/open", { target: a.target }).catch((e) => ({ ok: false, message: e.message }));
  if (!r.ok) toast(r.message, true);
}

/* ---------------- events ---------------- */
{
  const root = $("#v-tasks");
  const pick = (k) => {
    tProject = k || null;
    try {
      localStorage.setItem("cm-tproject", tProject ?? "");
    } catch { /* not remembered */ }
    renderBoard();
  };
  $("#tb-owner").addEventListener("click", (e) => {
    const b = e.target.closest("[data-owner]");
    if (b) {
      tOwner = b.dataset.owner;
      renderBoard();
    }
  });
  let qTimer = null;
  $("#tb-q").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      tQuery = e.target.value.trim();
      renderBoard();
    }, 120);
  });
  // a new task is explained to Claude, in the project on screen
  $("#tb-new").addEventListener("click", () => {
    askContext("newtask", tProject === NONE ? NONE : projectValue(tProject));
    $("#ask-text").focus();
  });
  root.addEventListener("click", async (e) => {
    const p = e.target.closest("[data-project]");
    if (p) return pick(p.dataset.project);
    if (e.target.closest("#tb-allf")) {
      tAllFolders = !tAllFolders;
      return renderFolders();
    }
    const of = e.target.closest("[data-open-folder]");
    if (of) {
      const r = await post("/api/open", { target: `~/${of.dataset.openFolder}` }).catch((err) => ({
        ok: false,
        message: err.message,
      }));
      return r.ok || toast(r.message, true);
    }
    const card = e.target.closest("[data-task]");
    if (card) return openTask(card.dataset.task);
  });
  // dragging a card between columns sets its status
  let dragId = null;
  root.addEventListener("dragstart", (e) => {
    const c = e.target.closest?.(".tcard");
    if (!c) return;
    dragId = c.dataset.task;
    e.dataTransfer.setData("text/plain", dragId);
    e.dataTransfer.effectAllowed = "move";
    c.classList.add("dragging");
  });
  root.addEventListener("dragend", () => {
    dragId = null;
    $$(".tcard.dragging, .kcol.over").forEach((x) => x.classList.remove("dragging", "over"));
  });
  root.addEventListener("dragover", (e) => {
    const col = e.target.closest(".kcol");
    if (!col || !dragId) return;
    e.preventDefault();
    $$(".kcol.over").forEach((x) => x !== col && x.classList.remove("over"));
    col.classList.add("over");
  });
  root.addEventListener("drop", (e) => {
    const col = e.target.closest(".kcol");
    if (!col || !dragId) return;
    e.preventDefault();
    const id = dragId;
    col.classList.remove("over");
    moveTask(id, col.dataset.col);
  });
}

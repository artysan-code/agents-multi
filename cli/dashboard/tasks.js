/* claude-multi console — the Tasks tab: a board (columns by status), a list, a calendar with the
   Google events, a board per project folder, and each task's own page (steps, description,
   attachments). Loaded after app.js, whose helpers it uses ($, esc, api, post, toast, t, lang,
   drawer, mdToHtml). The data is shared/mcp/lib/tasks.ts through /api/tasks/*: the same files a
   chat changes through the tasks MCP server, so a "tasks" event redraws what is open. */

const COLS = ["todo", "doing", "waiting", "done"];
const MODES = ["board", "list", "calendar", "projects"];
let TB = null; // /api/tasks/board
let tMode = "board", tFolder = null, tQuery = "", tOwner = "all", tAllFolders = false;
let tSort = { k: "due", d: 1 }, tMonth = null, AG = null;
try {
  const m = localStorage.getItem("cm-tmode");
  if (MODES.includes(m)) tMode = m;
} catch { /* storage blocked: the board */ }

async function loadBoard() {
  TB = await api("/api/tasks/board");
  renderBoard();
  if (tMode === "calendar") loadAgenda().catch((e) => toast(e.message, true));
}

/* ---------------- helpers ---------------- */
const isMine = (x) => !x.owner || x.owner === "samuel";
const open = (x) => x.status !== "done" && x.status !== "dropped";
const dayLabel = (day, time) => {
  if (!day) return "";
  const today = TB?.today ?? new Date().toISOString().slice(0, 10);
  const d = new Date(day + "T12:00");
  const tomorrow = new Date(new Date(today + "T12:00").getTime() + 86400000).toISOString().slice(0, 10);
  const label = day === today ? t("tb.today") : day === tomorrow ? t("tb.tomorrow") : d.toLocaleDateString(lang(), { weekday: "short", day: "numeric", month: "short" });
  return time ? `${label} · ${time}` : label;
};
/** The last two folders of a path, the way a card has room for: "acme › site". */
const crumb = (x) => {
  if (x.folder) return x.folder.split("/").slice(-2).join(" › ");
  return x.project ?? "";
};
/** Progress from notes, for entries that come with their notes (Today's brief). */
const notesProgress = (notes) => {
  const all = (notes ?? "").match(/^\s*[-*] \[[ xX]\] /gm) ?? [];
  if (!all.length) return null;
  const done = all.filter((s) => /\[[xX]\]/.test(s)).length;
  return { done, total: all.length, pct: Math.round(done / all.length * 100) };
};
const bar = (p) => p ? `<span class="tbar" title="${p.done}/${p.total}"><i style="width:${p.pct}%"></i></span><small class="tpct">${p.done}/${p.total}</small>` : "";
const byDue = (a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.time ?? "99").localeCompare(b.time ?? "99") || (a.priority ?? 2) - (b.priority ?? 2);
const byWeight = (a, b) => (a.priority ?? 2) - (b.priority ?? 2) || byDue(a, b) || a.title.localeCompare(b.title);

function visible() {
  const q = tQuery.toLowerCase();
  return TB.tasks.filter((x) =>
    (!tFolder || (tFolder === "~none" ? !x.project : tFolder.startsWith("~other:") ? !x.folder && x.project === tFolder.slice(7) : x.folder === tFolder || x.folder?.startsWith(tFolder + "/"))) &&
    (tOwner === "all" || (tOwner === "me" ? isMine(x) : tOwner === "claude" ? x.owner === "claude" : !isMine(x) && x.owner !== "claude")) &&
    (!q || `${x.title} ${x.project ?? ""} ${x.folder ?? ""}`.toLowerCase().includes(q))
  );
}

/* ---------------- the frame: folders on the left, a view on the right ---------------- */
function renderBoard() {
  if (!TB) return;
  $$("#tb-modes [data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === tMode)));
  $$("#tb-owner [data-owner]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.owner === tOwner)));
  renderFolders();
  const xs = visible();
  const el = $("#tb-body");
  el.className = `tb-body m-${tMode}`;
  if (tMode === "board") el.innerHTML = boardHtml(xs);
  if (tMode === "list") el.innerHTML = listHtml(xs);
  if (tMode === "projects") el.innerHTML = projectsHtml(xs);
  if (tMode === "calendar") el.innerHTML = calendarHtml();
  $("#tb-sum").textContent = t("tb.sum", { n: xs.filter(open).length });
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
  const nodes = TB.projects.filter((n) => n.depth === 0 || counts.has(n.path) || (tAllFolders && n.depth <= 2) || n.path === tFolder);
  const row = (key, label, n, depth = 0, cls = "") =>
    `<button class="tf${tFolder === key ? " on" : ""} ${cls}" data-folder="${esc(key ?? "")}" style="--d:${depth}" title="${esc(key ?? "")}">
      <svg viewBox="0 0 24 24" class="ico"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
      <span>${esc(label)}</span>${n ? `<i>${n}</i>` : ""}</button>`;
  $("#tb-folders").innerHTML =
    `<button class="tf${tFolder === null ? " on" : ""}" data-folder=""><span>${esc(t("tb.all"))}</span><i>${TB.tasks.filter(open).length}</i></button>` +
    `<div class="tf-h">${esc(t("tb.folders"))}</div>` +
    nodes.map((n) => row(n.path, n.name, counts.get(n.path) ?? 0, n.depth, n.depth === 0 ? "area" : "")).join("") +
    (other.size ? `<div class="tf-h">${esc(t("tb.other"))}</div>` + [...other].sort().map(([p, n]) => row(`~other:${p}`, p, n)).join("") : "") +
    (none ? row("~none", t("tb.noProject"), none) : "") +
    `<button class="tf-more" id="tb-allf">${esc(t(tAllFolders ? "tb.fewFolders" : "tb.allFolders"))}</button>`;
}

/* ---------------- cards ---------------- */
function cardHtml(x, compact = false) {
  const today = TB.today;
  const late = x.due && x.due < today && open(x);
  return `<article class="tcard${x.priority === 1 ? " hi" : ""}${x.status === "done" ? " done" : ""}" draggable="true" data-task="${esc(x.id)}">
    <div class="tc-t">${esc(x.title)}</div>
    <div class="tc-m">
      ${x.due ? `<span class="tc-due${late ? " late" : x.due === today ? " now" : ""}">${esc(dayLabel(x.due, x.time))}</span>` : ""}
      ${!compact && crumb(x) ? `<span class="tc-p">${esc(crumb(x))}</span>` : ""}
      ${x.owner && x.owner !== "samuel" ? `<span class="tc-o">${esc(x.owner)}</span>` : ""}
      ${x.repeat ? `<span class="tc-i" title="${esc(t(`ts.r.${x.repeat}`))}">↻</span>` : ""}
      ${x.attachments ? `<span class="tc-i" title="${esc(t("ts.att"))}">⧉ ${x.attachments}</span>` : ""}
    </div>
    ${x.progress ? `<div class="tc-pr">${bar(x.progress)}</div>` : ""}
  </article>`;
}

function boardHtml(xs, compact = false, key = "") {
  return `<div class="kanban${compact ? " compact" : ""}">` + COLS.map((c) => {
    const cs = xs.filter((x) => x.status === c).sort(c === "done" ? (a, b) => (b.done ?? "").localeCompare(a.done ?? "") : byWeight);
    return `<section class="kcol" data-col="${c}">
      <header><b>${esc(t(`tb.col.${c}`))}</b><i>${cs.length}</i></header>
      <div class="kcards">${cs.map((x) => cardHtml(x, compact)).join("") || `<div class="kempty">${esc(t("tb.dropHere"))}</div>`}</div>
      ${c === "todo" ? `<form class="kadd" data-folder="${esc(key)}"><input class="search" name="title" placeholder="${esc(t("tb.quick"))}" autocomplete="off"></form>` : ""}
    </section>`;
  }).join("") + `</div>`;
}

function projectsHtml(xs) {
  const groups = new Map();
  for (const x of xs) {
    const k = x.folder ?? (x.project ? `~other:${x.project}` : "~none");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const keys = [...groups.keys()].sort((a, b) => (a.startsWith("~") ? 1 : 0) - (b.startsWith("~") ? 1 : 0) || a.localeCompare(b));
  if (!keys.length) return `<div class="kempty big">${esc(t("tb.empty"))}</div>`;
  return keys.map((k) => {
    const g = groups.get(k);
    const label = k === "~none" ? t("tb.noProject") : k.startsWith("~other:") ? k.slice(7) : k.split("/").join(" › ");
    const openN = g.filter(open).length;
    return `<section class="pgroup">
      <header>
        <svg viewBox="0 0 24 24" class="ico"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
        <b>${esc(label)}</b><i>${openN}</i>
        ${k.startsWith("~") ? "" : `<button class="btn sm" data-open-folder="${esc(k)}">${esc(t("ts.openFolder"))}</button>`}
      </header>
      ${boardHtml(g, true, k.startsWith("~other:") ? k.slice(7) : k.startsWith("~") ? "" : k)}
    </section>`;
  }).join("");
}

function listHtml(xs) {
  const cols = [["title", "tb.h.title"], ["project", "tb.h.project"], ["due", "tb.h.due"], ["status", "tb.h.status"], ["progress", "tb.h.progress"], ["owner", "tb.h.owner"], ["priority", "tb.h.priority"]];
  const val = (x, k) => k === "project" ? (x.folder ?? x.project ?? "") : k === "due" ? `${x.due ?? "9999"}${x.time ?? ""}` : k === "status" ? COLS.indexOf(x.status) : k === "progress" ? (x.progress?.pct ?? -1) : k === "priority" ? (x.priority ?? 2) : (x[k] ?? "");
  const rows = [...xs].sort((a, b) => {
    const A = val(a, tSort.k), B = val(b, tSort.k);
    return (typeof A === "number" ? A - B : String(A).localeCompare(String(B))) * tSort.d || byDue(a, b);
  });
  if (!rows.length) return `<div class="kempty big">${esc(t("tb.empty"))}</div>`;
  return `<div class="panel"><div class="scroll"><table class="tlist">
    <thead><tr><th></th>${cols.map(([k, l]) => `<th><button data-sort="${k}"${tSort.k === k ? ` class="on"` : ""}>${esc(t(l))}${tSort.k === k ? (tSort.d > 0 ? " ↑" : " ↓") : ""}</button></th>`).join("")}</tr></thead>
    <tbody>${rows.map((x) => `<tr data-task="${esc(x.id)}" class="${x.status === "done" ? "done" : ""}${x.due && x.due < TB.today && open(x) ? " late" : ""}">
      <td><input type="checkbox" data-done="${esc(x.id)}" ${x.status === "done" ? "checked" : ""} aria-label="${esc(t("ts.done"))}"></td>
      <td class="tl-t">${x.priority === 1 ? `<span class="hi-dot"></span>` : ""}${esc(x.title)}</td>
      <td class="tl-p">${esc(crumb(x))}</td>
      <td class="tl-d">${esc(dayLabel(x.due, x.time))}</td>
      <td><span class="st st-${x.status}">${esc(t(`tb.col.${x.status}`))}</span></td>
      <td>${bar(x.progress)}</td>
      <td>${esc(x.owner && x.owner !== "samuel" ? x.owner : "")}</td>
      <td>${esc(t(`ts.p${x.priority ?? 2}`))}</td>
    </tr>`).join("")}</tbody></table></div></div>`;
}

/* ---------------- calendar ---------------- */
const monthOf = (day) => day.slice(0, 7);
function monthGrid(month) {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1, 12);
  const start = new Date(first.getTime() - ((first.getDay() + 6) % 7) * 86400000); // back to Monday
  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  // six weeks only when the month needs them
  return days[35].slice(0, 7) === month ? days : days.slice(0, 35);
}
async function loadAgenda() {
  tMonth ??= monthOf(TB?.today ?? new Date().toISOString());
  const g = monthGrid(tMonth);
  AG = { month: tMonth, ...(await api(`/api/tasks/agenda?from=${g[0]}&to=${g[g.length - 1]}`)) };
  if (tMode === "calendar") $("#tb-body").innerHTML = calendarHtml();
}
function calendarHtml() {
  tMonth ??= monthOf(TB.today);
  const g = monthGrid(tMonth);
  const [y, m] = tMonth.split("-").map(Number);
  const title = new Date(y, m - 1, 1).toLocaleDateString(lang(), { month: "long", year: "numeric" });
  const ids = new Set(visible().map((x) => x.id));
  const byDay = new Map();
  // tasks from the agenda answer when it is this month's (it carries the events), filtered like the rest
  const entries = AG?.month === tMonth ? AG.tasks.filter((x) => x.source || ids.has(x.id) || !TB.tasks.some((b) => b.id === x.id)) : [];
  for (const x of entries) {
    if (!byDay.has(x.due)) byDay.set(x.due, []);
    byDay.get(x.due).push(x);
  }
  const wd = [...Array(7)].map((_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(lang(), { weekday: "short" }));
  return `<div class="cal">
    <header class="cal-h">
      <button class="btn sm" data-month="-1" aria-label="${esc(t("tb.prev"))}">‹</button>
      <b>${esc(title)}</b>
      <button class="btn sm" data-month="1" aria-label="${esc(t("tb.next"))}">›</button>
      <button class="btn sm" data-month="0">${esc(t("tb.thisMonth"))}</button>
      ${AG?.errors?.length ? `<span class="sub warn-t">${esc(t("tb.calErr", { e: AG.errors.join("; ") }))}</span>` : ""}
      ${AG?.month !== tMonth ? `<span class="sub">${esc(t("pl.loading"))}</span>` : ""}
    </header>
    <div class="cal-g">
      ${wd.map((d) => `<div class="cal-wd">${esc(d)}</div>`).join("")}
      ${g.map((d) => {
        const xs = (byDay.get(d) ?? []).sort((a, b) => (a.time ?? "00:00").localeCompare(b.time ?? "00:00"));
        const show = xs.slice(0, 4);
        return `<div class="cal-d${d.slice(0, 7) !== tMonth ? " other" : ""}${d === TB.today ? " today" : ""}" data-day="${d}">
          <span class="cal-n">${Number(d.slice(8))}</span>
          ${show.map((x) => `<button class="cal-e${x.source ? " ev" : ""}${x.status === "done" ? " done" : ""}" ${x.source ? "" : `data-task="${esc(x.id)}"`} title="${esc(`${x.time ?? ""} ${x.title}${x.project ? ` · ${x.project}` : ""}`)}">${x.time ? `<i>${esc(x.time)}</i>` : ""}${esc(x.title)}</button>`).join("")}
          ${xs.length > show.length ? `<span class="cal-more">${esc(t("tb.more", { n: xs.length - show.length }))}</span>` : ""}
        </div>`;
      }).join("")}
    </div>
  </div>`;
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
  if (!r) { x.status = was; renderBoard(); return; }
  toast(t("tb.moved", { t: r.task.title, s: t(`tb.col.${status}`) }));
  await loadBoard();
}
async function quickAdd(title, folder, extra = {}) {
  if (!title.trim()) return;
  const r = await taskOp({ op: "add", title, ...(folder ? { project: folder } : {}), ...extra });
  if (r) await loadBoard();
  return r;
}

/* ---------------- one task's page ---------------- */
let sheet = null; // { id, host, data, mode }

async function openTask(id) {
  const data = await api(`/api/tasks/item?id=${encodeURIComponent(id)}`).catch((e) => { toast(e.message, true); return null; });
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

/** The description is the notes up to the first section the page manages (steps, attachments). */
const MANAGED = /^##\s+(steps|passi|attachments|allegati)\s*$/im;
function splitNotes(notes = "") {
  const m = notes.match(MANAGED);
  return m ? { desc: notes.slice(0, m.index).trim(), rest: notes.slice(m.index).trim() } : { desc: notes.trim(), rest: "" };
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
  const opt = (v, l, cur) => `<option value="${esc(v)}"${String(cur ?? "") === String(v) ? " selected" : ""}>${esc(l)}</option>`;
  const icon = (k) => ({
    url: `<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>`,
    file: `<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>`,
    path: `<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`,
    page: `<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="10" cy="18" r="2.5"/><path d="M8.3 7l7.4.7M7 8.3l2.2 7.4"/>`,
  })[k];
  const projects = (TB?.projects ?? []).map((n) => n.path);
  $(".tsheet", sheet.host).innerHTML = `
    <div class="ts-crumb">
      ${folder ? `<svg viewBox="0 0 24 24" class="ico">${icon("path")}</svg><span>${esc(folder.split("/").join(" › "))}</span>
        <button class="btn sm" data-open-folder="${esc(folder)}">${esc(t("ts.openFolder"))}</button>` : `<span class="sub">${esc(x.project ?? t("tb.noProject"))}</span>`}
    </div>
    <input class="ts-title" name="title" value="${esc(x.title)}" aria-label="${esc(t("tb.h.title"))}">
    <div class="ts-props">
      <label><span>${esc(t("ts.status"))}</span><select name="status" class="sel">${[...COLS, "dropped"].map((s) => opt(s, t(`tb.col.${s}`), x.status)).join("")}</select></label>
      <label><span>${esc(t("ts.due"))}</span><input type="date" name="due" class="search" value="${esc(x.due ?? "")}"></label>
      <label><span>${esc(t("ts.time"))}</span><input type="time" name="time" class="search" value="${esc(x.time ?? "")}"></label>
      <label><span>${esc(t("ts.priority"))}</span><select name="priority" class="sel">${[1, 2, 3].map((n) => opt(n, t(`ts.p${n}`), x.priority ?? 2)).join("")}</select></label>
      <label><span>${esc(t("ts.owner"))}</span><input name="owner" class="search" list="ts-owners" value="${esc(x.owner ?? "samuel")}" autocomplete="off"></label>
      <label class="wide"><span>${esc(t("ts.project"))}</span><input name="project" class="search" list="ts-projects" value="${esc(x.project ?? "")}" autocomplete="off"></label>
      <label><span>${esc(t("ts.repeat"))}</span><select name="repeat" class="sel">${opt("", t("ts.r.none"), x.repeat)}${["daily", "weekdays", "weekly", "monthly"].map((r) => opt(r, t(`ts.r.${r}`), x.repeat)).join("")}</select></label>
      <label><span>${esc(t("ts.remind"))}</span><input type="number" min="0" max="1440" name="remind" class="search" value="${esc(x.remind ?? "")}" placeholder="15"></label>
      <datalist id="ts-owners">${["samuel", "claude"].map((o) => `<option value="${o}">`).join("")}</datalist>
      <datalist id="ts-projects">${projects.map((pp) => `<option value="${esc(pp)}">`).join("")}</datalist>
    </div>

    <section class="ts-sec">
      <h4>${esc(t("ts.steps"))}${p ? `<span class="sub">${p.done}/${p.total} · ${p.pct}%</span>` : ""}</h4>
      ${p ? `<div class="ts-bar"><i style="width:${p.pct}%"></i></div>` : ""}
      <div class="ts-steps">${data.steps.map((s, i) => `<label class="ts-step${s.done ? " done" : ""}"><input type="checkbox" data-step="${i}" ${s.done ? "checked" : ""}><span>${esc(s.text)}</span></label>`).join("")}</div>
      <form class="ts-row" data-form="step"><input class="search" name="text" placeholder="${esc(t("ts.addStep"))}" autocomplete="off"></form>
    </section>

    <section class="ts-sec">
      <h4>${esc(t("ts.desc"))}<span class="seg sm">
        <button data-desc="view" aria-pressed="${sheet.mode === "view"}">${esc(t("ts.preview"))}</button>
        <button data-desc="edit" aria-pressed="${sheet.mode === "edit"}">${esc(t("ts.edit"))}</button></span></h4>
      ${sheet.mode === "edit"
        ? `<textarea class="ts-desc search" name="desc" rows="8" placeholder="${esc(t("ts.descPh"))}">${esc(desc)}</textarea>`
        : `<div class="md ts-md" data-desc="edit">${desc ? mdToHtml(desc) : `<p class="sub">${esc(t("ts.descPh"))}</p>`}</div>`}
    </section>

    <section class="ts-sec">
      <h4>${esc(t("ts.att"))}</h4>
      <ul class="ts-att">${data.attachments.map((a, i) => `<li>
        <svg viewBox="0 0 24 24" class="ico">${icon(a.kind)}</svg>
        <button class="ts-a" data-att="${i}" title="${esc(a.target)}"><b>${esc(a.label)}</b><small>${esc(a.target)}</small></button>
        <button class="x" data-detach="${i}" aria-label="${esc(t("ts.remove"))}" title="${esc(t("ts.remove"))}">×</button></li>`).join("")}</ul>
      <form class="ts-row" data-form="attach"><input class="search" name="target" placeholder="${esc(t("ts.attPh"))}" autocomplete="off"><button class="btn" type="submit">${esc(t("mk.add"))}</button></form>
      <label class="ts-drop"><input type="file" multiple hidden>
        <svg viewBox="0 0 24 24" class="ico"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>
        <span>${esc(t("ts.drop"))}</span></label>
    </section>

    <footer class="ts-foot">
      <span class="sub">${esc(t("ts.created", { a: ago(x.created), b: ago(x.updated) }))} · <code>${esc(x.id)}</code></span>
      <span class="r"></span>
      ${x.status === "done" ? `<button class="btn" data-set="todo">${esc(t("ts.reopen"))}</button>` : `<button class="btn" data-set="dropped">${esc(t("ts.drop2"))}</button><button class="btn primary" data-set="done">${esc(t("ts.done"))}</button>`}
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
      try { if (focused.a != null) f.setSelectionRange(focused.a, focused.b); } catch { /* a field without a caret */ }
    }
  }
}

function wireSheet(host) {
  const box = $(".tsheet", host);
  const cur = () => sheet?.data.task;
  const save = async (input) => {
    const r = await taskOp({ op: "update", id: sheet.id, base: cur().updated, ...input });
    if (r) { renderSheet(r); loadBoard().catch(() => {}); }
  };
  box.addEventListener("change", async (e) => {
    const f = e.target;
    if (f.matches("[data-step]")) {
      const r = await taskOp({ op: "step", id: sheet.id, index: Number(f.dataset.step), done: f.checked });
      if (r) { renderSheet(r); loadBoard().catch(() => {}); }
      return;
    }
    if (f.type === "file") return uploadFiles([...f.files]);
    const name = f.name;
    if (!["title", "status", "due", "time", "priority", "owner", "project", "repeat", "remind"].includes(name)) return;
    let v = f.value.trim();
    if (name === "title" && !v) return renderSheet(sheet.data);
    const input = { [name]: v === "" ? null : name === "priority" || name === "remind" ? Number(v) : v };
    // a time needs a day: the page's own date field decides it, today when empty
    if (name === "time" && v && !cur().due) input.due = TB?.today;
    await save(input);
  });
  // the description saves itself a moment after typing stops (and on leaving the field), without
  // redrawing the page under the cursor
  let descTimer = null, descSaving = null;
  const saveDesc = async (ta) => {
    clearTimeout(descTimer);
    const { desc, rest } = splitNotes(cur().notes);
    const next = ta.value.trim();
    if (next === desc || descSaving === next) return;
    descSaving = next;
    const r = await taskOp({ op: "update", id: sheet.id, base: cur().updated, notes: [next, rest].filter(Boolean).join("\n\n") || null });
    descSaving = null;
    if (!r || !sheet) return;
    if (sheet.host.contains(document.activeElement) && document.activeElement === ta) sheet.data = r;
    else renderSheet(r);
    loadBoard().catch(() => {});
  };
  box.addEventListener("input", (e) => {
    if (!e.target.matches("textarea[name=desc]")) return;
    clearTimeout(descTimer);
    descTimer = setTimeout(() => saveDesc(e.target), 900);
  });
  box.addEventListener("focusout", (e) => {
    if (e.target.matches("textarea[name=desc]")) saveDesc(e.target);
  });
  box.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, v = f.elements[0].value.trim();
    if (!v) return;
    f.elements[0].value = ""; // before the redraw, which keeps drafts
    const r = await taskOp(f.dataset.form === "step" ? { op: "addstep", id: sheet.id, text: v } : { op: "attach", id: sheet.id, target: v });
    if (r) {
      renderSheet(r);
      loadBoard().catch(() => {});
      $(`form[data-form="${f.dataset.form}"] input`, box)?.focus();
    }
  });
  box.addEventListener("click", async (e) => {
    // a [[wiki page]] in the description opens the brain, before the click edits the text
    const pg = e.target.closest("[data-page]");
    if (pg) return openAttachment({ kind: "page", target: pg.dataset.page });
    const d = e.target.closest("[data-desc]");
    if (d) {
      sheet.mode = d.dataset.desc;
      renderSheet(sheet.data);
      if (sheet.mode === "edit") $("textarea[name=desc]", box)?.focus();
      return;
    }
    const s = e.target.closest("[data-set]");
    if (s) return save({ status: s.dataset.set });
    const a = e.target.closest("[data-att]");
    if (a) return openAttachment(sheet.data.attachments[Number(a.dataset.att)]);
    const x = e.target.closest("[data-detach]");
    if (x) {
      const r = await taskOp({ op: "detach", id: sheet.id, index: Number(x.dataset.detach) });
      if (r) { renderSheet(r); loadBoard().catch(() => {}); }
    }
  });
  const drop = () => $(".ts-drop", box);
  box.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); drop()?.classList.add("over"); } });
  box.addEventListener("dragleave", (e) => { if (!box.contains(e.relatedTarget)) drop()?.classList.remove("over"); });
  box.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    drop()?.classList.remove("over");
    uploadFiles([...e.dataTransfer.files]);
  });
}

async function uploadFiles(files) {
  if (!sheet || !files.length) return;
  toast(t("ts.uploading", { n: files.length }));
  let last = null;
  for (const f of files) {
    const r = await api("/api/tasks/file", { method: "POST", headers: { "x-claude-multi": "1", "x-task-id": sheet.id, "x-filename": encodeURIComponent(f.name) }, body: f })
      .catch((e) => ({ ok: false, message: e.message }));
    if (!r.ok) { toast(`${f.name}: ${r.message}`, true); continue; }
    last = r;
  }
  if (last) { renderSheet(last); loadBoard().catch(() => {}); }
}

async function openAttachment(a) {
  if (!a) return;
  if (a.kind === "url") return void window.open(a.target, "_blank", "noopener");
  if (a.kind === "page") {
    $(".scrim")?.parentElement?.remove();
    location.hash = "brain";
    return void setTimeout(() => typeof openBrainPage === "function" && openBrainPage(a.target), 50);
  }
  const r = await post("/api/open", { target: a.target }).catch((e) => ({ ok: false, message: e.message }));
  if (!r.ok) toast(r.message, true);
}

async function newTask(extra = {}) {
  const host = drawer(t("ts.newTitle"), `<form class="tsheet ts-new">
    <input class="ts-title" name="title" placeholder="${esc(t("ts.titlePh"))}" required autocomplete="off">
    <div class="ts-props">
      <label><span>${esc(t("ts.due"))}</span><input type="date" name="due" class="search" value="${esc(extra.due ?? "")}"></label>
      <label><span>${esc(t("ts.time"))}</span><input type="time" name="time" class="search"></label>
      <label class="wide"><span>${esc(t("ts.project"))}</span><input name="project" class="search" list="ts-projects2" value="${esc(extra.project ?? "")}" autocomplete="off"></label>
      <datalist id="ts-projects2">${(TB?.projects ?? []).map((n) => `<option value="${esc(n.path)}">`).join("")}</datalist>
    </div>
    <footer class="ts-foot"><span class="r"></span><button class="btn primary" type="submit">${esc(t("ts.create"))}</button></footer>
  </form>`);
  const f = $("form", host);
  $("input[name=title]", f).focus();
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = (n) => f.elements[n].value.trim() || undefined;
    const body = { op: "add", title: v("title"), due: v("due"), time: v("time"), project: v("project") };
    if (body.time && !body.due) body.due = TB?.today;
    const r = await taskOp(body);
    if (!r) return;
    host.remove();
    await loadBoard();
    openTask(r.task.id);
  });
}

/* ---------------- events ---------------- */
{
  const root = $("#v-tasks");
  $("#tb-modes").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b) return;
    tMode = b.dataset.mode;
    try { localStorage.setItem("cm-tmode", tMode); } catch { /* not remembered */ }
    renderBoard();
    if (tMode === "calendar" && AG?.month !== tMonth) loadAgenda().catch((err) => toast(err.message, true));
  });
  $("#tb-owner").addEventListener("click", (e) => {
    const b = e.target.closest("[data-owner]");
    if (b) { tOwner = b.dataset.owner; renderBoard(); }
  });
  let qTimer = null;
  $("#tb-q").addEventListener("input", (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { tQuery = e.target.value.trim(); renderBoard(); }, 120); });
  $("#tb-new").addEventListener("click", () => newTask(tFolder && !tFolder.startsWith("~") ? { project: tFolder } : {}));
  root.addEventListener("click", async (e) => {
    const f = e.target.closest("[data-folder]");
    if (f && f.classList.contains("tf")) { tFolder = f.dataset.folder || null; return renderBoard(); }
    if (e.target.closest("#tb-allf")) { tAllFolders = !tAllFolders; return renderFolders(); }
    const of = e.target.closest("[data-open-folder]");
    if (of) {
      const r = await post("/api/open", { target: `~/${of.dataset.openFolder}` }).catch((err) => ({ ok: false, message: err.message }));
      return r.ok || toast(r.message, true);
    }
    const so = e.target.closest("[data-sort]");
    if (so) { tSort = { k: so.dataset.sort, d: tSort.k === so.dataset.sort ? -tSort.d : 1 }; return renderBoard(); }
    const mo = e.target.closest("[data-month]");
    if (mo) {
      const n = Number(mo.dataset.month);
      if (n === 0) tMonth = monthOf(TB.today);
      else {
        const [y, m] = tMonth.split("-").map(Number);
        const d = new Date(y, m - 1 + n, 1);
        tMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      }
      renderBoard();
      return loadAgenda().catch((err) => toast(err.message, true));
    }
    if (e.target.closest("[data-done]")) return; // the checkbox, handled on change
    const card = e.target.closest("[data-task]");
    if (card) return openTask(card.dataset.task);
    const day = e.target.closest(".cal-d");
    if (day && e.target.closest(".cal-n")) return newTask({ due: day.dataset.day, ...(tFolder && !tFolder.startsWith("~") ? { project: tFolder } : {}) });
  });
  root.addEventListener("change", async (e) => {
    const cb = e.target.closest("[data-done]");
    if (!cb) return;
    const r = await taskOp({ op: "update", id: cb.dataset.done, status: cb.checked ? "done" : "todo" });
    if (r) { toast(t("tasks.done", { t: r.task.title })); loadBoard(); } else cb.checked = !cb.checked;
  });
  root.addEventListener("submit", async (e) => {
    const f = e.target.closest(".kadd");
    if (!f) return;
    e.preventDefault();
    const input = f.elements.title;
    const r = await quickAdd(input.value, f.dataset.folder || (tFolder && !tFolder.startsWith("~") ? tFolder : tFolder?.startsWith("~other:") ? tFolder.slice(7) : ""));
    if (r) $(`.kadd[data-folder="${CSS.escape(f.dataset.folder)}"] input`)?.focus();
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
  root.addEventListener("dragend", () => { dragId = null; $$(".tcard.dragging, .kcol.over").forEach((x) => x.classList.remove("dragging", "over")); });
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

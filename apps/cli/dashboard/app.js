// deno-lint-ignore-file no-window no-control-regex -- browser scripts sharing one global scope (app.js, brain.js, tasks.js)
/* claude-multi console — vanilla JS, no dependencies.
   Data from /api/*, live updates over /api/events (SSE), actions through /api/action.
   Text comes from i18n.js (`t`), loaded before this file. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const fmt = (n) =>
  n == null
    ? "—"
    : n >= 1e9
    ? (n / 1e9).toFixed(2) + "G"
    : n >= 1e6
    ? (n / 1e6).toFixed(1) + "M"
    : n >= 1e3
    ? (n / 1e3).toFixed(0) + "k"
    : String(Math.round(n));
const short = (s, n = 60) => {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
/** "3 hours ago", in the interface language. */
const ago = (iso) => {
  if (!iso) return "—";
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(lang(), { numeric: "auto" });
  const a = Math.abs(s);
  if (a < 90) return rtf.format(Math.round(s), "second");
  if (a < 5400) return rtf.format(Math.round(s / 60), "minute");
  if (a < 172800) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
};
/** A compact duration ("40s", "12m", "3h"): the same in every language. */
const dur = (iso) => {
  const s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

/** Model ids are long and repetitive: keep the family and the version. */
const modelShort = (m) => String(m).replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/-(\d)-(\d)$/, "-$1.$2");

let S = null; // last /api/status payload
let OWNER = { id: "me", name: "" }; // whose console this is (/api/owner): their tasks are "mine"
let SUM = null; // last /api/summary payload
let view = "today";
let sub = "overview"; // the System tab

/* ---------------- toast ---------------- */
let toastEl = null, toastTimer = null;
function toast(msg, err = false) {
  toastEl?.remove();
  clearTimeout(toastTimer);
  toastEl = document.createElement("div");
  toastEl.className = "toast" + (err ? " err" : "");
  toastEl.textContent = msg;
  document.body.appendChild(toastEl);
  toastTimer = setTimeout(() => {
    toastEl?.remove();
    toastEl = null;
  }, err ? 6000 : 2800);
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => "")}`.trim());
  return r.json();
}
const post = (path, body) =>
  api(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-multi": "1" },
    body: JSON.stringify(body),
  });

/* ---------------- live connection ---------------- */
let es = null, lastEvent = 0, esRetry = 0, liveState = "busy", bootCode = "";
/** A reload, but not under someone's fingers: while a field has focus, or a drawer with a form is
    open, it waits and asks again. */
function reloadWhenIdle() {
  const busy = document.activeElement?.matches?.("input, textarea, select, [contenteditable]") ||
    document.querySelector(".drawer form, dialog[open]");
  if (busy) return setTimeout(reloadWhenIdle, 5000);
  location.reload();
}
function connect() {
  es?.close();
  es = new EventSource("/api/events");
  es.onopen = () => {
    esRetry = 0;
    lastEvent = Date.now();
    setLive("live");
  };
  es.onerror = () => {
    setLive("down");
    // EventSource retries on its own, but a server that went away for good would leave the page
    // silently stale; a bounded backoff makes the reconnection visible instead.
    if (esRetry < 6) setTimeout(connect, Math.min(30000, 2000 * 2 ** esRetry++));
  };
  // the code serving this page: another one after a restart means this page is old, and it reloads
  es.addEventListener("hello", (e) => {
    let code = "";
    try {
      code = JSON.parse(e.data).code ?? "";
    } catch { /* an old console says nothing */ }
    if (!bootCode) bootCode = code;
    else if (code && code !== bootCode) reloadWhenIdle();
  });
  es.addEventListener("usage", (e) => {
    lastEvent = Date.now();
    // the event names the sessions that just wrote: light those up now, redraw the rest later
    try {
      for (const id of JSON.parse(e.data).sessions ?? []) markWorking(id);
    } catch { /* an event without a body is still a change */ }
    onChange("usage");
  });
  es.addEventListener("tasks", () => {
    lastEvent = Date.now();
    if (view === "today") loadTasks().catch(() => {});
    if (view === "tasks") loadBoard().catch(() => {});
    // the open task follows a chat's changes, unless its description is being written
    if (sheet && !sheet.host.contains(document.activeElement)) {
      api(`/api/tasks/item?id=${encodeURIComponent(sheet.id)}`).then(
        (d) => sheet && d.task.updated !== sheet.data.task.updated && renderSheet(d),
        () => {},
      );
    }
  });
  es.addEventListener("brain", () => {
    lastEvent = Date.now();
    if (view === "brain") loadBrain().catch(() => {});
  });
  es.addEventListener("state", () => {
    lastEvent = Date.now();
    onChange("state");
  });
}
function setLive(state) {
  liveState = state;
  $("#live").className = "live" + (state === "down" ? " down" : state === "busy" ? " busy" : "");
  $("#livetxt").textContent = t(`live.${state}`);
}

// Coalesce: a busy session fires events continuously, and the panel only needs the latest.
let pending = null, changeTimer = null;
function onChange(topic) {
  pending = pending === "state" || topic === "state" ? "state" : "usage";
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    const topic = pending;
    pending = null;
    refresh(topic);
  }, 400);
}

/** Redraw what is on screen, and only that. */
async function refresh(topic = "state") {
  setLive("busy");
  const jobs = [];
  if (topic === "state") jobs.push(loadStatus().then(renderView));
  if (topic === "usage" && view === "today") jobs.push(loadResume());
  if (view === "system" && sub === "plugins" && topic === "state" && !plBusy) jobs.push(loadPlugins());
  await Promise.allSettled(jobs);
  setLive(es && es.readyState === 1 ? "live" : "down");
}

/* ---------------- status ---------------- */
async function loadStatus(fresh = false) {
  const q = fresh ? "?fresh" : "";
  [S, SUM] = await Promise.all([api("/api/status" + q), api("/api/summary" + q)]);
  if (S.language && S.language !== machineLang) {
    machineLang = S.language;
    applyLang();
  }
  renderState();
  return S;
}

/** The line at the foot of the rail, and the System badge: the same verdict the tray shows. */
function renderState() {
  const el = $("#state");
  const level = SUM ? SUM.level : "down";
  el.className = "state-line " + level;
  $("span", el).textContent = t(`state.${level}`);
  const badge = $("#n-health");
  badge.textContent = SUM?.fails.length || "";
  badge.className = "n" + (SUM?.fails.length ? " crit" : "");
}

function renderView() {
  // tasks, the brain and Today's lists have their own data: they do not wait for the status report
  if (view === "today") renderToday();
  if (view === "tasks") loadBoard().catch((e) => toast(e.message, true));
  if (view === "brain") (BRAIN ? Promise.resolve(renderBrainAll()) : loadBrain()).catch((e) => toast(e.message, true));
  if (!S) return;
  if (view === "connections") renderConnections();
  if (view === "system") {
    if (sub === "overview") renderOverview();
    if (sub === "profiles") renderProfiles();
    if (sub === "permissions") loadPermissions().catch((e) => toast(e.message, true));
    if (sub === "plugins") renderShared();
    if (sub === "updates") renderUpdates();
    if (sub === "health") renderHealth(S.doctor);
  }
}

/* ---------------- today ---------------- */
function renderToday() {
  const level = SUM?.level ?? "ok";
  const box = $("#status");
  box.className = "status-card " + level;
  // all good needs no card: the rail says it; the card is for something to act on
  box.hidden = level === "ok" && !SUM?.staged;
  const extra = [
    SUM?.staged ? t("status.staged", { v: SUM.staged }) : null,
    SUM?.warns.length ? t("status.warns", { n: SUM.warns.length }) : null,
  ].filter(Boolean).map((x) => `<div class="sub">${esc(x)}</div>`).join("");
  if (level === "fail") {
    box.innerHTML = `<i></i><div><b>${esc(t("status.fail"))}</b><ul>${
      SUM.fails.map((f) => `<li>${esc(f)}</li>`).join("")
    }</ul>${extra}</div><a class="btn" href="#system/health">${esc(t("status.open"))}</a>`;
  } else {
    box.innerHTML = `<i></i><div><b>${esc(t("status.ok"))}</b><div class="sub">${
      esc(t("status.ok.sub"))
    }</div>${extra}</div>`;
  }
  $("#day-h").textContent = cap(
    new Date().toLocaleDateString(lang(), { weekday: "long", day: "numeric", month: "long" }),
  );
  if (S) renderRunning();
  if (S) renderTodayUpdates();
  loadResume();
  loadTasks().catch(() => {});
  loadDebrief();
}

/** Today's update line: what is pending, in the Updates tab's words; the button is in the pane header. */
function renderTodayUpdates() {
  const m = S.machine, u = S.update ?? {}, r = S.repo ?? {};
  const pending = [
    u.cli?.latest && u.cli.latest !== m.cliVersion ? `Claude Code: ${t("up.next", { v: u.cli.latest })}` : null,
    m.desktopStaged ? `Claude Desktop: ${t("up.staged", { v: m.desktopStaged })}` : null,
    r.isRepo && r.behind ? `claude-multi: ${t("up.self.behind", { n: r.behind })}` : null,
  ].filter(Boolean);
  $("#today-up").textContent = pending.length ? pending.join(" · ") : t("up.uptodate");
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const hhmm = (d = new Date()) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** A profile's colour: its place among the profiles, so no name is ever spelled out here. */
function pcolor(name) {
  const names = Object.keys(S?.profiles ?? {}).sort();
  let i = names.indexOf(name);
  if (i < 0) i = [...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0);
  return `var(--p-${(i % 4) + 1})`;
}
const pf = (name, label = name) => `<span class="pf" style="--c:${pcolor(name)}">${esc(label)}</span>`;

/* ---------------- the day ---------------- */
let TK = null;
async function loadTasks() {
  TK = await api("/api/tasks");
  renderTasks();
}

function renderTasks() {
  if (!TK) return;
  const now = hhmm();
  const shortDay = (d) => new Date(d + "T12:00").toLocaleDateString(lang(), { weekday: "short", day: "numeric" });
  const row = (x, when = x.time ?? "", cls = "") => {
    const ev = x.source === "calendar";
    const p = ev ? null : notesProgress(x.notes);
    const sub = ev
      ? t("day.calendar", { a: x.project ?? "" })
      : [x.project, x.owner && x.owner !== OWNER.id ? x.owner : null].filter(Boolean).join("  ");
    return `<div class="it${ev ? " event" : ""}${x.priority === 1 ? " hi" : ""}${cls ? ` ${cls}` : ""}"${
      ev ? "" : ` data-tk-open="${esc(x.id)}"`
    }>
      <span class="tm">${esc(when)}</span>
      ${
      ev
        ? `<span class="ev"><i></i></span>`
        : `<button class="ck" data-tk-done="${esc(x.id)}" title="${esc(t("ts.done"))}" aria-label="${
          esc(t("ts.done"))
        }"></button>`
    }
      <span class="tt"><span>${esc(x.title)}</span>${sub ? `<small>${esc(sub)}</small>` : ""}</span>
      <span class="rt">${p ? `${bar(p)}` : cls === "late" ? esc(t("day.late")) : ""}</span>
    </div>`;
  };
  const allday = (xs) =>
    xs.length ? `<div class="allday">${xs.map((x) => `<span><i></i>${esc(x.title)}</span>`).join("")}</div>` : "";

  // today: what is late first, then one line of time with a mark for now
  const todayAll = [...(TK.earlier ?? []), ...TK.today];
  const untimedEv = todayAll.filter((x) => x.source === "calendar" && !x.time);
  const timed = todayAll.filter((x) => x.time).sort((a, b) => a.time.localeCompare(b.time));
  const loose = todayAll.filter((x) => x.source !== "calendar" && !x.time);
  let html = allday(untimedEv);
  html += TK.overdue.map((x) => row(x, shortDay(x.due), "late")).join("") +
    TK.missed.map((x) => row(x, x.time, "late")).join("");
  let marked = false;
  for (const x of timed) {
    if (!marked && x.time > now) {
      html += `<div class="now"><span>${now}</span></div>`;
      marked = true;
    }
    html += row(x, x.time, x.time < now ? "past" : "");
  }
  if (!marked) html += `<div class="now"><span>${now}</span></div>`;
  html += loose.map((x) => row(x, "")).join("");
  if (!timed.length && !loose.length && !TK.overdue.length && !TK.missed.length && !untimedEv.length) {
    html += `<div class="pane-empty">${esc(t("day.free"))}</div>`;
  }

  const later = (key, xs, when) =>
    xs.length
      ? `<div class="dhead">${esc(t(key))}</div>` + allday(xs.filter((x) => x.source === "calendar" && !x.time)) +
        xs.filter((x) => x.source !== "calendar" || x.time).map((x) => row(x, when(x))).join("")
      : "";
  html += later("day.tomorrow", TK.tomorrow, (x) => x.time ?? "");
  if (TK.moment !== "evening") html += later("day.next", TK.upcoming, (x) => shortDay(x.due));
  html += later("day.waiting", TK.waiting, (x) => x.due ? shortDay(x.due) : "");
  $("#day").innerHTML = html;
}

$("#day").addEventListener("click", async (e) => {
  const done = e.target.closest("[data-tk-done]");
  if (done) {
    e.stopPropagation();
    done.disabled = true;
    const r = await post("/api/tasks", { op: "update", id: done.dataset.tkDone, status: "done" }).catch((err) => ({
      ok: false,
      message: err.message,
    }));
    if (!r.ok) {
      done.disabled = false;
      return toast(r.message, true);
    }
    toast(t("tasks.done", { t: r.task.title }));
    return loadTasks();
  }
  const o = e.target.closest("[data-tk-open]");
  if (o) openTask(o.dataset.tkOpen);
});
// the line for now moves with the clock
setInterval(() => {
  if (view === "today" && TK) renderTasks();
}, 60000);

/* ---------------- the morning debrief ---------------- */
// Written by Claude once a day, at the first look at Today after five in the morning; kept by the server.
let debriefAsked = false;
async function loadDebrief(again = false) {
  const el = $("#debrief");
  if (!again) {
    const r = await api("/api/debrief").catch(() => null);
    if (r?.debrief) return showDebrief(r.debrief.text);
    if (debriefAsked || new Date().getHours() < 5) return;
  }
  debriefAsked = true;
  el.hidden = false;
  el.innerHTML = `<div class="debrief-f">${sparkHtml(true)}<span>${esc(t("debrief.writing"))}</span></div>`;
  let text = "";
  await askStream("/api/debrief", {}, {
    text: (d) => {
      text += d;
      showDebrief(text, true);
    },
    done: (o) => o.error ? (el.hidden = true) : showDebrief(o.text),
  }).catch(() => {
    el.hidden = true;
  });
}
function showDebrief(text, writing = false) {
  const el = $("#debrief");
  el.hidden = !text.trim();
  el.innerHTML = text.trim().split(/\n+/).map((l) => `<p>${esc(l)}</p>`).join("") +
    (writing
      ? ""
      : `<div class="debrief-f"><span>${esc(t("debrief.by"))}</span><button data-debrief-again>${
        esc(t("debrief.again"))
      }</button></div>`);
}
$("#debrief").addEventListener("click", (e) => {
  if (e.target.closest("[data-debrief-again]")) loadDebrief(true);
});

/* ---------------- sessions ---------------- */
/** Sessions seen writing recently. A row stays "working" for a few seconds after its last write,
 *  because a session pauses between turns and flickering would be worse than a short lag. */
const working = new Map();
const WORKING_MS = 12000;

function markWorking(id) {
  const was = working.has(id);
  working.set(id, Date.now());
  if (!was && S && view === "today") renderRunning();
  clearTimeout(markWorking[id]);
  markWorking[id] = setTimeout(() => {
    working.delete(id);
    if (S && view === "today") renderRunning();
  }, WORKING_MS);
}

const isWorking = (id, lastActivity) => {
  if (id && working.has(id)) return true;
  // on first paint there has been no event yet: fall back to how fresh the transcript is
  return !!lastActivity && Date.now() - new Date(lastActivity).getTime() < WORKING_MS;
};

function renderRunning() {
  const cli = S.running.cli, desk = S.running.desktop;
  const active = cli.filter((c) => isWorking(c.session, c.lastActivity)).length;
  $("#run-n").textContent = active ? t("run.busyN", { n: active }) : "";
  const el = $("#running");
  if (!cli.length && !desk.length) {
    el.innerHTML = `<div class="pane-empty">${esc(t("today.nothing"))}</div>`;
    return;
  }
  // busy first, then the most recent
  const rows = cli.map((c) => ({ c, busy: isWorking(c.session, c.lastActivity) }))
    .sort((a, b) =>
      Number(b.busy) - Number(a.busy) || String(b.c.lastActivity ?? "").localeCompare(String(a.c.lastActivity ?? ""))
    );
  el.innerHTML = rows.map(({ c, busy }) =>
    `<button class="ses" data-focus="${c.pid}" title="${esc(c.cwd ?? "")}">
      <span class="mark">${busy ? sparkHtml(true) : `<i class="idle"></i>`}</span>
      <span class="nm">${esc(c.cwd ? c.cwd.split("/").filter(Boolean).pop() : "—")}</span>
      <span class="when${busy ? " on" : ""}">${
      esc(busy ? t("run.working") : c.lastActivity ? t("run.idle", { d: dur(c.lastActivity) }) : "")
    }</span>
      <span class="sub">${pf(c.profile ?? "?")}<span>${esc(t(c.embedded ? "run.desktop" : "run.terminal"))}</span>${
      c.model ? `<span>${esc(modelShort(c.model))}</span>` : ""
    }</span>
    </button>`
  ).join("") + desk.map((d) =>
    `<button class="ses" data-focus="${d.pid}">
      <span class="mark"><i class="idle"></i></span>
      <span class="nm">${esc(t("run.desktopApp"))}</span>
      <span class="when"></span>
      <span class="sub">${pf(d.variant)}<span>${
      esc(t("run.window", { n: cli.filter((c) => c.embedded && c.profile === d.variant).length }))
    }</span></span>
    </button>`
  ).join("");
}

$("#running").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-focus]");
  if (!b) return;
  const r = await post("/api/focus", { pid: Number(b.dataset.focus) }).catch((err) => ({
    ok: false,
    message: err.message,
  }));
  if (!r.ok) toast(r.message ?? t("run.noFocus"), true);
});

/** The last sessions, one per directory; a click reopens one in a terminal. A busy session
    writes every second: the list is re-read at most every 15 s. */
let RESUME = [], resumeAt = 0;
async function loadResume(force = false) {
  if (!force && Date.now() - resumeAt < 15000) return renderResume();
  resumeAt = Date.now();
  try {
    const rows = await api("/api/sessions?" + new URLSearchParams({ since: "7d", limit: "60" }));
    const seen = new Set();
    RESUME = rows.filter((r) => r.cwd && !seen.has(r.cwd) && seen.add(r.cwd)).slice(0, 12);
  } catch { /* the panel stays as it was */ }
  renderResume();
}

function renderResume() {
  const el = $("#resume");
  if (!RESUME.length) {
    el.innerHTML = `<div class="pane-empty">${esc(t("today.noResume"))}</div>`;
    return;
  }
  el.innerHTML = RESUME.map((r, i) =>
    `<button class="ses" data-resume="${i}" title="${esc(r.cwd)}">
      <span class="mark"></span>
      <span class="nm">${esc(r.project)}</span>
      <span class="when">${esc(ago(r.ended))}</span>
      <span class="sub">${pf(r.profile)}</span>
    </button>`
  ).join("");
}

$("#resume").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-resume]");
  if (!b) return;
  const r = RESUME[+b.dataset.resume];
  const res = await post("/api/terminal", { cwd: r.cwd, profile: r.profile, resume: r.session_id }).catch((err) => ({
    ok: false,
    message: err.message,
  }));
  if (!res.ok) toast(res.message, true);
});

/* ---------------- asking Claude ---------------- */
// One field at the bottom of Today, Tasks and the Brain. The answer streams in above it; a
// follow-up continues the same conversation until the answer is closed.
/* ---------------- Claude's spark and icons ---------------- */
// Claude Desktop's own, when it is installed (apps/cli/claude-assets.ts): the spark, the frames it
// moves through while Claude works, and the icon font. Without it a plain star stands still.
let CLAUDE = { spark: null, strips: {}, icons: {}, iconFont: false };
const SPARK_STILL =
  `<svg viewBox="0 0 24 24"><path d="M12 2.5l1.6 6.2 5.6-3.2-3.2 5.6 6.2 1.6-6.2 1.6 3.2 5.6-5.6-3.2L12 22.9l-1.6-6.2-5.6 3.2 3.2-5.6L1.8 12.7 8 11.1 4.8 5.5l5.6 3.2z"/></svg>`;
const sparkStill = () => CLAUDE.spark ?? SPARK_STILL;

/** A spark: still, or moving through one of Claude's animations ("thinking", "writing"…). */
const sparkHtml = (busy = false) => `<span class="spark" data-spark="${busy ? "thinking" : ""}"></span>`;
function setSpark(el, mode) {
  el.getAnimations?.().forEach((a) => a.cancel());
  const strip = mode && CLAUDE.strips[mode];
  el.dataset.spark = mode || "";
  el.dataset.drawn = mode || "still";
  if (!strip || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.innerHTML = sparkStill();
    return;
  }
  // as Desktop does it: a strip of frames stacked top to bottom, stepped through by a transform
  const n = strip.frameCount;
  el.innerHTML = `<span class="strip" style="height:${n * 100}%">${strip.svg}</span>`;
  el.firstElementChild.animate(Array.from({ length: n }, (_, i) => ({ transform: `translateY(-${(100 / n) * i}%)` })), {
    duration: strip.speed * n,
    iterations: Infinity,
    easing: `steps(${n}, jump-none)`,
  });
}
// every spark drawn anywhere on the page gets its content, without each renderer having to ask
new MutationObserver(() => {
  for (const el of document.querySelectorAll(".spark")) {
    if (el.dataset.drawn !== (el.dataset.spark || "still")) setSpark(el, el.dataset.spark);
  }
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-spark"] });

/** An Anthropicons glyph by name, or "" when the font is not here (the caller keeps its own). */
const aicon = (name) =>
  CLAUDE.iconFont && CLAUDE.icons[name] ? `<i class="ai" aria-hidden="true">&#${CLAUDE.icons[name]};</i>` : "";
const NAV_ICONS = { today: "Sun", tasks: "Tasks", brain: "Memory", connections: "Connectors", system: "Settings" };

async function loadClaude() {
  try {
    const a = await api("/claude/assets.json");
    if (!a.found) return;
    CLAUDE = {
      spark: a.spark?.replace(/fill="#[0-9a-fA-F]{3,8}"/g, 'fill="currentColor"') ?? null,
      strips: a.strips,
      icons: a.icons,
      iconFont: a.iconFont,
    };
  } catch {
    return;
  }
  for (const el of document.querySelectorAll(".spark")) setSpark(el, el.dataset.spark);
  for (const a of $$("#nav a")) {
    const g = aicon(NAV_ICONS[a.dataset.v]);
    if (g) a.querySelector("svg")?.replaceWith(document.createRange().createContextualFragment(g));
  }
}

/** POST and read the NDJSON answer line by line. */
async function askStream(path, body, on, signal) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-multi": "1" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += value;
    const lines = rest.split("\n");
    rest = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      const o = JSON.parse(l);
      on[o.t]?.(o.t === "text" ? o.d : o);
    }
  }
}

const ASK = { kind: "ask", project: null, session: null, busy: null, last: "", code: null, tools: false };

function askContext(kind, project = null) {
  ASK.kind = kind;
  ASK.project = project;
  const ctx = $("#ask-ctx");
  ctx.hidden = kind === "ask";
  // a new task: in the project on screen, in none, or (null) wherever Claude finds it belongs;
  // a change to the brain: on the page on screen, or (null) on the brain as a whole
  $("span", ctx).textContent = kind === "brain"
    ? (project ? t("ask.ctx.brain", { p: BRAIN?.byPath.get(project)?.title ?? project }) : t("ask.ctx.brainAll"))
    : kind !== "newtask"
    ? ""
    : project === null
    ? t("tb.new")
    : t("ask.ctx.newtask", { p: project === "~none" ? t("tb.noProject") : project.split("/").pop() });
  $("#ask-text").placeholder = t(kind === "newtask" ? "ask.ph.newtask" : kind === "brain" ? "ask.ph.brain" : "ask.ph");
}
$("#ask-ctx button").addEventListener("click", () => {
  askContext("ask");
  $("#ask-text").focus();
});

function closeAnswer() {
  ASK.busy?.abort();
  ASK.busy = null;
  ASK.session = null;
  $("#answer").hidden = true;
  $("#ask-spark").dataset.spark = "";
}
$("#answer-x").addEventListener("click", closeAnswer);

const toolLabel = (k) => t(`ask.tool.${k}`);

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ta = $("#ask-text");
  const text = ta.value.trim();
  if (!text || ASK.busy) return;
  ta.value = "";
  autosize();
  ASK.last = text;
  ASK.code = null;
  ASK.tools = false;
  const ans = $("#answer"), body = $("#answer-b"), status = $("#answer-s");
  ans.hidden = false;
  $("#answer-q").textContent = text;
  body.innerHTML = "";
  $("#answer-term").hidden = $("#answer-code").hidden = true;
  status.innerHTML = `${sparkHtml(true)}<span class="ask-state">${esc(t("ask.thinking"))}</span>`;
  $("#ask-spark").dataset.spark = "thinking";
  let acc = "", frame = 0;
  const paint = () => {
    frame = 0;
    body.innerHTML = mdToHtml(acc.replace(/\[\[code:[^\]]*\]\]/g, ""));
    body.scrollTop = body.scrollHeight;
  };
  ASK.busy = new AbortController();
  const kind = ASK.kind;
  try {
    const where = ASK.project === "~none" ? { noProject: true } : { project: ASK.project };
    await askStream("/api/ask", { text, kind, ...where, session: ASK.session }, {
      session: (o) => {
        ASK.session = o.id;
      },
      text: (d) => {
        acc += d;
        if (!frame) frame = requestAnimationFrame(paint);
        const sp = $(".spark", status);
        if (sp && sp.dataset.spark !== "writing") sp.dataset.spark = "writing";
      },
      tool: (o) => {
        ASK.tools = true;
        // by class: "span:last-child" also matches the strip inside the spark, which then shows the label
        $(".ask-state", status).textContent = toolLabel(o.k);
        const sp = $(".spark", status);
        if (sp) sp.dataset.spark = "thinking";
      },
      done: (o) => {
        if (o.error) body.innerHTML = `<p class="err">${esc(t("ask.failed", { e: o.error }))}</p>`;
        else {
          acc = o.text;
          paint();
        }
        ASK.code = o.code;
      },
    }, ASK.busy.signal);
  } catch (err) {
    if (err.name !== "AbortError") body.innerHTML = `<p class="err">${esc(t("ask.failed", { e: err.message }))}</p>`;
  }
  ASK.busy = null;
  $("#ask-spark").dataset.spark = "";
  status.innerHTML = `<span>${esc(t("ask.followup"))}</span>`;
  $("#answer-term").hidden = !ASK.session;
  if (ASK.code) {
    const name = ASK.code.replace(/\/+$/, "").split("/").pop() || "~";
    $("#answer-code").textContent = t("ask.code", { p: name });
    $("#answer-code").hidden = false;
  }
  // a new task is one thing: the next request is a plain one again
  if (kind === "newtask") askContext("ask");
  if (ASK.tools) {
    loadTasks().catch(() => {});
    if (view === "tasks") loadBoard().catch(() => {});
  }
  // what Claude changed in the brain shows at once, not at the next half-minute check
  if (kind === "brain" && ASK.tools && view === "brain") loadBrain().catch(() => {});
  ta.focus();
});

$("#answer-term").addEventListener("click", async () => {
  const r = await post("/api/terminal", { resume: ASK.session }).catch((err) => ({ ok: false, message: err.message }));
  if (!r.ok) toast(r.message, true);
});
$("#answer-code").addEventListener("click", async () => {
  const r = await post("/api/terminal", { cwd: ASK.code, ask: ASK.last }).catch((err) => ({
    ok: false,
    message: err.message,
  }));
  if (!r.ok) toast(r.message, true);
});

// the model the requests go to: one choice, shared with the Hey window (kept by the server)
async function loadAskModel() {
  const sel = $("#ask-model");
  try {
    const r = await api("/api/ask/model");
    sel.innerHTML = r.models.map((m) => `<option value="${esc(m)}">${esc(t(`ask.model.${m}`))}</option>`).join("");
    sel.value = r.model;
    sel.hidden = false;
  } catch {
    sel.hidden = true;
  }
}
$("#ask-model").addEventListener("change", async (e) => {
  const r = await post("/api/ask/model", { model: e.target.value }).catch((err) => ({
    ok: false,
    message: err.message,
  }));
  if (!r.ok) {
    toast(r.message, true);
    loadAskModel();
  }
  $("#ask-text").focus();
});
loadAskModel();

function autosize() {
  const ta = $("#ask-text");
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
}
$("#ask-text").addEventListener("input", autosize);
$("#ask-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
  if (e.key === "Escape") {
    if (!$("#answer").hidden) closeAnswer();
    else e.target.blur();
  }
});
// "/" anywhere outside a field puts the cursor in the field, as in most chat apps
addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest?.("input, textarea, select, [contenteditable]") || $("#ask-dock").hidden) return;
  e.preventDefault();
  $("#ask-text").focus();
});

/* ---------------- markdown ---------------- */
/** Markdown to HTML for the readers (brain pages, task descriptions): escaped first, then the forms
    the wiki uses. Wikilinks become [data-page] links the brain opens; web links open outside. Enough
    to read a page well, not a renderer. */
function mdToHtml(src) {
  // Every piece of markup is made from escaped text and parked as a token (\u0000n\u0000) before
  // the next rule runs, so no rule can reach into markup another one produced.
  const inline = (s) => {
    const toks = [];
    const park = (html) => `\u0000${toks.push(html) - 1}\u0000`;
    let x = esc(String(s).replace(/\u0000/g, ""));
    x = x.replace(/`([^`]+)`/g, (_, c) => park(`<code>${c}</code>`));
    x = x.replace(
      /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g,
      (_, target, label) => park(`<a data-page="${target.trim()}">${label ?? target.trim().split("/").pop()}</a>`),
    );
    x = x.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (_, label, url) => park(`<a href="${url}" target="_blank" rel="noopener">${label}</a>`),
    );
    x = x.replace(
      /\[([^\]]+)\]\((?:&lt;(.+?)&gt;|([^)\s]+))\)/g,
      (_, label, a, b) => park(`<span class="lnk" title="${a ?? b}">${label}</span>`),
    );
    x = x
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1<i>$2</i>")
      .replace(/~~([^~]+)~~/g, "<s>$1</s>");
    return x.replace(/\u0000(\d+)\u0000/g, (_, i) => toks[Number(i)]);
  };
  const out = [];
  let list = null, code = null, table = null;
  const flush = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
    if (table) {
      out.push(`<table>${table.join("")}</table>`);
      table = null;
    }
  };
  for (const line of src.split("\n")) {
    if (code !== null) {
      if (line.startsWith("```")) {
        out.push(`<pre>${esc(code.join("\n"))}</pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (line.startsWith("```")) {
      flush();
      code = [];
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)/);
    if (h) {
      flush();
      const n = Math.min(h[1].length, 4);
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      continue;
    }
    const li = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)/);
    if (li) {
      const kind = li[2] ? "ol" : "ul";
      if (list !== kind) {
        flush();
        out.push(`<${kind}>`);
        list = kind;
      }
      const box = li[3].match(/^\[([ xX])\]\s+(.*)/);
      // a nested item keeps its depth (two spaces a level), without building nested lists
      const depth = Math.min(Math.floor(line.match(/^\s*/)[0].replace(/\t/g, "  ").length / 2), 4);
      const lvl = depth ? ` style="--lv:${depth}"` : "";
      out.push(
        box
          ? `<li class="task${box[1] !== " " ? " done" : ""}"${lvl}><span class="cb">${
            box[1] !== " " ? "✓" : ""
          }</span>${inline(box[2])}</li>`
          : `<li${lvl}>${inline(li[3])}</li>`,
      );
      continue;
    }
    if (/^\|.*\|\s*$/.test(line)) {
      if (/^\|[\s:|-]+\|\s*$/.test(line)) continue;
      if (!table) {
        flush();
        table = [];
      }
      table.push(`<tr>${line.trim().slice(1, -1).split("|").map((c) => `<td>${inline(c.trim())}</td>`).join("")}</tr>`);
      continue;
    }
    flush();
    if (line.startsWith(">")) out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  if (code) out.push(`<pre>${esc(code.join("\n"))}</pre>`);
  return out.join("");
}

/* ---------------- connections ---------------- */
let ACC = null, seenConnect;
async function loadAccounts() {
  ACC = await api("/api/accounts");
  renderAccounts();
}

function renderAccounts() {
  if (!ACC) return;
  const v = ACC.vault, box = $("#vault");
  // the vault only speaks up when something is to be done on this machine
  const msg = v.state === "wrong-key"
    ? ["fail", t("vault.wrongKey")]
    : v.state === "no-key"
    ? ["update", t(v.initialised ? "vault.pair" : "vault.init")]
    : v.conflicts
    ? ["update", t("vault.conflicts", { n: v.conflicts })]
    : null;
  box.hidden = !msg;
  if (msg) {
    box.className = "status-card " + msg[0];
    box.innerHTML = `<i></i><div><b>${esc(t("vault.title"))}</b><div class="sub">${
      esc(msg[1])
    }</div><div class="sub"><code>${esc(v.dir)}</code></div></div>`;
  }
  // Google: the OAuth client is imported once, before any account can connect
  const g = $("#gclient");
  const wantsGoogle = ACC.services.includes("google") && v.state === "ok";
  g.hidden = !wantsGoogle || ACC.google.client;
  if (!g.hidden) {
    g.className = "status-card update";
    g.innerHTML = `<i></i><div><b>${esc(t("google.client"))}</b><div class="sub">${
      esc(t("google.client.how"))
    }</div></div>
      <label class="btn">${
      esc(t("google.client.import"))
    }<input type="file" accept=".json,application/json" id="gclient-file" hidden></label>`;
  }
  const last = ACC.google.last;
  if (last && last.at !== seenConnect) {
    if (seenConnect !== undefined) toast(last.message, !last.ok);
    seenConnect = last.at;
  }
  renderConnList();
}

/* One block per service, its accounts inside, each with one state in plain words and one action;
   brain and tasks — claude-multi's own — apart at the bottom. */
const SVC_NAMES = {
  n8n: "n8n",
  google: "Google",
  cloudflare: "Cloudflare",
  supabase: "Supabase",
  lovable: "Lovable",
  railway: "Railway",
  zapier: "Zapier",
  gitea: "Gitea · Forgejo",
  coolify: "Coolify",
  "syncthing-status": "Syncthing",
  brain: "Brain",
};
let connFilter = "";
try {
  connFilter = localStorage.getItem("conn.filter") ?? "";
} catch { /* storage off */ }

function logo(service) {
  const d = LOGOS[service];
  return d
    ? `<span class="svc-logo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg></span>`
    : `<span class="svc-logo">${esc((SVC_NAMES[service] ?? service).slice(0, 1).toUpperCase())}</span>`;
}
const profileChips = (ps) =>
  ps
    ? ps.map((p) => `<span class="chip on">${esc(p)}</span>`).join(" ")
    : `<span class="sub">${esc(t("acc.allProfiles"))}</span>`;

/** The one state of an account, most urgent first: [class, text, sub-line or ""]. */
function accState(a) {
  const r = a.reach;
  const desk = r.noDesktop.length ? t("conn.noDesktop", { p: r.noDesktop.join(", ") }) : "";
  if (a.missing?.length) {
    const m = a.missing[0];
    return ["warn-t", t("acc.missingProgram", { s: m.server }), m.install ? `<code>${esc(m.install)}</code>` : ""];
  }
  if (a.service === "google" && !a.hasSecret) return ["warn-t", t("google.notConnected"), ""];
  if (a.service === "brain" && !a.hasSecret) return ["warn-t", t("conn.brainOff"), ""];
  if (a.auth !== "oauth" && a.service !== "google" && a.service !== "brain" && !a.hasSecret) {
    return ["warn-t", t("acc.noSecret"), ""];
  }
  if (r.pending.length) return ["warn-t", t("conn.pending", { p: r.pending.join(", ") }), desk];
  if (!r.profiles.length) return ["sub", t("conn.unused"), ""];
  if (a.auth === "oauth") return ["sub", t("acc.oauth"), desk];
  if (a.service === "brain") return ["ok-t", t("conn.brainOn"), desk];
  if (a.service === "google") return ["ok-t", t("google.connected"), desk];
  return ["ok-t", t("conn.ready"), desk];
}

function accRow(a) {
  const i = ACC.accounts.indexOf(a);
  const [cls, text, sub] = accState(a);
  const who = a.service === "google" && a.email
    ? a.email
    : a.url
    ? a.url.replace(/^https?:\/\//, "").replace(/\/$/, "")
    : "";
  const act = a.service === "google" && ACC.google.client
    ? `<button class="btn sm" data-g-connect="${esc(a.name)}">${
      esc(t(a.hasSecret ? "google.reconnect" : "google.connect"))
    }</button>`
    : a.service === "brain" && a.url && ACC.vault.state === "ok"
    ? `<button class="btn sm" data-b-login="${esc(a.name)}">${esc(t("brain.login"))}</button>`
    : "";
  return `<div class="acc-row">
    <div class="acc-who"${a.note ? ` title="${esc(a.note)}"` : ""}><b>${esc(a.name)}</b>${
    who ? `<small>${esc(who)}</small>` : ""
  }</div>
    <div class="chips">${profileChips(a.profiles)}</div>
    <div class="acc-state"><span class="${cls}">${esc(text)}</span>${
    sub ? `<small>${sub.startsWith("<code>") ? sub : esc(sub)}</small>` : ""
  }</div>
    <div class="acts">${act}<button class="btn ghost sm" data-acc-edit="${i}">${esc(t("profile.edit"))}</button></div>
  </div>`;
}

/** A server that needs no account: on for some profiles, nothing to sign in to. */
function serverRow(sv) {
  const desk = sv.noDesktop.length ? t("conn.noDesktop", { p: sv.noDesktop.join(", ") }) : "";
  const [cls, text] = sv.pending.length
    ? ["warn-t", t("conn.pending", { p: sv.pending.join(", ") })]
    : ["ok-t", t("conn.ready")];
  return `<div class="acc-row">
    <div class="acc-who"><span class="sub">${esc(t("conn.noAccount"))}</span></div>
    <div class="chips">${profileChips(sv.profiles)}</div>
    <div class="acc-state"><span class="${cls}">${esc(text)}</span>${desk ? `<small>${esc(desk)}</small>` : ""}</div>
    <div class="acts"></div>
  </div>`;
}

function svcBlock(service, rows) {
  const desc = t(`svc.${service}`);
  return `<div class="svc">
    <div class="svc-h">${logo(service)}<b>${esc(SVC_NAMES[service] ?? service)}</b>${
    desc !== `svc.${service}` ? `<span class="sub">${esc(desc)}</span>` : ""
  }</div>
    ${rows}
  </div>`;
}

function renderConnList() {
  const sees = (ps) => !connFilter || !ps || ps.includes(connFilter);
  const accs = ACC.accounts.filter((a) => sees(a.profiles));
  const servers = (ACC.servers ?? []).filter((sv) => sees(sv.profiles));
  $("#conn-filter").innerHTML = ["", ...ACC.profiles].map((p) =>
    `<button class="chip pick${p === connFilter ? " on" : ""}" data-conn-filter="${esc(p)}">${
      esc(p || t("conn.all"))
    }</button>`
  ).join("");
  $("#acc-sum").textContent = t("acc.sum", { n: accs.length });

  // what a sync would still change: one notice for the whole page, not a word in every row
  const pending = [...ACC.accounts, ...(ACC.servers ?? [])].filter((x) => (x.reach ?? x).pending.length).length;
  const pc = $("#conn-pending");
  pc.hidden = !pending;
  if (pending) {
    pc.innerHTML = `<i></i><div><b>${esc(t("conn.apply.title", { n: pending }))}</b><div class="sub">${
      esc(t("conn.apply.how"))
    }</div></div>
      <button class="btn" data-action="mcp-sync">${esc(t("conn.apply"))}</button>`;
  }

  const bySvc = new Map();
  for (const a of accs) if (a.service !== "brain") bySvc.set(a.service, [...bySvc.get(a.service) ?? [], a]);
  const blocks = [
    ...[...bySvc].map(([svc, list]) => [SVC_NAMES[svc] ?? svc, svcBlock(svc, list.map(accRow).join(""))]),
    ...servers.map((sv) => [SVC_NAMES[sv.name] ?? sv.name, svcBlock(sv.name, serverRow(sv))]),
  ].sort((x, y) => x[0].localeCompare(y[0]));
  $("#conn-services").innerHTML = blocks.map((b) => b[1]).join("") || `<p class="sub">${esc(t("acc.none"))}</p>`;

  const brain = accs.filter((a) => a.service === "brain");
  $("#conn-ours").innerHTML = brain.length
    ? `<div class="svc">
        <div class="svc-h">${logo("brain")}<b>${esc(t("conn.brain"))}</b><span class="sub">${
      esc(t("svc.brain"))
    }</span></div>
        ${brain.map(accRow).join("")}
      </div>`
    : `<p class="sub">${esc(t("conn.noBrain"))}</p>`;
}
document.addEventListener("click", (e) => {
  const f = e.target.closest("[data-conn-filter]");
  if (!f) return;
  connFilter = f.dataset.connFilter;
  try {
    localStorage.setItem("conn.filter", connFilter);
  } catch { /* storage off */ }
  if (ACC) renderConnList();
});

/** The account form, in the drawer: `i` null for a new one. The secret field is never filled in:
    the page never receives a secret, it only sends one. */
function openAccountForm(i) {
  const a = i == null ? null : ACC.accounts[i];
  const field = (label, input, hint = "") =>
    `<label class="fld">${esc(label)}${hint ? ` <small>${esc(hint)}</small>` : ""}${input}</label>`;
  const host = drawer(
    a ? `${a.service}/${a.name}` : t("acc.new"),
    `<form class="pform" id="aform">
      ${
      field(
        t("acc.service"),
        a
          ? `<input name="service" value="${esc(a.service)}" readonly>`
          : `<select name="service" class="sel" style="font-size:14px;padding:8px">${
            ACC.services.map((sv) => `<option>${esc(sv)}</option>`).join("")
          }</select>`,
      )
    }
      ${
      field(
        t("acc.name"),
        `<input name="name" required pattern="[a-z][a-z0-9_-]{0,30}" value="${esc(a?.name ?? "")}" ${
          a ? "readonly" : ""
        } placeholder="alice">`,
        t("acc.name.hint"),
      )
    }
      ${field(t("acc.url"), `<input name="url" value="${esc(a?.url ?? "")}" placeholder="https://…">`)}
      <div class="fld">${esc(t("conn.profiles"))} <small>${esc(t("acc.profiles.hint"))}</small><div class="chips">${
      ACC.profiles.map((p) =>
        `<button type="button" class="chip pick${a?.profiles?.includes(p) ? " on" : ""}" data-pick="${
          esc(p)
        }" aria-pressed="${!!a?.profiles?.includes(p)}">${esc(p)}</button>`
      ).join("")
    }</div></div>
      <div class="acc-secret">${
      field(
        t("acc.secret"),
        `<input name="secret" type="password" autocomplete="off" placeholder="${
          esc(t(a ? "acc.secret.keep" : "acc.secret.ph"))
        }">`,
        t("acc.secret.hint"),
      )
    }</div>
      <p class="sub acc-google" hidden>${esc(t("google.form.hint"))}</p>
      <div class="pform-foot">
        <button class="btn primary" type="submit">${esc(t("profile.save"))}</button>
        ${a ? `<button class="btn ghost danger" type="button" data-acc-del>${esc(t("pl.remove"))}</button>` : ""}
        <button class="btn ghost" type="button" data-close>${esc(t("profile.cancel"))}</button>
      </div>
    </form>`,
  );
  const f = $("#aform", host);
  // a Google account has no secret to paste: it is connected through its consent page
  const syncKind = () => {
    const isGoogle = f.elements.service.value === "google";
    $(".acc-secret", f).hidden = isGoogle;
    $(".acc-google", f).hidden = !isGoogle;
    f.elements.secret.required = !isGoogle && !a;
  };
  f.elements.service.addEventListener?.("change", syncKind);
  syncKind();
  const send = async (op) => {
    const body = {
      op,
      service: f.elements.service.value,
      name: f.elements.name.value.trim(),
      url: f.elements.url.value.trim(),
      profiles: $$("[data-pick].on", f).map((c) => c.dataset.pick),
      secret: f.elements.secret.value,
    };
    f.elements.secret.value = "";
    const r = await post("/api/accounts", body).catch((e) => ({ ok: false, message: e.message }));
    toast(r.message, !r.ok || !!r.missing?.length);
    if (r.ok) {
      host.remove();
      await loadAccounts();
    }
  };
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    send("save");
  });
  $("[data-acc-del]", host)?.addEventListener("click", () => {
    if (confirm(t("acc.confirmDelete", { a: `${a.service}/${a.name}` }))) send("delete");
  });
}

$("#acc-add").addEventListener("click", () => ACC && openAccountForm(null));
document.addEventListener("click", async (e) => {
  const c = e.target.closest("[data-g-connect]");
  if (!c) return;
  const r = await post("/api/google/connect", { account: c.dataset.gConnect }).catch((err) => ({
    ok: false,
    message: err.message,
  }));
  if (!r.ok) return toast(r.message, true);
  window.open(r.url, "_blank", "noopener");
  toast(t("google.finish"));
});
document.addEventListener("click", async (e) => {
  const c = e.target.closest("[data-b-login]");
  if (!c) return;
  const r = await post("/api/brain/login", { account: c.dataset.bLogin }).catch((err) => ({
    ok: false,
    message: err.message,
  }));
  if (!r.ok) return toast(r.message, true);
  window.open(r.url, "_blank", "noopener");
  toast(t("brain.finish"));
});
document.addEventListener("change", async (e) => {
  if (e.target.id !== "gclient-file" || !e.target.files[0]) return;
  const r = await api("/api/google/client", {
    method: "POST",
    headers: { "x-claude-multi": "1" },
    body: await e.target.files[0].text(),
  })
    .catch((err) => ({ ok: false, message: err.message }));
  toast(r.message, !r.ok);
  if (r.ok) loadAccounts();
});
document.addEventListener("click", (e) => {
  const ed = e.target.closest("[data-acc-edit]");
  if (ed) openAccountForm(+ed.dataset.accEdit);
});

function renderConnections() {
  loadAccounts().catch((e) => toast(e.message, true));
}

/* ---------------- profiles ---------------- */
function renderProfiles() {
  if (!S) return;
  const names = Object.keys(S.profiles);
  const live = new Set(S.running.cli.map((c) => c.profile));
  $("#p-count").textContent = t("profile.count", { n: names.length });
  $("#plist").innerHTML = names.map((n) => {
    const p = S.profiles[n];
    const isLive = live.has(n);
    return `<div class="plist-row">
      <div class="pwho">
        <span class="dot${isLive ? " active" : ""}" title="${esc(t(isLive ? "profile.live" : "profile.idle"))}"></span>
        <div style="min-width:0"><b>${esc(n)}</b><small>${esc(p.account ?? t("profile.notSignedIn"))}</small></div>
      </div>
      <div class="pcell"><code>${esc(p.manifest.command ?? `claude-${n}`)}</code>${
      p.manifest.alias ? ` <span class="chip">${esc(p.manifest.alias)}</span>` : ""
    }<small title="${esc(p.desktopDir)}">${esc(shortHome(p.desktopDir))}</small></div>
      <div class="pcell">${
      esc(t("profile.mountedVal", {
        s: Object.keys(p.mounted.skills).length,
        a: Object.keys(p.mounted.agents).length,
        c: Object.keys(p.mounted.commands).length,
      }))
    }<small>${esc(t(p.manifest.disableAccountMcp ? "profile.accountMcpOff" : "profile.accountMcpOn"))}</small></div>
      <div class="pcell chips">${
      p.mcp.length
        ? p.mcp.map((m) => `<span class="chip on">${esc(m)}</span>`).join("")
        : `<small>${esc(t("profile.noMcp"))}</small>`
    }</div>
      <button class="btn" data-edit="${esc(n)}">${esc(t("profile.edit"))}</button>
    </div>`;
  }).join("");
}

/** The profile form, in the drawer: `name` null for a new one. */
function openProfileForm(name) {
  const isNew = !name;
  const p = isNew ? null : S.profiles[name];
  const m = p?.manifest ?? {};
  const reg = S.shared.mcpRegistry ?? {};
  const picked = new Set(isNew ? Object.keys(reg) : p.mcp);
  const field = (label, input, hint = "") =>
    `<label class="fld">${esc(label)}${hint ? ` <small>${esc(hint)}</small>` : ""}${input}</label>`;
  const host = drawer(
    isNew ? t("profile.new") : name,
    `<form class="pform" id="pform" data-name="${esc(name ?? "")}">
      ${
      isNew
        ? field(
          t("profile.name"),
          `<input name="name" required pattern="[a-z][a-z0-9_-]{1,30}" placeholder="research" autofocus>`,
        )
        : ""
    }
      ${
      field(
        t("profile.description"),
        `<input name="description" value="${esc(m.description ?? "")}" placeholder="${
          esc(t("profile.description.ph"))
        }">`,
      )
    }
      ${
      field(
        t("profile.command"),
        `<input name="command" value="${esc(m.command ?? "")}" placeholder="claude-${esc(name || "research")}">`,
      )
    }
      ${
      field(
        t("profile.alias"),
        `<input name="alias" value="${esc(m.alias ?? "")}" pattern="[a-zA-Z_][a-zA-Z0-9_-]*" placeholder="cr">`,
      )
    }
      ${
      field(
        t("profile.desktop"),
        `<input name="desktopDir" value="${esc(m.desktopDir ?? "")}" placeholder="~/.config/Claude-Research">`,
      )
    }
      <div class="fld">MCP<div class="chips">${
      Object.keys(reg).map((s) =>
        `<button type="button" class="chip pick${picked.has(s) ? " on" : ""}" data-pick="${esc(s)}" aria-pressed="${
          picked.has(s)
        }">${esc(s)}</button>`
      ).join("") || `<small>${esc(t("profile.registryEmpty"))}</small>`
    }</div></div>
      <label class="fld check"><input type="checkbox" name="disableAccountMcp"${
      m.disableAccountMcp ? " checked" : ""
    }> ${esc(t("profile.disableAccountMcp"))}</label>
      <div class="pform-foot">
        <button class="btn primary" type="submit">${esc(t(isNew ? "profile.create" : "profile.save"))}</button>
        <button class="btn ghost" type="button" data-close>${esc(t("profile.cancel"))}</button>
        <span class="hint">${esc(t("profile.hint"))}</span>
      </div>
    </form>`,
  );
  $("#pform", host).addEventListener("submit", (e) => saveProfile(e, host));
}

const shortHome = (p) => {
  const h = S?.profiles
    ? Object.values(S.profiles)[0]?.dir?.replace(/\/[^/]+$/, "").replace(/\/\.claude-multi$/, "")
    : null;
  return h && p.startsWith(h) ? "~" + p.slice(h.length) : p;
};

document.addEventListener("click", (e) => {
  const ed = e.target.closest("[data-edit]");
  if (ed) return openProfileForm(ed.dataset.edit);
  if (e.target.closest("#addp")) return openProfileForm(null);
  const pick = e.target.closest("[data-pick]");
  if (pick) pick.setAttribute("aria-pressed", String(pick.classList.toggle("on")));
});

async function saveProfile(e, host) {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.dataset.name || f.elements.name.value.trim(),
    description: f.elements.description.value.trim(),
    command: f.elements.command.value.trim(),
    alias: f.elements.alias.value.trim(),
    desktopDir: f.elements.desktopDir.value.trim(),
    mcp: $$("[data-pick].on", f).map((c) => c.dataset.pick),
    disableAccountMcp: f.elements.disableAccountMcp.checked,
  };
  const btn = $("button[type=submit]", f);
  btn.disabled = true;
  btn.textContent = t("profile.working");
  try {
    const r = await post("/api/profile", body);
    host.remove();
    await loadStatus();
    renderProfiles();
    toast(r.message ?? t("profile.saved", { name: body.name }));
    if (r.output) showOutput(body.name, r.output);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = t(f.dataset.name ? "profile.save" : "profile.create");
    toast(String(err.message ?? err), true);
  }
}

/* ---------------- permissions ---------------- */
let PERM = null;
let permDrag = null;
async function loadPermissions() {
  PERM = await api("/api/permissions");
  renderPermissions();
}

function renderPermissions() {
  if (!PERM) return;
  $("#perm-mode").value = PERM.mode;
  $("#perm-lists").innerHTML = ["allow", "ask", "deny"].map((l) =>
    `<section class="panel perm-list" data-perm-drop="${l}">
      <div class="panel-h"><h3>${esc(t(`perm.${l}`))}</h3><span class="r">${PERM.rules[l].length}</span></div>
      <div class="panel-b">
        <span class="sub">${esc(t(`perm.${l}.what`))}</span>
        ${
      PERM.rules[l].map((r) =>
        `<div class="perm-rule" draggable="true" data-perm-from="${l}" data-rule="${esc(r)}"><code>${
          esc(r)
        }</code><select class="perm-move" data-perm-move="${l}" data-rule="${esc(r)}" aria-label="${
          esc(t("perm.move"))
        }"><option value="">${esc(t("perm.move"))}</option>${
          ["allow", "ask", "deny"].filter((o) => o !== l).map((o) =>
            `<option value="${o}">${esc(t(`perm.${o}`))}</option>`
          ).join("")
        }</select><button data-perm-rm="${esc(l)}" data-rule="${esc(r)}" aria-label="${
          esc(t("pl.remove"))
        }">×</button></div>`
      ).join("") || `<span class="sub">—</span>`
    }
      </div>
      <form class="perm-add" data-perm-add="${esc(l)}">
        <input name="rule" class="search" placeholder="Bash(npm test:*)" required autocomplete="off">
        <button class="btn sm" type="submit">${esc(t("mk.add"))}</button>
      </form>
    </section>`
  ).join("");
  const profs = Object.entries(PERM.profiles).filter(([, v]) => v.mode || Object.keys(v.lists).length);
  $("#perm-profiles").innerHTML = profs.map(([p, v]) =>
    `<section class="panel perm-prof">
      <div class="panel-h"><h3>${esc(p)}</h3><span class="r">${esc(t("perm.own"))}</span>
        ${
      Object.keys(v.lists).length
        ? `<button class="btn sm" data-perm-promote="${esc(p)}">${esc(t("perm.promote"))}</button>`
        : ""
    }</div>
      <div class="panel-b">
        ${v.mode ? `<div>${esc(t("perm.mode"))}: <code>${esc(v.mode)}</code></div>` : ""}
        ${
      Object.entries(v.lists).map(([l, d]) =>
        `<div><b>${esc(t(`perm.${l}`))}</b>
          ${
          d.added.length
            ? `<div class="sub">${esc(t("perm.added"))}: ${
              d.added.map((r) => `<code>${esc(r)}</code>`).join(" · ")
            }</div>`
            : ""
        }
          ${
          d.dropped.length
            ? `<div class="sub">${esc(t("perm.dropped"))}: ${
              d.dropped.map((r) => `<code>${esc(r)}</code>`).join(" · ")
            }</div>`
            : ""
        }
        </div>`
      ).join("")
    }
      </div>
    </section>`
  ).join("");
}

async function permOp(body) {
  const r = await post("/api/permissions", body).catch((e) => ({ ok: false, message: e.message }));
  toast(r.message, !r.ok);
  if (r.ok) await loadPermissions();
}
/** Moving a rule towards Allowed is the unsafe direction: it asks first. */
function permMove(from, to, rule) {
  if (from === to) return;
  if (to === "allow" && !confirm(t("perm.move.confirm", { r: rule, l: t(`perm.${from}`) }))) return;
  permOp({ op: "move", from, to, rule });
}
document.addEventListener("dragstart", (e) => {
  const r = e.target.closest?.("[data-perm-from]");
  if (!r) return;
  e.dataTransfer.setData("text/plain", r.dataset.rule);
  e.dataTransfer.effectAllowed = "move";
  permDrag = { from: r.dataset.permFrom, rule: r.dataset.rule };
  r.classList.add("dragging");
});
document.addEventListener("dragend", () => {
  permDrag = null;
  document.querySelectorAll(".perm-rule.dragging,.perm-list.over").forEach((x) =>
    x.classList.remove("dragging", "over")
  );
});
document.addEventListener("dragover", (e) => {
  const col = e.target.closest?.("[data-perm-drop]");
  if (!col || !permDrag) return;
  e.preventDefault();
  document.querySelectorAll(".perm-list.over").forEach((x) => x !== col && x.classList.remove("over"));
  col.classList.toggle("over", col.dataset.permDrop !== permDrag.from);
});
document.addEventListener("drop", (e) => {
  const col = e.target.closest?.("[data-perm-drop]");
  if (!col || !permDrag) return;
  e.preventDefault();
  const d = permDrag;
  permDrag = null;
  col.classList.remove("over");
  permMove(d.from, col.dataset.permDrop, d.rule);
});
document.addEventListener("change", (e) => {
  const s = e.target.closest?.("[data-perm-move]");
  if (s && s.value) permMove(s.dataset.permMove, s.value, s.dataset.rule);
});
$("#perm-mode").addEventListener("change", (e) => permOp({ op: "mode", mode: e.target.value }));
document.addEventListener("submit", (e) => {
  const f = e.target.closest("[data-perm-add]");
  if (!f) return;
  e.preventDefault();
  permOp({ op: "add", list: f.dataset.permAdd, rule: f.elements.rule.value.trim() });
});
document.addEventListener("click", (e) => {
  const rm = e.target.closest("[data-perm-rm]");
  if (rm) return permOp({ op: "remove", list: rm.dataset.permRm, rule: rm.dataset.rule });
  const pr = e.target.closest("[data-perm-promote]");
  if (pr && confirm(t("perm.promote.confirm", { p: pr.dataset.permPromote }))) {
    permOp({ op: "promote", profile: pr.dataset.permPromote });
  }
});

/* ---------------- updates ---------------- */
const COMPONENTS = { cli: "Claude Code", desktop: "Claude Desktop", "claude-multi": "claude-multi" };
/** claude-multi itself: the repository is the program, so its state is the repository's. */
function selfCard(card) {
  const r = S.repo ?? {};
  if (!r.isRepo) return "";
  const state = !r.upstream
    ? t("up.self.noUpstream", { b: r.branch })
    : r.behind && r.ahead
    ? t("up.self.diverged", { n: r.behind, m: r.ahead })
    : r.behind && r.dirty
    ? t("up.self.dirty", { n: r.behind, d: r.dirty })
    : r.behind
    ? t("up.self.behind", { n: r.behind })
    : t("up.uptodate");
  // the button only for an install waiting on Claude: not for an update skipped for another reason
  const close = S.selfInstall ? `<button class="btn sm" data-cc="open">${esc(t("cc.btn"))}</button>` : "";
  return card(
    "claude-multi",
    (r.head ?? "").split(" ")[0],
    [state, S.selfInstall ? t("up.self.install") : null],
    null,
    close,
  );
}

/** «Close Claude and update»: the server lists who holds the install (it alone knows the PIDs), the
 *  person confirms, then TERM; KILL only as a second, explicit confirmation; then the install. */
function ccAge(s) {
  if (s == null) return "";
  const a = s < 90
    ? `${s}s`
    : s < 5400
    ? `${Math.round(s / 60)}m`
    : s < 172800
    ? `${Math.round(s / 3600)}h`
    : `${Math.round(s / 86400)}d`;
  return t("cc.age", { a });
}
function ccList(bs) {
  return `<ul class="cc-list">${
    bs.map((b) =>
      `<li><code>${esc(b.key)}</code> pid ${b.pid} ${pf(b.profile)} <span class="sub">${
        esc(
          [
            b.embedded ? t("cc.embedded") : null,
            b.busy === null ? null : t(b.busy ? "cc.busy" : "cc.idle"),
            ccAge(b.ageSec),
            b.protected ? t("cc.protected") : null,
          ].filter(Boolean).join(" · "),
        )
      }</span></li>`
    ).join("")
  }</ul>`;
}
async function closeClaudeFlow() {
  let plan;
  try {
    plan = await api("/api/close-claude");
  } catch (e) {
    return toast(String(e.message), true);
  }
  if (!plan.offer) return toast(t("cc.none"));
  const todo = plan.blockers.filter((b) => !b.protected);
  const body = (inner) => host.querySelector(".dbody").innerHTML = inner;
  const host = drawer(
    t("cc.btn"),
    `<p>${esc(t("cc.intro"))}</p>${ccList(plan.blockers)}${
      todo.length
        ? `<p><button class="btn" data-cc="term">${esc(t("cc.go"))}</button></p>`
        : `<p class="sub">${esc(t("cc.onlyProtected"))}</p>`
    }`,
  );
  const settle = async (reopenProfiles) => {
    body(`<p>${esc(t("cc.updating"))}</p>`);
    const r = await post("/api/action", { action: "settle-install", opts: [] }).catch((e) => ({
      code: 1,
      output: e.message,
    }));
    const again = reopenProfiles.length
      ? `<p>${
        reopenProfiles.map((p) =>
          `<button class="btn" data-cc="reopen" data-p="${esc(p)}">${esc(t("cc.reopen", { p }))}</button>`
        )
          .join(" ")
      }</p>`
      : "";
    body(`<pre class="out">${esc(r.output || t("act.noOutput"))}</pre>${again}`);
    toast(
      r.code
        ? t("act.doneExit", { a: "settle-install", c: r.code, s: (r.ms / 1000).toFixed(1) })
        : t("act.done", { a: "settle-install", s: (r.ms / 1000).toFixed(1) }),
      r.code !== 0,
    );
    await refresh("state");
  };
  let reopenProfiles = [];
  host.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-cc]");
    if (!b) return;
    if (b.dataset.cc === "reopen") {
      b.disabled = true;
      const r = await post("/api/close-claude", { step: "reopen", profiles: [b.dataset.p] }).catch(() => null);
      return toast(r ? t("cc.reopened", { p: (r.started ?? []).join(", ") }) : "reopen failed", !r);
    }
    if (b.dataset.cc !== "term" && b.dataset.cc !== "kill") return;
    body(`<p>${esc(t("cc.closing"))}</p>`);
    const r = await post("/api/close-claude", { step: b.dataset.cc }).catch((err) => ({
      ok: false,
      message: err.message,
    }));
    if (!r.ok) {
      body(`<p>${esc(r.message ?? "")}</p>`);
      return toast(r.message ?? "", true);
    }
    reopenProfiles = [...new Set([...reopenProfiles, ...r.reopen])];
    if (r.remaining.length) {
      body(
        `<p>${esc(t("cc.stuck"))}</p>${ccList(r.remaining)}<p class="sub">${
          esc(t("cc.forceWarn"))
        }</p><p><button class="btn" data-cc="kill">${esc(t("cc.force"))}</button></p>`,
      );
      return;
    }
    await settle(reopenProfiles);
  });
}
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-cc=open]")) closeClaudeFlow();
});
function renderUpdates() {
  const m = S.machine;
  const u = S.update ?? {};
  const card = (name, current, lines, rollback, extra = "") =>
    `<div class="vcard"><i></i><div style="flex:1;min-width:0"><b>${esc(name)}</b><code>${esc(current ?? "—")}</code>
      ${lines.filter(Boolean).map((l) => `<div class="sub">${esc(l)}</div>`).join("")}</div>${extra}${
      rollback ? `<button class="btn sm" data-action="${rollback}">${esc(t("up.rollback"))}</button>` : ""
    }</div>`;
  const cliPrev = m.cliVersions.filter((v) => v !== m.cliVersion).sort().pop();
  $("#vcards").innerHTML = card(
    "Claude Code",
    m.cliVersion,
    [
      u.cli?.latest && u.cli.latest !== m.cliVersion ? t("up.next", { v: u.cli.latest }) : t("up.uptodate"),
      cliPrev ? t("up.previous", { v: cliPrev }) : null,
    ],
    cliPrev ? "rollback-cli" : null,
  ) + card(
    "Claude Desktop",
    m.desktopVersion,
    [
      m.desktopStaged ? t("up.staged", { v: m.desktopStaged }) : t("up.uptodate"),
      m.desktopSystem ? t("up.system") : null,
      m.desktopPrevious ? t("up.previous", { v: m.desktopPrevious }) : null,
    ],
    m.desktopPrevious ? "rollback-desktop" : null,
  ) + selfCard(card);
  $("#embedded").textContent = Object.entries(m.embeddedCode ?? {})
    .map(([v, vs]) => t("up.embedded", { v, vs: vs.join(", ") })).join(" · ");
  const when = (iso) =>
    new Date(iso).toLocaleString(lang(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  $("#uplog").innerHTML = (S.updateLog ?? []).map((e) => {
    const bad = e.event === "failed" || e.event === "verify-failed";
    return `<div class="log-row${bad ? " bad" : ""}">
      <span class="when">${esc(when(e.at))}</span>
      <span>${esc(COMPONENTS[e.component] ?? e.component)}</span>
      <span>${esc(e.from || "—")} → ${esc(e.to || "—")}</span>
      <span>${esc(t(`up.ev.${e.event}`))}${e.detail ? ` · ${esc(e.detail)}` : ""}</span>
    </div>`;
  }).join("") || `<div class="panel-b sub">${esc(t("up.noLog"))}</div>`;
}

/* ---------------- output drawer ---------------- */
function drawer(title, inner) {
  $(".scrim")?.parentElement?.remove();
  const host = document.createElement("div");
  host.innerHTML = `<div class="scrim" data-close></div>
    <aside class="drawer" role="dialog" aria-label="${esc(title)}">
      <div class="dh"><h3>${esc(title)}</h3><button class="x" data-close aria-label="${
    esc(t("close"))
  }">×</button></div>
      <div class="dbody">${inner}</div>
    </aside>`;
  document.body.appendChild(host);
  const close = () => {
    host.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  host.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) close();
  });
  document.addEventListener("keydown", onKey);
  return host;
}

function showOutput(title, text) {
  return drawer(title, `<pre class="out">${esc(text)}</pre>`);
}

/* ---------------- health ---------------- */
/** The area a check belongs to, from its id: the health list groups by it. */
const CHK_AREAS = [
  ["brain", /^(brain|tasks)\b|^mcp\.(brain|tasks)$/],
  ["mcp", /^(mcp|vault)\b/],
  ["desktop", /^(desktop|app)\b/],
  ["profiles", /^(profile|bin|stub|zshrc|config)\b/],
  ["setup", /./],
];
const chkAreaOf = (id) => CHK_AREAS.find(([, re]) => re.test(id))[0];
const CHK_SYM = { ok: "✓", warn: "!", fail: "✕", run: "◠" };
const chkRow = (c) =>
  `<div class="chk">
    <span class="ic ${c.status}">${c.status === "run" ? `<span class="spin">◠</span>` : CHK_SYM[c.status]}</span>
    <div><div class="name">${esc(c.msg)}</div><div class="msg">${esc(c.id)}</div></div>
    ${c.status !== "ok" && fixControl(c) || "<span></span>"}
  </div>`;

/** Health: what needs you first, in the panel; what passes below, by area and folded. */
function renderHealth(checks) {
  const order = { fail: 0, warn: 1, run: 2, ok: 3 };
  const todo = [...checks].filter((c) => c.status !== "ok").sort((a, b) => order[a.status] - order[b.status]);
  $("#checks").innerHTML = todo.map(chkRow).join("") ||
    `<div class="chk-none">${esc(t("health.allGood", { n: checks.length }))}</div>`;
  const ok = checks.filter((c) => c.status === "ok");
  $("#checks-ok").innerHTML = CHK_AREAS.map(([a]) => {
    const list = ok.filter((c) => chkAreaOf(c.id) === a);
    return list.length
      ? `<details class="panel chk-area"><summary><span class="ic ok">✓</span><b>${
        esc(t(`health.area.${a}`))
      }</b><span class="sub">${esc(t("health.areaOk", { n: list.length }))}</span></summary><div class="checks">${
        list.map(chkRow).join("")
      }</div></details>`
      : "";
  }).join("");
  const n = (s) => checks.filter((c) => c.status === s).length;
  $("#hsum").textContent = t("health.sum", { ok: n("ok"), w: n("warn"), f: n("fail") });
}

/* ---------------- system overview ---------------- */
/** One card per part of the setup: its state in a line or two, what to do when there is something,
    and a link to the tab with the detail. */
function renderOverview() {
  const card = (title, href, body, cls = "") =>
    `<section class="ov-card ${cls}"><div class="ov-h"><h3>${esc(title)}</h3><a class="pane-link" href="${href}">${
      esc(t("ov.open"))
    }</a></div>${body}</section>`;
  const line = (status, text, extra = "") =>
    `<div class="ov-line"><span class="ic ${status}">${CHK_SYM[status]}</span><div>${text}</div>${extra}</div>`;
  const checks = S.doctor ?? [];
  const byId = (id) => checks.find((c) => c.id === id);

  // health: the problems themselves, the passing count in one line
  const todo = checks.filter((c) => c.status !== "ok").sort((a, b) =>
    (a.status === "fail" ? -1 : 0) - (b.status === "fail" ? -1 : 0)
  );
  const health = todo.length
    ? todo.slice(0, 5).map((c) => line(c.status, esc(c.msg), fixControl(c))).join("") +
      (todo.length > 5 ? `<div class="sub">${esc(t("ov.more", { n: todo.length - 5 }))}</div>` : "")
    : line("ok", esc(t("health.allGood", { n: checks.length })));

  // updates: one line per component, the same words as the Updates tab
  const m = S.machine, u = S.update ?? {}, r = S.repo ?? {};
  const upLine = (name, v, pending) =>
    line(
      pending ? "warn" : "ok",
      `<b>${esc(name)}</b> <code>${esc(v ?? "—")}</code> <span class="sub">${esc(pending ?? t("up.uptodate"))}</span>`,
    );
  const updates = upLine(
    "Claude Code",
    m.cliVersion,
    u.cli?.latest && u.cli.latest !== m.cliVersion ? t("up.next", { v: u.cli.latest }) : null,
  ) +
    (m.desktopVersion
      ? upLine("Claude Desktop", m.desktopVersion, m.desktopStaged ? t("up.staged", { v: m.desktopStaged }) : null)
      : "") +
    (r.isRepo
      ? upLine("claude-multi", (r.head ?? "").split(" ")[0], r.behind ? t("up.self.behind", { n: r.behind }) : null)
      : "") +
    `<div class="ov-acts"><button class="btn sm" data-action="update-now">${esc(t("up.now"))}</button></div>`;

  // brain: whether this machine reaches it, and the last copy kept here
  const b = S.brain, tok = byId("brain.token");
  const when = (iso) =>
    new Date(iso).toLocaleString(lang(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const brain = !b ? `<p class="sub">${esc(t("conn.noBrain"))}</p>` : line(
    tok?.status ?? "warn",
    tok?.status === "ok"
      ? esc(t("ov.brain.on", { u: b.url.replace(/^https?:\/\//, "") }))
      : esc(tok?.msg ?? t("conn.brainOff")),
    tok?.fix ? actionButton(tok.fix) : "",
  ) +
    line(
      byId("tasks.store")?.status ?? "warn",
      esc(t(byId("tasks.store")?.status === "ok" ? "ov.tasks.on" : "ov.tasks.off")),
    ) +
    (b.lastCopy
      ? line(
        b.lastCopy.verified ? "ok" : "warn",
        esc(t(b.lastCopy.verified ? "ov.copy" : "ov.copyUnchecked", { d: when(b.lastCopy.checked) })),
      )
      : line("warn", esc(t("ov.noCopy"))));

  // profiles: who each one is and what is open now
  const live = new Set(S.running.cli.map((c) => c.profile));
  const deskOpen = new Set(S.running.desktop.map((d) => d.variant));
  const profiles = Object.entries(S.profiles).map(([n, p]) =>
    `<div class="ov-prof"><span class="dot${live.has(n) || deskOpen.has(n) ? " active" : ""}"></span><b>${
      esc(n)
    }</b><span class="sub">${esc(p.account ?? t("profile.notSignedIn"))}</span><code>${
      esc(p.manifest.command ?? `claude-${n}`)
    }</code><span class="sub">${
      esc(
        [
          live.has(n) ? t("ov.cliOpen", { n: S.running.cli.filter((c) => c.profile === n).length }) : null,
          deskOpen.has(n) ? t("ov.deskOpen") : null,
        ].filter(Boolean).join(" · "),
      )
    }</span></div>`
  ).join("");

  $("#ov").innerHTML = card(
    t("sys.health"),
    "#system/health",
    health,
    todo.some((c) => c.status === "fail") ? "fail" : todo.length ? "warn" : "",
  ) +
    card(t("sys.updates"), "#system/updates", updates) +
    card(t("conn.brain"), "#connections", brain) +
    card(t("sys.profiles"), "#system/profiles", profiles);
}

/** A fix line is a shell command. When it maps to an allowlisted action we offer the button;
    otherwise it is shown as text to copy, because running arbitrary strings from here would
    quietly turn the console into a remote shell. */
const FIX_ACTIONS = {
  "claude-multi install": "install",
  "claude-multi mcp sync": "mcp-sync",
  "claude-multi doctor": "doctor",
  "claude-multi sync --fetch": "sync-fetch",
  "claude-multi usage ingest": "usage-ingest",
  "claude-multi update --auto": "update-now",
  "claude-multi update --check": "update-check",
};
function actionButton(fix) {
  const act = FIX_ACTIONS[fix.trim()];
  return act
    ? `<button class="fix" data-action="${esc(act)}">${esc(fix)}</button>`
    : `<code class="fix" style="cursor:text;background:none;border-color:var(--line);color:var(--fg-faint)" title="${
      esc(fix)
    }">${esc(short(fix, 40))}</code>`;
}

/* ---------------- guided repair ---------------- */
/** Actions that only read or check: a repair made of these starts without asking. */
const READ_ONLY_ACTIONS = ["doctor", "update-check", "mcp-check", "install-dry", "sync-fetch"];
const repairButton = (c) => `<button class="fix" data-repair="${esc(c.id)}">${esc(t("rep.btn"))}</button>`;
/** What a check offers: its repair when it has steps, else the fix as before. */
const fixControl = (c) => c.repair?.length ? repairButton(c) : c.fix ? actionButton(c.fix) : "";

/** Runs one job on the server, calling `onOut` with each piece of output as it arrives. Resolves with
 *  `{ code, cancelled }` or `{ error }`; `track` receives the job id, for cancelling. */
async function runJob(action, params, onOut, track) {
  const r = await fetch("/api/job", {
    method: "POST",
    headers: { "content-type": "application/json", "x-claude-multi": "1" },
    body: JSON.stringify({ action, params }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) return { error: j.message ?? String(r.status) };
  track(j.id);
  const res = await fetch(`/api/job?id=${encodeURIComponent(j.id)}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "", end = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const l of lines) {
      const m = JSON.parse(l);
      if (m.o !== undefined) onOut(m.o);
      else if (m.done !== undefined) end = { code: m.done, cancelled: m.cancelled };
    }
  }
  return end ?? { error: t("rep.lost") };
}

/** «Repair»: the numbered steps of a check with their state, the live output of the running one, and
 *  a re-run of the check at the end. The steps come from the doctor; the server checks every action. */
function repairFlow(id) {
  const check = (S?.doctor ?? []).find((c) => c.id === id);
  if (!check?.repair?.length) return;
  const steps = check.repair;
  const state = steps.map(() => "todo");
  let jobId = null, running = false, cause = "", out = "", userGo = null;
  const label = (s) =>
    s.kind === "action" ? `<code>${esc(s.cmd)}</code>` : s.kind === "user" ? esc(s.text) : esc(t("rep.verifyStep"));
  const manual = steps.filter((s) => s.kind !== "verify").map((s) => s.kind === "action" ? s.cmd : s.text).join("\n");
  const host = drawer(t("rep.title"), "");
  const draw = () => {
    const go = !running && (state.includes("failed") || state.every((s) => s === "todo"));
    host.querySelector(".dbody").innerHTML = `<div class="rep">
      <p class="rep-msg">${esc(check.msg)}</p>
      <ol class="rep-steps">${
      steps.map((s, i) =>
        `<li class="rep-${state[i]}"><span class="rep-st">${esc(t(`rep.${state[i]}`))}</span> ${label(s)}${
          state[i] === "waiting" ? ` <button class="btn sm" data-rep="user">${esc(t("rep.userDone"))}</button>` : ""
        }</li>`
      ).join("")
    }</ol>
      ${cause ? `<p class="rep-cause">${esc(cause)}</p>` : ""}
      ${out ? `<pre class="out rep-out">${esc(out)}</pre>` : ""}
      <p>${
      running
        ? `<button class="btn sm" data-rep="cancel">${esc(t("rep.cancel"))}</button>`
        : go
        ? `<button class="btn" data-rep="go">${esc(t("rep.start"))}</button>`
        : ""
    }</p>
      <details><summary>${esc(t("rep.manual"))}</summary><pre class="out">${esc(manual)}</pre></details>
    </div>`;
  };
  const run = async () => {
    running = true;
    cause = "";
    for (let i = 0; i < steps.length; i++) {
      if (state[i] === "done") continue;
      const s = steps[i];
      const fail = (why) => {
        state[i] = "failed";
        cause = why;
      };
      state[i] = "running";
      out = "";
      draw();
      if (s.kind === "action") {
        const r = await runJob(s.action, s.args ?? {}, (o) => {
          out += o;
          const el = host.querySelector(".rep-out");
          if (!el) return draw();
          el.textContent = out;
          el.scrollTop = el.scrollHeight;
        }, (j) => jobId = j).catch((e) => ({ error: e.message }));
        jobId = null;
        if (r.error) return fail(r.error);
        if (r.cancelled) return fail(t("rep.cancelled"));
        if (r.code) return fail(out.trim().split("\n").filter(Boolean).pop() ?? t("rep.exit", { c: r.code }));
      } else if (s.kind === "user") {
        state[i] = "waiting";
        draw();
        await new Promise((res) => userGo = res);
        userGo = null;
      } else {
        await loadStatus(true);
        renderView();
        const now = S.doctor.find((c) => c.id === id);
        if (now && now.status !== "ok") return fail(t("rep.still", { msg: now.msg }));
      }
      state[i] = "done";
    }
    toast(t("rep.fixed"));
  };
  host.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-rep]");
    if (!b) return;
    if (b.dataset.rep === "cancel") {
      if (jobId) await post("/api/job/cancel", { id: jobId }).catch(() => {});
    } else if (b.dataset.rep === "user") {
      userGo?.();
    } else if (b.dataset.rep === "go" && !running) {
      const changes = steps.filter((s) => s.kind === "action" && !READ_ONLY_ACTIONS.includes(s.action));
      if (changes.length && !confirm(t("rep.confirm", { cmds: changes.map((s) => s.cmd).join("\n") }))) return;
      state.forEach((s, i) => state[i] = s === "failed" ? "todo" : s);
      await run();
      running = false;
      draw();
    }
  });
  draw();
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-repair]");
  if (b) repairFlow(b.dataset.repair);
});

$("#rerun").addEventListener("click", async () => {
  const btn = $("#rerun");
  btn.disabled = true;
  // stream the re-run: mark everything pending, then swap in the fresh verdicts
  renderHealth(S.doctor.map((c) => ({ ...c, status: "run", msg: t("health.checking"), fix: null, repair: null })));
  try {
    await loadStatus();
    renderHealth(S.doctor);
    toast(t("health.done"));
  } catch (e) {
    toast(String(e.message), true);
  }
  btn.disabled = false;
});

function renderShared() {
  const s = S.shared;
  $("#shared").innerHTML = `<dl class="kv">
    <dt>${esc(t("shared.skills"))}</dt><dd>${Object.keys(s.skills).length}</dd>
    <dt>${esc(t("shared.agents"))}</dt><dd>${Object.keys(s.agents).length}</dd>
    <dt>${esc(t("shared.commands"))}</dt><dd>${Object.keys(s.commands).length}</dd>
    <dt>${esc(t("shared.hooks"))}</dt><dd>${s.hooks.length}</dd>
    <dt>${esc(t("shared.rules"))}</dt><dd>${esc(s.rules.join(", ") || "—")}</dd>
  </dl>`;
}

/* ---------------- actions ---------------- */
async function runAction(action, opts = []) {
  toast(t("act.running", { a: action }));
  try {
    const r = await post("/api/action", { action, opts });
    showOutput(action, r.output || t("act.noOutput"));
    const s = (r.ms / 1000).toFixed(1);
    toast(r.code ? t("act.doneExit", { a: action, c: r.code, s }) : t("act.done", { a: action, s }), r.code !== 0);
    await refresh("state");
  } catch (e) {
    toast(String(e.message), true);
  }
}

// any element carrying data-action runs that allowlisted action: health fixes, connection buttons
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-action]");
  if (b) runAction(b.dataset.action);
});

/* ---------------- plugins ---------------- */
let PL = null, CAT = null, plBusy = false;
// the catalog draws a page at a time; a new search or marketplace starts again from the first
const CAT_PAGE = 20;
let catShown = CAT_PAGE;

async function loadPlugins(fresh = false) {
  PL = await api("/api/plugins" + (fresh ? "?fresh" : ""));
  renderPlugins();
}
async function loadCatalog(fresh = false) {
  CAT = await api("/api/plugins/catalog" + (fresh ? "?fresh" : ""));
  renderCatalogSelect();
  renderCatalog();
}
function renderCatalogSelect() {
  const sel = $("#cat-mk"), cur = sel.value;
  const mks = CAT ? [...new Set(CAT.map((c) => c.marketplace))].sort() : [];
  sel.innerHTML = `<option value="">${esc(t("cat.allMk"))}</option>` +
    mks.map((m) => `<option${m === cur ? " selected" : ""}>${esc(m)}</option>`).join("");
}

/** One toggle: `value` is the entry this source holds (true/false, or null/undefined = none). */
function plToggle(id, target, value, cell) {
  const own = value === true || value === false;
  const on = cell ? cell.enabled : value === true;
  const label = own ? t(value ? "pl.on" : "pl.off") : cell ? t(on ? "pl.on" : "pl.off") : "—";
  const mark = !cell
    ? ""
    : cell.broken
    ? `<span class="inst bad" title="${esc(t("pl.broken"))}">⚠</span>`
    : cell.installed
    ? `<span class="inst" title="${esc(t("pl.installed"))}${cell.version ? " · " + esc(cell.version) : ""}">●</span>`
    : `<span class="inst no" title="${esc(t("pl.notInstalled"))}">○</span>`;
  const title = own
    ? t("pl.setHere", { t: target, v: t(value ? "pl.on" : "pl.off") })
    : cell
    ? t("pl.inherits", { t: target, v: t(on ? "pl.on" : "pl.off") })
    : t("pl.notShared");
  return `<button class="tg ${own ? "own" : "inh"} ${on ? "on" : "off"}" data-tg="${esc(id)}" data-target="${
    esc(target)
  }" data-val="${own ? String(value) : "inherit"}" title="${esc(title)}">${mark}${label}</button>`;
}

function renderPlugins() {
  if (!PL) return;
  const profs = PL.profiles;
  const rows = PL.plugins.filter((r) => !r.synced);
  const inst = rows.filter((r) => profs.some((p) => r.profiles[p].installed)).length;
  const broken = rows.filter((r) => profs.some((p) => r.profiles[p].broken)).length;
  $("#pl-sum").textContent = t("pl.sum", { n: rows.length, i: inst }) +
    (broken ? t("pl.sumBroken", { b: broken }) : "");
  $("#pl-head").innerHTML = `<th>${esc(t("pl.plugin"))}</th><th>${esc(t("pl.all"))}</th>${
    profs.map((p) => `<th>${esc(p)}</th>`).join("")
  }<th></th>`;
  $("#pl-rows").innerHTML = rows.map((r) =>
    `<tr>
      <td><span class="pname">${esc(r.name)}</span> <span class="dim">${esc(r.marketplace)}</span></td>
      <td>${plToggle(r.id, "shared", r.shared)}</td>
      ${profs.map((p) => `<td>${plToggle(r.id, p, r.profiles[p].override, r.profiles[p])}</td>`).join("")}
      <td class="acts">
        <button class="btn ghost sm" data-pl-details="${esc(r.id)}">${esc(t("pl.details"))}</button>
        <button class="btn ghost sm" data-pl-update="${esc(r.id)}">${esc(t("pl.update"))}</button>
        <button class="btn ghost sm danger" data-pl-remove="${esc(r.id)}">${esc(t("pl.remove"))}</button>
      </td>
    </tr>`
  ).join("") || `<tr><td class="empty" colspan="${profs.length + 3}">${esc(t("pl.none"))}</td></tr>`;

  $("#mk-rows").innerHTML = PL.marketplaces.map((m) =>
    `<tr>
      <td><span class="pname">${esc(m.name)}</span> <span class="dim">${esc(m.source)}</span></td>
      <td class="txt">${
      m.declared
        ? `<span class="chip on">${esc(t("mk.shared"))}</span>`
        : `<span class="chip" title="${esc(t("mk.localTitle"))}">${esc(t("mk.local"))}</span>`
    }</td>
      <td title="${esc(t("mk.known"))}">${m.known.length}/${profs.length}</td>
      <td class="acts">
        <button class="btn ghost sm" data-mk-update="${esc(m.name)}">${esc(t("pl.update"))}</button>
        <button class="btn ghost sm danger" data-mk-remove="${esc(m.name)}">${esc(t("pl.remove"))}</button>
      </td>
    </tr>`
  ).join("") || `<tr><td class="empty">${esc(t("mk.none"))}</td></tr>`;

  // only what an account really syncs today: shared keeps `false` entries for plugins long gone
  const synced = PL.plugins.filter((r) => r.synced && profs.some((p) => r.profiles[p].installed));
  $("#acct").innerHTML = `
    <div class="acct-h">${esc(t("acct.plugins"))}</div>
    ${
    synced.map((r) =>
      `<div class="acct-row"><span>${esc(r.name)}</span><span class="chips">${
        profs.map((p) =>
          `<span class="chip${r.profiles[p].enabled ? " on" : ""}" title="${esc(p)}: ${
            esc(t(r.profiles[p].enabled ? "pl.on" : "pl.off"))
          }">${esc(p)}</span>`
        ).join("")
      }</span></div>`
    ).join("") || `<div class="dim">${esc(t("profile.none"))}</div>`
  }
    <div class="acct-h">${esc(t("acct.skills"))}</div>
    ${
    profs.map((p) => {
      const sk = PL.syncedSkills[p] ?? [];
      return sk.length
        ? `<details class="acct-row"><summary><span>${esc(p)}</span><span class="dim">${
          esc(t("acct.skillsN", { n: sk.length }))
        }</span></summary><div class="skl">${sk.map(esc).join(" · ")}</div></details>`
        : `<div class="acct-row"><span>${esc(p)}</span><span class="dim">${esc(t("profile.none"))}</span></div>`;
    }).join("")
  }
    <p class="note">${t("acct.note")}</p>`;
  if (CAT) renderCatalog();
}

function renderCatalog() {
  if (!CAT) return;
  const q = $("#cat-q").value.trim().toLowerCase(), mk = $("#cat-mk").value;
  const hits = CAT.filter((c) =>
    (!mk || c.marketplace === mk) && (!q || `${c.id} ${c.description}`.toLowerCase().includes(q))
  );
  const page = hits.slice(0, catShown);
  $("#cat-sum").textContent = t("cat.sum", { n: page.length, t: hits.length });
  const profs = PL?.profiles ?? [];
  const where = (id) => profs.filter((p) => PL?.plugins.find((r) => r.id === id)?.profiles[p]?.installed);
  $("#cat-rows").innerHTML = page.map((c) => {
        const w = where(c.id);
        return `<tr>
      <td class="cdesc"><span class="pname">${esc(c.name)}</span> <span class="dim">${esc(c.marketplace)}${
          c.installs ? ` · ${esc(t("cat.installs", { n: fmt(c.installs) }))}` : ""
        }</span>
        <div class="desc">${esc(short(c.description, 220))}</div></td>
      <td>${
          w.length
            ? `<span class="chip on" title="${
              esc(t("cat.installedOn", { p: w.join(", ") }))
            }">${w.length}/${profs.length}</span>`
            : ""
        }</td>
      <td class="acts">
        ${
          w.length
            ? `<button class="btn ghost sm" data-pl-details="${esc(c.id)}">${esc(t("pl.details"))}</button>`
            : ""
        }
        <select class="sel" data-cat-scope="${esc(c.id)}"><option value="all">${esc(t("cat.allProfiles"))}</option>${
          profs.map((p) => `<option>${esc(p)}</option>`).join("")
        }</select>
        <button class="btn sm" data-cat-install="${esc(c.id)}">${esc(t("pl.install"))}</button>
      </td>
    </tr>`;
      }).join("") +
      (hits.length > page.length
        ? `<tr><td class="empty" colspan="3"><button class="btn ghost sm" data-cat-more>${
          esc(t("cat.more", { n: Math.min(CAT_PAGE, hits.length - page.length) }))
        }</button></td></tr>`
        : "") || `<tr><td class="empty">${esc(t("cat.nothing"))}</td></tr>`;
}

/** Run one operation. A marketplace-declared command comes back as `confirm`: it is shown, and
    runs only if accepted here — the server never accepts one on its own. */
async function plOp(body, label) {
  if (plBusy) return toast(t("pl.busy"), true);
  plBusy = true;
  document.body.classList.add("plbusy");
  toast(`${label}…`);
  try {
    let r = await post("/api/plugins", body);
    if (r.confirm) {
      if (!confirm(t("pl.confirmCmd", { msg: r.message, cmd: r.confirm.command }))) return toast(t("pl.notAccepted"));
      const retry = body.op === "set"
        ? {
          op: "install",
          id: body.id,
          profiles: body.target === "shared" ? "all" : [body.target],
          accept: r.confirm.sha256,
        }
        : { ...body, accept: r.confirm.sha256 };
      r = await post("/api/plugins", retry);
    }
    toast(r.message, !r.ok);
    if (!r.ok && r.log?.length) showOutput(r.message, r.log.join("\n"));
  } catch (e) {
    toast(e.message, true);
  } finally {
    plBusy = false;
    document.body.classList.remove("plbusy");
    await loadPlugins(true).catch(() => {});
  }
}

document.addEventListener("click", async (e) => {
  const tg = e.target.closest("[data-tg]");
  if (tg) {
    // inherit → on → off → inherit
    const next = { inherit: true, true: false, false: null }[tg.dataset.val];
    const target = tg.dataset.target;
    const state = next === null
      ? t(target === "shared" ? "pl.opOutOfShared" : "pl.opInherit")
      : t(next ? "pl.on" : "pl.off");
    return plOp(
      { op: "set", id: tg.dataset.tg, target, value: next },
      t("pl.opSet", { id: tg.dataset.tg, state, t: target }),
    );
  }
  const det = e.target.closest("[data-pl-details]");
  if (det) {
    const host = showOutput(det.dataset.plDetails, t("pl.loading"));
    const r = await api(`/api/plugins/details?id=${encodeURIComponent(det.dataset.plDetails)}`)
      .catch((err) => ({ text: err.message }));
    $("pre.out", host).textContent = r.text || t("pl.noDetails");
    return;
  }
  const up = e.target.closest("[data-pl-update]");
  if (up) return plOp({ op: "update", id: up.dataset.plUpdate }, t("pl.opUpdating", { id: up.dataset.plUpdate }));
  const rm = e.target.closest("[data-pl-remove]");
  if (rm) {
    const id = rm.dataset.plRemove;
    if (!confirm(t("pl.confirmRemove", { id }))) return;
    return plOp({ op: "uninstall", id, profiles: "all" }, t("pl.opRemoving", { id }));
  }
  const ins = e.target.closest("[data-cat-install]");
  if (ins) {
    const id = ins.dataset.catInstall;
    const scope = $(`[data-cat-scope="${CSS.escape(id)}"]`).value;
    return plOp(
      { op: "install", id, profiles: scope === "all" ? "all" : [scope] },
      t("pl.opInstalling", { id, where: scope === "all" ? t("pl.everyProfile") : scope }),
    );
  }
  const mu = e.target.closest("[data-mk-update]");
  if (mu) {
    return plOp(
      { op: "marketplace-update", name: mu.dataset.mkUpdate },
      t("pl.opUpdating", { id: mu.dataset.mkUpdate }),
    )
      .then(() => loadCatalog(true));
  }
  const mr = e.target.closest("[data-mk-remove]");
  if (mr) {
    const n = mr.dataset.mkRemove;
    if (!confirm(t("mk.confirmRemove", { n }))) return;
    return plOp({ op: "marketplace-remove", name: n }, t("pl.opRemoving", { id: n })).then(() => loadCatalog(true));
  }
});
$("#pl-refresh").addEventListener("click", () => {
  loadPlugins(true);
  loadCatalog(true);
});
$("#mk-update").addEventListener(
  "click",
  () => plOp({ op: "marketplace-update" }, t("mk.opUpdateAll")).then(() => loadCatalog(true)),
);
$("#mk-add").addEventListener("submit", (e) => {
  e.preventDefault();
  const source = e.target.elements.source.value.trim();
  plOp({ op: "marketplace-add", source }, t("mk.opAdding", { s: source })).then(() => {
    e.target.reset();
    loadCatalog(true);
  });
});
let catTimer = null;
const catFilter = () => {
  catShown = CAT_PAGE;
  renderCatalog();
};
$("#cat-q").addEventListener("input", () => {
  clearTimeout(catTimer);
  catTimer = setTimeout(catFilter, 120);
});
$("#cat-mk").addEventListener("change", catFilter);
$("#cat-rows").addEventListener("click", (e) => {
  if (!e.target.closest("[data-cat-more]")) return;
  catShown += CAT_PAGE;
  renderCatalog();
});

/* ---------------- navigation ---------------- */
// #today · #connections · #system/<tab>. The tray opens a view by setting the hash.
const VIEWS = ["today", "tasks", "brain", "connections", "system"];
const TABS = ["overview", "profiles", "permissions", "plugins", "updates", "health"];

function go(hash) {
  const [v, s] = String(hash).split("/");
  view = VIEWS.includes(v) ? v : "today";
  if (view === "system") sub = TABS.includes(s) ? s : sub;
  const want = view === "system" ? `system/${sub}` : view;
  if (location.hash.slice(1) !== want) history.replaceState(null, "", `#${want}`);

  $$("#nav a").forEach((a) => a.toggleAttribute("aria-current", a.dataset.v === view));
  $$("#nav a[aria-current]").forEach((a) => a.setAttribute("aria-current", "page"));
  $$(".view").forEach((el) => el.hidden = el.id !== `v-${view}`);
  // the field to ask Claude lives where there is something to ask about
  $("#ask-dock").hidden = !["today", "tasks", "brain"].includes(view);
  if (view !== "tasks" && ASK.kind === "newtask") askContext("ask");
  // on the Brain page the field asks for changes to the brain; elsewhere it is a plain question again
  if (view !== "brain" && ASK.kind === "brain") askContext("ask");
  if (view === "brain" && ASK.kind === "ask") askContext("brain", bMode === "read" ? bSel : null);
  $$("#tabs a").forEach((a) => a.setAttribute("aria-selected", String(a.dataset.t === sub)));
  $$(".sub-view").forEach((el) => el.hidden = el.id !== `s-${sub}`);
  renderTitle();
  renderView();
  if (view === "system" && sub === "plugins") {
    loadPlugins().catch((e) => toast(e.message, true));
    if (!CAT) loadCatalog().catch((e) => toast(e.message, true));
  }
}

function renderTitle() {
  // Today greets, as Claude does; the date heads the day below
  const h = new Date().getHours();
  $("#title").textContent = view === "today"
    ? t(`greet.${h < 5 ? "night" : h < 13 ? "morning" : h < 18 ? "afternoon" : "evening"}`)
    : t(`title.${view}`);
  $("#eyebrow").textContent = view === "today" ? "" : S?.machine.hostname ?? "";
  $("#eyebrow").hidden = view === "today";
}

addEventListener("hashchange", () => go(location.hash.slice(1)));

/* ---------------- theme and language ---------------- */
let theme = "auto";
try {
  theme = localStorage.getItem("cm-theme") || "auto";
} catch { /* storage blocked: follow the system */ }
function applyTheme() {
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  $("#theme-lbl").textContent = t(`theme.${theme}`);
  try {
    localStorage.setItem("cm-theme", theme);
  } catch { /* not remembered, still applied */ }
}
$("#theme-btn").addEventListener("click", () => {
  theme = theme === "auto" ? "dark" : theme === "dark" ? "light" : "auto";
  applyTheme();
});

/** Re-render every string: the static markup through data-i18n, the rest by drawing again. */
function applyLang() {
  applyI18n();
  $("#lang-lbl").textContent = langPref === "auto"
    ? `${t("lang.auto")} · ${lang().toUpperCase()}`
    : langPref.toUpperCase();
  $("#theme-lbl").textContent = t(`theme.${theme}`);
  setLive(liveState);
  if (CAT) renderCatalogSelect();
  if (SUM) renderState();
  // the rail can shrink to icons: each keeps its name as a tooltip
  $$("#nav a").forEach((a) => a.title = t(`nav.${a.dataset.v}`));
  askContext(ASK.kind, ASK.project);
  renderTitle();
  renderView();
  if (PL) renderPlugins();
  if (BRAIN) renderBrainAll();
  if (TK) renderTasks();
}
$("#lang-btn").addEventListener("click", () => {
  const order = ["auto", ...Object.keys(I18N)];
  langPref = order[(order.indexOf(langPref) + 1) % order.length];
  try {
    localStorage.setItem("cm-lang", langPref);
  } catch { /* not remembered, still applied */ }
  applyLang();
});

/* ---------------- command palette ---------------- */
const CMDS = () => [
  { s: "pal.goto", n: t("nav.today"), d: "today", f: () => go("today") },
  { s: "pal.goto", n: t("nav.tasks"), d: "tasks", f: () => go("tasks") },
  {
    s: "pal.do",
    n: t("tb.new"),
    d: "task",
    f: () => {
      go("tasks");
      $("#tb-new").click();
    },
  },
  { s: "pal.goto", n: t("nav.brain"), d: "brain", f: () => go("brain") },
  { s: "pal.goto", n: t("nav.connections"), d: "connections", f: () => go("connections") },
  ...TABS.map((x) => ({
    s: "pal.goto",
    n: `${t("nav.system")} · ${t(`sys.${x}`)}`,
    d: `system/${x}`,
    f: () => go(`system/${x}`),
  })),
  {
    s: "pal.run",
    n: t("cmd.health"),
    d: "doctor",
    f: () => {
      go("system/health");
      $("#rerun").click();
    },
  },
  { s: "pal.run", n: t("cmd.mcpSync"), d: "mcp sync", f: () => runAction("mcp-sync") },
  { s: "pal.run", n: t("cmd.mcpCheck"), d: "mcp check", f: () => runAction("mcp-check") },
  { s: "pal.run", n: t("cmd.fetch"), d: "sync --fetch", f: () => runAction("sync-fetch") },
  { s: "pal.run", n: t("cmd.installDry"), d: "install --dry-run", f: () => runAction("install-dry") },
  { s: "pal.run", n: t("cmd.install"), d: "install", f: () => runAction("install") },
  { s: "pal.run", n: t("cmd.updateCheck"), d: "update --check", f: () => runAction("update-check") },
  { s: "pal.run", n: t("cmd.updateNow"), d: "update --auto", f: () => runAction("update-now") },
  {
    s: "pal.do",
    n: t("cmd.addProfile"),
    d: "new",
    f: () => {
      go("system/profiles");
      openProfileForm(null);
    },
  },
  { s: "pal.do", n: t("cmd.theme"), d: "theme", f: () => $("#theme-btn").click() },
  { s: "pal.do", n: t("cmd.lang"), d: "language", f: () => $("#lang-btn").click() },
];

let pal = null, sel = 0, hits = [];
function openPal() {
  if (pal) return;
  const all = CMDS();
  hits = all;
  sel = 0;
  pal = document.createElement("div");
  pal.className = "pal-wrap";
  pal.innerHTML = `<div class="pal"><input placeholder="${esc(t("pal.ph"))}" aria-label="${
    esc(t("pal.ph"))
  }"><div class="pal-list"></div></div>`;
  document.body.appendChild(pal);
  const inp = $("input", pal);
  const paint = () => {
    let out = "", last = "";
    hits.forEach((c, i) => {
      if (c.s !== last) {
        out += `<div class="pal-sec">${esc(t(c.s))}</div>`;
        last = c.s;
      }
      out += `<div class="pal-i" data-i="${i}" data-sel="${i === sel ? 1 : 0}">
        <svg viewBox="0 0 24 24">${
        c.s === "pal.goto" ? `<path d="M5 12h14M13 6l6 6-6 6"/>` : `<path d="M8 6l6 6-6 6"/><path d="M15 18h4"/>`
      }</svg>
        ${esc(c.n)}<span class="d">${esc(c.d)}</span></div>`;
    });
    $(".pal-list", pal).innerHTML = out || `<div class="pal-sec">${esc(t("pal.none"))}</div>`;
    $(`[data-sel="1"]`, pal)?.scrollIntoView({ block: "nearest" });
  };
  paint();
  inp.addEventListener("input", () => {
    const q = inp.value.toLowerCase().trim();
    hits = q ? all.filter((c) => `${c.n} ${c.d} ${t(c.s)}`.toLowerCase().includes(q)) : all;
    sel = 0;
    paint();
  });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      sel = Math.min(sel + 1, hits.length - 1);
      paint();
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      sel = Math.max(sel - 1, 0);
      paint();
      e.preventDefault();
    } else if (e.key === "Enter" && hits[sel]) {
      const c = hits[sel];
      closePal();
      c.f();
    } else if (e.key === "Escape") closePal();
  });
  pal.addEventListener("click", (e) => {
    if (e.target === pal) return closePal();
    const it = e.target.closest("[data-i]");
    if (it) {
      const c = hits[+it.dataset.i];
      closePal();
      c.f();
    }
  });
  inp.focus();
}
function closePal() {
  pal?.remove();
  pal = null;
}
$("#pal-open").addEventListener("click", openPal);
addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    pal ? closePal() : openPal();
  }
});

/* ---------------- boot ---------------- */
// after every script of the page (brain.js and tasks.js come after this one) has run
addEventListener("DOMContentLoaded", async () => {
  applyTheme();
  applyLang();
  askContext("ask");
  void loadClaude();
  OWNER = await api("/api/owner").catch(() => OWNER); // before the tasks draw: it says which are "mine"
  go(location.hash.slice(1)); // what needs no status report draws now
  try {
    await loadStatus();
    renderView();
  } catch (e) {
    renderState();
    toast(t("err.server", { e: e.message }), true);
  }
  connect();
  // The heartbeat also tells the page the connection is genuinely alive: if nothing arrives for
  // well over the server's 25s ping, the stream is dead even though EventSource still says open.
  setInterval(() => {
    if (es && es.readyState === 1 && lastEvent && Date.now() - lastEvent > 70000) {
      setLive("down");
      connect();
    }
  }, 15000);
});

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
let SUM = null; // last /api/summary payload
let view = "today";
let sub = "profiles"; // the System tab

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
let es = null, lastEvent = 0, esRetry = 0, liveState = "busy";
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
  es.addEventListener("usage", (e) => {
    lastEvent = Date.now();
    // the event names the sessions that just wrote: light those up now, redraw the rest later
    try {
      for (const id of JSON.parse(e.data).sessions ?? []) markWorking(id);
    } catch { /* an event without a body is still a change */ }
    onChange("usage");
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
async function loadStatus() {
  [S, SUM] = await Promise.all([api("/api/status"), api("/api/summary")]);
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
  if (!S) return;
  if (view === "today") renderToday();
  if (view === "connections") renderConnections();
  if (view === "brain" && !BRAIN) loadBrain().catch((e) => toast(e.message, true));
  if (view === "system") {
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
  const extra = [
    SUM?.staged ? t("status.staged", { v: SUM.staged }) : null,
    SUM?.warns.length ? t("status.warns", { n: SUM.warns.length }) : null,
  ].filter(Boolean).map((x) => `<div class="sub">${esc(x)}</div>`).join("");
  if (level === "fail") {
    box.innerHTML = `<i></i><div><b>${esc(t("status.fail"))}</b><ul>${
      SUM.fails.map((f) => `<li>${esc(f)}</li>`).join("")
    }</ul>${extra}</div><a class="btn" href="#system/health">${esc(t("status.open"))}</a>`;
  } else {
    box.innerHTML = `<i></i><div><b>${esc(t("status.ok"))}</b><div class="sub">${esc(t("status.ok.sub"))}</div>${extra}</div>`;
  }
  renderRunning();
  loadResume();
}

/** Sessions seen writing recently. A row stays "working" for a few seconds after its last write,
 *  because a session pauses between turns and flickering would be worse than a short lag. */
const working = new Map();
const WORKING_MS = 12000;
const workingLabel = () => `<span class="dots"><i></i><i></i><i></i></span>${esc(t("run.working"))}`;

function markWorking(id) {
  working.set(id, Date.now());
  const row = document.querySelector(`#running [data-session="${CSS.escape(id)}"]`);
  if (row && !row.classList.contains("busy")) {
    // Light it up now rather than waiting for the debounced redraw: the event arrived because that
    // session just wrote, and a lit border next to the word "idle" reads as a bug.
    row.classList.add("busy");
    const state = row.querySelector(".state");
    if (state) state.innerHTML = workingLabel();
  }
  clearTimeout(markWorking[id]);
  markWorking[id] = setTimeout(() => {
    working.delete(id);
    const row = document.querySelector(`#running [data-session="${CSS.escape(id)}"]`);
    if (!row) return;
    row.classList.remove("busy");
    const state = row.querySelector(".state");
    if (state) state.textContent = t("run.idle", { d: dur(new Date(Date.now() - WORKING_MS).toISOString()) });
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
  $("#run-n").textContent = active
    ? t("run.countBusy", { w: active, c: cli.length, d: desk.length })
    : t("run.count", { c: cli.length, d: desk.length });
  const el = $("#running");
  if (!cli.length && !desk.length) {
    el.innerHTML = `<div class="sub">${esc(t("today.nothing"))}</div>`;
    return;
  }
  // Several sessions of one profile are the normal case with Desktop tabs, and profile plus
  // directory is not enough to tell them apart: model and session id are.
  el.innerHTML = `<div class="runlist">` +
    cli.map((c) => {
      const busy = isWorking(c.session, c.lastActivity);
      return `<div class="run${busy ? " busy" : ""}" ${c.session ? `data-session="${esc(c.session)}"` : ""} title="pid ${c.pid}${
        c.cwd ? ` · ${esc(c.cwd)}` : ""
      }">
        <div class="run-top">
          <span class="chip on">${esc(c.profile ?? "?")}</span>
          <b>${esc(c.cwd ? c.cwd.split("/").filter(Boolean).pop() : "—")}</b>
          <span class="state">${busy ? workingLabel() : c.lastActivity ? esc(t("run.idle", { d: dur(c.lastActivity) })) : ""}</span>
        </div>
        <div class="run-bot">
          <span class="run-model">${esc(c.model ? modelShort(c.model) : "")}</span>
          <span class="run-meta">${esc(t(c.embedded ? "run.desktop" : "run.terminal"))}${c.session ? ` · ${esc(c.session.slice(0, 8))}` : ""}</span>
        </div>
        <span class="run-scan"></span>
      </div>`;
    }).join("") +
    desk.map((d) =>
      `<div class="run static" title="pid ${d.pid}">
      <div class="run-top"><span class="chip">${esc(d.variant)}</span><b>${esc(t("run.desktopApp"))}</b></div>
      <div class="run-bot"><span class="run-meta">${esc(t("run.window"))}</span></div>
    </div>`
    ).join("") +
    `</div>`;
}

/** The last sessions, one per directory, each with the command that reopens it. A busy session
    writes every second: the list is re-read at most every 15 s. */
let RESUME = [], resumeAt = 0;
async function loadResume(force = false) {
  if (!force && Date.now() - resumeAt < 15000) return renderResume();
  resumeAt = Date.now();
  try {
    const rows = await api("/api/sessions?" + new URLSearchParams({ since: "7d", limit: "40" }));
    const seen = new Set();
    RESUME = rows.filter((r) => r.cwd && !seen.has(r.cwd) && seen.add(r.cwd)).slice(0, 6);
  } catch { /* the panel stays as it was */ }
  renderResume();
}

function resumeCommand(r) {
  const cmd = S?.profiles[r.profile]?.manifest.command ?? `claude-${r.profile}`;
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return `cd ${q(r.cwd)} && ${cmd} --resume ${r.session_id}`;
}

function renderResume() {
  const el = $("#resume");
  if (!RESUME.length) {
    el.innerHTML = `<div class="panel-b sub">${esc(t("today.noResume"))}</div>`;
    return;
  }
  el.innerHTML = RESUME.map((r, i) =>
    `<div class="resume-row">
      <span class="chip">${esc(r.profile)}</span>
      <b title="${esc(r.cwd)}">${esc(r.project)}</b>
      <span class="when">${esc(ago(r.ended))}</span>
      <button class="btn sm" data-resume="${i}">${esc(t("today.copy"))}</button>
    </div>`
  ).join("");
}

$("#resume").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-resume]");
  if (!b) return;
  const cmd = resumeCommand(RESUME[+b.dataset.resume]);
  try {
    await navigator.clipboard.writeText(cmd);
    toast(t("today.copied"));
  } catch {
    toast(t("today.copyFailed", { cmd }), true);
  }
});

/* ---------------- brain ---------------- */
const GROUPS = ["projects", "references", "concepts", "skills", "entities", "synthesis", "journal"];
const groupOf = (g) => GROUPS.includes(g) ? g : "other";
let BRAIN = null, bSel = null, bPos = new Map(), bView = null;

async function loadBrain() {
  BRAIN = await api("/api/brain");
  const deg = new Map();
  for (const [a, b] of BRAIN.links) {
    deg.set(a, (deg.get(a) ?? 0) + 1);
    deg.set(b, (deg.get(b) ?? 0) + 1);
  }
  for (const p of BRAIN.pages) p.deg = deg.get(p.path) ?? 0;
  layoutBrain();
  renderBrain();
}

/** A force layout, run once per change of the page set: a hundred nodes settle in a few hundred
    steps, well under a frame budget. Known pages keep their place, so a new one does not reshuffle
    the whole picture. */
function layoutBrain() {
  const nodes = BRAIN.pages;
  const idx = new Map(nodes.map((n, i) => [n.path, i]));
  const P = nodes.map((n, i) => {
    const old = bPos.get(n.path);
    if (old) return { ...old };
    const a = (GROUPS.indexOf(groupOf(n.group)) + 1) / (GROUPS.length + 1) * Math.PI * 2 + i * 0.01;
    return { x: Math.cos(a) * 200 + (Math.random() - 0.5) * 40, y: Math.sin(a) * 200 + (Math.random() - 0.5) * 40 };
  });
  const E = BRAIN.links.map(([a, b]) => [idx.get(a), idx.get(b)]).filter(([a, b]) => a != null && b != null);
  const fresh = nodes.some((n) => !bPos.has(n.path));
  for (let step = 0, steps = fresh ? 350 : 60; step < steps; step++) {
    const t = 1 - step / steps;
    const F = P.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < P.length; i++) {
      for (let j = i + 1; j < P.length; j++) {
        let dx = P[i].x - P[j].x, dy = P[i].y - P[j].y;
        const d2 = Math.max(dx * dx + dy * dy, 25), f = 2200 / d2, d = Math.sqrt(d2);
        dx /= d; dy /= d;
        F[i].x += dx * f; F[i].y += dy * f; F[j].x -= dx * f; F[j].y -= dy * f;
      }
    }
    for (const [a, b] of E) {
      const dx = P[b].x - P[a].x, dy = P[b].y - P[a].y, d = Math.sqrt(dx * dx + dy * dy) || 1, f = (d - 55) * 0.04;
      F[a].x += dx / d * f; F[a].y += dy / d * f; F[b].x -= dx / d * f; F[b].y -= dy / d * f;
    }
    for (let i = 0; i < P.length; i++) {
      F[i].x -= P[i].x * 0.012; F[i].y -= P[i].y * 0.012;
      const m = Math.min(12 * t + 1, Math.hypot(F[i].x, F[i].y)) / (Math.hypot(F[i].x, F[i].y) || 1);
      P[i].x += F[i].x * m; P[i].y += F[i].y * m;
    }
  }
  bPos = new Map(nodes.map((n, i) => [n.path, P[i]]));
  if (!bView) {
    const xs = P.map((p) => p.x), ys = P.map((p) => p.y), pad = 40;
    const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
    bView = { x: x0, y: y0, w: Math.max(...xs) + pad - x0, h: Math.max(...ys) + pad - y0 };
  }
}

function brainMatches() {
  const q = $("#b-q").value.trim().toLowerCase();
  if (!q) return null;
  return new Set(BRAIN.pages.filter((p) => `${p.title} ${p.path} ${p.summary} ${p.tags.join(" ")}`.toLowerCase().includes(q)).map((p) => p.path));
}

function renderBrain() {
  if (!BRAIN) return;
  const svg = $("#graph");
  svg.setAttribute("viewBox", `${bView.x} ${bView.y} ${bView.w} ${bView.h}`);
  const hits = brainMatches();
  const near = new Set(bSel ? [bSel] : []);
  if (bSel) for (const [a, b] of BRAIN.links) { if (a === bSel) near.add(b); if (b === bSel) near.add(a); }
  const focus = hits ?? (bSel ? near : null);
  const r = (p) => 3 + Math.sqrt(p.deg) * 1.7;
  const top = new Set([...BRAIN.pages].sort((a, b) => b.deg - a.deg).slice(0, 10).map((p) => p.path));
  const pos = (path) => bPos.get(path);
  svg.innerHTML =
    BRAIN.links.map(([a, b]) => {
      const A = pos(a), B = pos(b);
      const hot = bSel && (a === bSel || b === bSel);
      const dim = focus && !(focus.has(a) && focus.has(b)) && !hot;
      return `<line x1="${A.x.toFixed(1)}" y1="${A.y.toFixed(1)}" x2="${B.x.toFixed(1)}" y2="${B.y.toFixed(1)}" class="${hot ? "hot" : ""}${dim ? " dim" : ""}"/>`;
    }).join("") +
    BRAIN.pages.map((p) => {
      const P = pos(p.path), dim = focus && !focus.has(p.path);
      return `<circle cx="${P.x.toFixed(1)}" cy="${P.y.toFixed(1)}" r="${r(p).toFixed(1)}" fill="var(--g-${groupOf(p.group)})" data-node="${esc(p.path)}" class="${p.path === bSel ? "sel" : ""}${dim ? " dim" : ""}"><title>${esc(p.title)}</title></circle>`;
    }).join("") +
    BRAIN.pages.filter((p) => (focus ? focus.has(p.path) && (focus.size <= 25 || top.has(p.path)) : top.has(p.path)) || p.path === bSel).map((p) => {
      const P = pos(p.path);
      return `<text x="${(P.x + r(p) + 3).toFixed(1)}" y="${(P.y + 3).toFixed(1)}">${esc(short(p.title, 34))}</text>`;
    }).join("");
  $("#b-sum").textContent = t("brain.sum", { p: BRAIN.pages.length, l: BRAIN.links.length });
  $("#b-hits").innerHTML = hits
    ? [...hits].slice(0, 8).map((h) => `<button class="chip" data-node="${esc(h)}">${esc(short(BRAIN.pages.find((p) => p.path === h).title, 40))}</button>`).join("") +
      (hits.size > 8 ? `<span class="sub">+${hits.size - 8}</span>` : "") + (hits.size ? "" : `<span class="sub">${esc(t("cat.nothing"))}</span>`)
    : "";
  const present = new Set(BRAIN.pages.map((p) => groupOf(p.group)));
  $("#b-legend").innerHTML = [...GROUPS, "other"].filter((g) => present.has(g))
    .map((g) => `<span><i style="background:var(--g-${g})"></i>${esc(t(`brain.g.${g}`))}</span>`).join("");
  renderBrainPage();
  renderInbox();
}

function renderBrainPage() {
  const el = $("#b-page");
  const p = bSel && BRAIN.pages.find((x) => x.path === bSel);
  if (!p) {
    el.innerHTML = `<div class="panel-b sub">${esc(t("brain.pick"))}</div>`;
    return;
  }
  const out = BRAIN.links.filter(([a]) => a === p.path).map(([, b]) => b);
  const inn = BRAIN.links.filter(([, b]) => b === p.path).map(([a]) => a);
  const linkList = (xs) => xs.map((x) => `<button data-node="${esc(x)}">${esc(x.split("/").pop())}</button>`).join("");
  const vault = BRAIN.root.split("/").pop();
  el.innerHTML = `<div class="panel-b">
    <span class="sub">${esc(p.path)}</span>
    <h2>${esc(p.title)}</h2>
    ${p.summary ? `<p class="sub" style="margin:0;color:var(--fg)">${esc(p.summary)}</p>` : ""}
    <div class="sub">${esc([p.category, p.lifecycle, p.updated].filter(Boolean).join(" · "))}</div>
    ${out.length || inn.length ? `<div class="b-links">${linkList([...new Set([...out, ...inn])])}</div>` : ""}
    <div style="display:flex;gap:8px;padding-top:4px">
      <button class="btn" data-read="${esc(p.path)}">${esc(t("brain.read"))}</button>
      <a class="btn" href="obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(p.path)}">${esc(t("brain.obsidian"))}</a>
    </div>
  </div>`;
}

function renderInbox() {
  const items = BRAIN.inbox;
  const cmd = "/wiki-ingest process my drafts";
  $("#b-inbox").innerHTML = items.length
    ? `<div class="b-inbox"><b>${esc(t("brain.inbox", { n: items.length }))}</b>
      ${items.slice(0, 8).map((f) => `<code title="${esc(f.name)}">${esc(f.name)}</code>`).join("")}
      <span class="sub">${esc(t("brain.inbox.how"))}</span>
      <div class="b-cmd"><code>${esc(cmd)}</code><button class="btn sm" data-copy="${esc(cmd)}">${esc(t("today.copy"))}</button></div></div>`
    : "";
}

/** Markdown to HTML for the reader: escaped first, then a handful of forms. Wikilinks become
    buttons into the graph; external links open outside. Enough to read a wiki page, no more. */
function mdToHtml(src) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, target, label) => `<a data-page="${target.trim()}">${label ?? target.trim().split("/").pop()}</a>`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = false, code = null, table = null;
  const flush = () => {
    if (list) { out.push("</ul>"); list = false; }
    if (table) { out.push(`<table>${table.join("")}</table>`); table = null; }
  };
  for (const line of src.split("\n")) {
    if (code !== null) {
      if (line.startsWith("```")) { out.push(`<pre>${esc(code.join("\n"))}</pre>`); code = null; } else code.push(line);
      continue;
    }
    if (line.startsWith("```")) { flush(); code = []; continue; }
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (li) { if (!list) { flush(); out.push("<ul>"); list = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (/^\|.*\|\s*$/.test(line)) {
      if (/^\|[\s:|-]+\|\s*$/.test(line)) continue;
      if (!table) { flush(); table = []; }
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

async function readPage(path) {
  const host = drawer(path, `<div class="md">${esc(t("pl.loading"))}</div>`);
  try {
    const page = await api(`/api/brain/page?path=${encodeURIComponent(path)}`);
    $(".md", host).innerHTML = mdToHtml(page.body);
  } catch (e) {
    $(".md", host).textContent = e.message;
  }
  host.addEventListener("click", (e) => {
    const a = e.target.closest("[data-page]");
    if (!a) return;
    const target = BRAIN.pages.find((p) => p.path === a.dataset.page) ?? BRAIN.pages.find((p) => p.path.split("/").pop() === a.dataset.page);
    if (target) { host.remove(); selectNode(target.path); readPage(target.path); }
  });
}

function selectNode(path) {
  bSel = bSel === path ? null : path;
  renderBrain();
}

async function sendToInbox(body, headers = {}) {
  const r = await api("/api/brain/inbox", { method: "POST", headers: { "x-claude-multi": "1", ...headers }, body }).catch((e) => ({ ok: false, message: e.message }));
  toast(r.ok ? t("brain.added", { n: r.message }) : r.message, !r.ok);
  return r.ok;
}
async function sendFiles(files) {
  for (const f of files) await sendToInbox(f, { "x-filename": encodeURIComponent(f.name) });
  await loadBrain();
}

// the graph: click selects, drag pans, wheel zooms around the pointer
{
  const svg = $("#graph");
  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    if (e.target.closest("[data-node]")) return;
    drag = { x: e.clientX, y: e.clientY, v: { ...bView } };
    svg.classList.add("panning");
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const k = bView.w / svg.clientWidth;
    bView = { ...drag.v, x: drag.v.x - (e.clientX - drag.x) * k, y: drag.v.y - (e.clientY - drag.y) * k };
    svg.setAttribute("viewBox", `${bView.x} ${bView.y} ${bView.w} ${bView.h}`);
  });
  const end = () => { drag = null; svg.classList.remove("panning"); };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const f = e.deltaY > 0 ? 1.12 : 1 / 1.12, rect = svg.getBoundingClientRect();
    const px = bView.x + (e.clientX - rect.left) / rect.width * bView.w, py = bView.y + (e.clientY - rect.top) / rect.height * bView.h;
    bView = { x: px - (px - bView.x) * f, y: py - (py - bView.y) * f, w: bView.w * f, h: bView.h * f };
    svg.setAttribute("viewBox", `${bView.x} ${bView.y} ${bView.w} ${bView.h}`);
  }, { passive: false });
}
document.addEventListener("click", (e) => {
  if (view !== "brain") return;
  const n = e.target.closest("[data-node]");
  if (n) return selectNode(n.dataset.node);
  const rd = e.target.closest("[data-read]");
  if (rd) return readPage(rd.dataset.read);
  const cp = e.target.closest("[data-copy]");
  if (cp) navigator.clipboard.writeText(cp.dataset.copy).then(() => toast(t("today.copied")), () => toast(cp.dataset.copy, true));
});
let bqTimer = null;
$("#b-q").addEventListener("input", () => { clearTimeout(bqTimer); bqTimer = setTimeout(renderBrain, 120); });
{
  const zone = $("#b-zone");
  $("#b-file").addEventListener("change", (e) => { sendFiles([...e.target.files]); e.target.value = ""; });
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); sendFiles([...e.dataTransfer.files]); });
}
$("#b-link").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (await sendToInbox(JSON.stringify({ kind: "link", url: e.target.elements.url.value.trim() }), { "content-type": "application/json" })) { e.target.reset(); loadBrain(); }
});
$("#b-note").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (await sendToInbox(JSON.stringify({ kind: "note", text: e.target.elements.text.value }), { "content-type": "application/json" })) { e.target.reset(); loadBrain(); }
});

/* ---------------- connections ---------------- */
let ACC = null;
async function loadAccounts() {
  ACC = await api("/api/accounts");
  renderAccounts();
}

function renderAccounts() {
  if (!ACC) return;
  const v = ACC.vault, box = $("#vault");
  // the vault only speaks up when something is to be done on this machine
  const msg = v.state === "wrong-key" ? ["fail", t("vault.wrongKey")]
    : v.state === "no-key" ? ["update", t(v.initialised ? "vault.pair" : "vault.init")]
    : v.conflicts ? ["update", t("vault.conflicts", { n: v.conflicts })]
    : null;
  box.hidden = !msg;
  if (msg) {
    box.className = "status-card " + msg[0];
    box.innerHTML = `<i></i><div><b>${esc(t("vault.title"))}</b><div class="sub">${esc(msg[1])}</div><div class="sub"><code>${
      esc(v.dir)
    }</code></div></div>`;
  }
  $("#acc-sum").textContent = t("acc.sum", { n: ACC.accounts.length });
  $("#acc-rows").innerHTML = ACC.accounts.map((a, i) =>
    `<tr>
      <td><b>${esc(a.service)}</b></td>
      <td><code>${esc(a.name)}</code></td>
      <td>${esc(a.url ?? "—")}</td>
      <td>${a.profiles ? a.profiles.map((p) => `<span class="chip on">${esc(p)}</span>`).join(" ") : `<span class="sub">${esc(t("acc.allProfiles"))}</span>`}</td>
      <td>${a.hasSecret ? `<span class="ok-t">${esc(t("acc.hasSecret"))}</span>` : `<span class="warn-t">${esc(t("acc.noSecret"))}</span>`}</td>
      <td class="acts"><button class="btn sm" data-acc-edit="${i}">${esc(t("profile.edit"))}</button></td>
    </tr>`
  ).join("") || `<tr><td class="empty" colspan="6">${esc(t("acc.none"))}</td></tr>`;
}

/** The account form, in the drawer: `i` null for a new one. The secret field is never filled in:
    the page never receives a secret, it only sends one. */
function openAccountForm(i) {
  const a = i == null ? null : ACC.accounts[i];
  const field = (label, input, hint = "") => `<label class="fld">${esc(label)}${hint ? ` <small>${esc(hint)}</small>` : ""}${input}</label>`;
  const host = drawer(
    a ? `${a.service}/${a.name}` : t("acc.new"),
    `<form class="pform" id="aform">
      ${
      field(t("acc.service"), a
        ? `<input name="service" value="${esc(a.service)}" readonly>`
        : `<select name="service" class="sel" style="font-size:14px;padding:8px">${ACC.services.map((sv) => `<option>${esc(sv)}</option>`).join("")}</select>`)
    }
      ${field(t("acc.name"), `<input name="name" required pattern="[a-z][a-z0-9_-]{0,30}" value="${esc(a?.name ?? "")}" ${a ? "readonly" : ""} placeholder="ark">`, t("acc.name.hint"))}
      ${field(t("acc.url"), `<input name="url" value="${esc(a?.url ?? "")}" placeholder="https://…">`)}
      <div class="fld">${esc(t("conn.profiles"))} <small>${esc(t("acc.profiles.hint"))}</small><div class="chips">${
      ACC.profiles.map((p) =>
        `<button type="button" class="chip pick${a?.profiles?.includes(p) ? " on" : ""}" data-pick="${esc(p)}" aria-pressed="${!!a?.profiles?.includes(p)}">${esc(p)}</button>`
      ).join("")
    }</div></div>
      ${field(t("acc.secret"), `<input name="secret" type="password" autocomplete="off" ${a ? "" : "required"} placeholder="${esc(t(a ? "acc.secret.keep" : "acc.secret.ph"))}">`, t("acc.secret.hint"))}
      <div class="pform-foot">
        <button class="btn primary" type="submit">${esc(t("profile.save"))}</button>
        ${a ? `<button class="btn ghost danger" type="button" data-acc-del>${esc(t("pl.remove"))}</button>` : ""}
        <button class="btn ghost" type="button" data-close>${esc(t("profile.cancel"))}</button>
      </div>
    </form>`,
  );
  const f = $("#aform", host);
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
    toast(r.message, !r.ok);
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
document.addEventListener("click", (e) => {
  const ed = e.target.closest("[data-acc-edit]");
  if (ed) openAccountForm(+ed.dataset.accEdit);
});

function renderConnections() {
  loadAccounts().catch((e) => toast(e.message, true));
  const reg = S.shared.mcpRegistry ?? {};
  const names = Object.keys(reg);
  $("#conn-rows").innerHTML = names.map((n) => {
    const r = reg[n];
    // what the registry promises against what each profile actually mounted at its last sync
    const missing = r.profiles.filter((p) => {
      const info = S.profiles[p];
      if (!info) return false;
      return (r.surfaces.includes("cli") && !info.mcp.includes(n)) ||
        (r.surfaces.includes("desktop") && S.machine.desktopVersion && !info.mcpDesktop.includes(n));
    });
    return `<tr>
      <td><b>${esc(n)}</b></td>
      <td>${r.profiles.map((p) => `<span class="chip on">${esc(p)}</span>`).join(" ")}</td>
      <td>${esc(r.surfaces.map((s) => s === "cli" ? "CLI" : "Desktop").join(" · "))}</td>
      <td>${
      missing.length
        ? `<span class="warn-t">${esc(t("conn.missing", { p: missing.join(", ") }))}</span>`
        : `<span class="ok-t">${esc(t("conn.mounted"))}</span>`
    }</td>
    </tr>`;
  }).join("") || `<tr><td class="empty" colspan="4">${esc(t("conn.empty"))}</td></tr>`;
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
      p.mcp.length ? p.mcp.map((m) => `<span class="chip on">${esc(m)}</span>`).join("") : `<small>${esc(t("profile.noMcp"))}</small>`
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
      isNew ? field(t("profile.name"), `<input name="name" required pattern="[a-z][a-z0-9_-]{1,30}" placeholder="research" autofocus>`) : ""
    }
      ${field(t("profile.description"), `<input name="description" value="${esc(m.description ?? "")}" placeholder="${esc(t("profile.description.ph"))}">`)}
      ${field(t("profile.command"), `<input name="command" value="${esc(m.command ?? "")}" placeholder="claude-${esc(name || "research")}">`)}
      ${field(t("profile.alias"), `<input name="alias" value="${esc(m.alias ?? "")}" pattern="[a-zA-Z_][a-zA-Z0-9_-]*" placeholder="cr">`)}
      ${field(t("profile.desktop"), `<input name="desktopDir" value="${esc(m.desktopDir ?? "")}" placeholder="~/.config/Claude-Research">`)}
      <div class="fld">MCP<div class="chips">${
      Object.keys(reg).map((s) =>
        `<button type="button" class="chip pick${picked.has(s) ? " on" : ""}" data-pick="${esc(s)}" aria-pressed="${picked.has(s)}">${esc(s)}</button>`
      ).join("") || `<small>${esc(t("profile.registryEmpty"))}</small>`
    }</div></div>
      <label class="fld check"><input type="checkbox" name="disableAccountMcp"${m.disableAccountMcp ? " checked" : ""}> ${
      esc(t("profile.disableAccountMcp"))
    }</label>
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
async function loadPermissions() {
  PERM = await api("/api/permissions");
  renderPermissions();
}

function renderPermissions() {
  if (!PERM) return;
  $("#perm-mode").value = PERM.mode;
  $("#perm-lists").innerHTML = ["allow", "ask", "deny"].map((l) =>
    `<section class="panel perm-list">
      <div class="panel-h"><h3>${esc(t(`perm.${l}`))}</h3><span class="r">${PERM.rules[l].length}</span></div>
      <div class="panel-b">
        <span class="sub">${esc(t(`perm.${l}.what`))}</span>
        ${PERM.rules[l].map((r) => `<div class="perm-rule"><code>${esc(r)}</code><button data-perm-rm="${esc(l)}" data-rule="${esc(r)}" aria-label="${esc(t("pl.remove"))}">×</button></div>`).join("") || `<span class="sub">—</span>`}
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
        ${Object.keys(v.lists).length ? `<button class="btn sm" data-perm-promote="${esc(p)}">${esc(t("perm.promote"))}</button>` : ""}</div>
      <div class="panel-b">
        ${v.mode ? `<div>${esc(t("perm.mode"))}: <code>${esc(v.mode)}</code></div>` : ""}
        ${Object.entries(v.lists).map(([l, d]) => `<div><b>${esc(t(`perm.${l}`))}</b>
          ${d.added.length ? `<div class="sub">${esc(t("perm.added"))}: ${d.added.map((r) => `<code>${esc(r)}</code>`).join(" · ")}</div>` : ""}
          ${d.dropped.length ? `<div class="sub">${esc(t("perm.dropped"))}: ${d.dropped.map((r) => `<code>${esc(r)}</code>`).join(" · ")}</div>` : ""}
        </div>`).join("")}
      </div>
    </section>`
  ).join("");
}

async function permOp(body) {
  const r = await post("/api/permissions", body).catch((e) => ({ ok: false, message: e.message }));
  toast(r.message, !r.ok);
  if (r.ok) await loadPermissions();
}
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
  if (pr && confirm(t("perm.promote.confirm", { p: pr.dataset.permPromote }))) permOp({ op: "promote", profile: pr.dataset.permPromote });
});

/* ---------------- updates ---------------- */
function renderUpdates() {
  const m = S.machine;
  const u = S.update ?? {};
  const card = (name, current, lines, rollback) =>
    `<div class="vcard"><i></i><div style="flex:1;min-width:0"><b>${esc(name)}</b><code>${esc(current ?? "—")}</code>
      ${lines.filter(Boolean).map((l) => `<div class="sub">${esc(l)}</div>`).join("")}</div>${
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
  );
  $("#embedded").textContent = Object.entries(m.embeddedCode ?? {})
    .map(([v, vs]) => t("up.embedded", { v, vs: vs.join(", ") })).join(" · ");
  const when = (iso) => new Date(iso).toLocaleString(lang(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  $("#uplog").innerHTML = (S.updateLog ?? []).map((e) => {
    const bad = e.event === "failed" || e.event === "verify-failed";
    return `<div class="log-row${bad ? " bad" : ""}">
      <span class="when">${esc(when(e.at))}</span>
      <span>${esc(e.component === "cli" ? "Claude Code" : "Claude Desktop")}</span>
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
      <div class="dh"><h3>${esc(title)}</h3><button class="x" data-close aria-label="${esc(t("close"))}">×</button></div>
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
function renderHealth(checks) {
  const order = { fail: 0, warn: 1, ok: 2 };
  const sorted = [...checks].sort((a, b) => order[a.status] - order[b.status]);
  const sym = { ok: "✓", warn: "!", fail: "✕", run: "◠" };
  $("#checks").innerHTML = sorted.map((c) =>
    `<div class="chk">
      <span class="ic ${c.status}">${c.status === "run" ? `<span class="spin">◠</span>` : sym[c.status]}</span>
      <div><div class="name">${esc(c.id)}</div><div class="msg">${esc(c.msg)}</div></div>
      ${c.fix && c.status !== "ok" ? actionButton(c.fix) : "<span></span>"}
    </div>`
  ).join("");
  const n = (s) => checks.filter((c) => c.status === s).length;
  $("#hsum").textContent = t("health.sum", { ok: n("ok"), w: n("warn"), f: n("fail") });
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
};
function actionButton(fix) {
  const act = FIX_ACTIONS[fix.trim()];
  return act
    ? `<button class="fix" data-action="${esc(act)}">${esc(fix)}</button>`
    : `<code class="fix" style="cursor:text;background:none;border-color:var(--line);color:var(--fg-faint)" title="${
      esc(fix)
    }">${esc(short(fix, 40))}</code>`;
}

$("#rerun").addEventListener("click", async () => {
  const btn = $("#rerun");
  btn.disabled = true;
  // stream the re-run: mark everything pending, then swap in the fresh verdicts
  renderHealth(S.doctor.map((c) => ({ ...c, status: "run", msg: t("health.checking"), fix: null })));
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
  $("#pl-sum").textContent = t("pl.sum", { n: rows.length, i: inst }) + (broken ? t("pl.sumBroken", { b: broken }) : "");
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
      <td>${
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
  $("#cat-sum").textContent = t("cat.sum", { n: hits.length, t: CAT.length });
  const profs = PL?.profiles ?? [];
  const where = (id) => profs.filter((p) => PL?.plugins.find((r) => r.id === id)?.profiles[p]?.installed);
  $("#cat-rows").innerHTML = hits.slice(0, 80).map((c) => {
    const w = where(c.id);
    return `<tr>
      <td class="cdesc"><span class="pname">${esc(c.name)}</span> <span class="dim">${esc(c.marketplace)}${
      c.installs ? ` · ${esc(t("cat.installs", { n: fmt(c.installs) }))}` : ""
    }</span>
        <div class="desc">${esc(short(c.description, 220))}</div></td>
      <td>${
      w.length
        ? `<span class="chip on" title="${esc(t("cat.installedOn", { p: w.join(", ") }))}">${w.length}/${profs.length}</span>`
        : ""
    }</td>
      <td class="acts">
        ${w.length ? `<button class="btn ghost sm" data-pl-details="${esc(c.id)}">${esc(t("pl.details"))}</button>` : ""}
        <select class="sel" data-cat-scope="${esc(c.id)}"><option value="all">${esc(t("cat.allProfiles"))}</option>${
      profs.map((p) => `<option>${esc(p)}</option>`).join("")
    }</select>
        <button class="btn sm" data-cat-install="${esc(c.id)}">${esc(t("pl.install"))}</button>
      </td>
    </tr>`;
  }).join("") || `<tr><td class="empty">${esc(t("cat.nothing"))}</td></tr>`;
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
        ? { op: "install", id: body.id, profiles: body.target === "shared" ? "all" : [body.target], accept: r.confirm.sha256 }
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
    return plOp({ op: "marketplace-update", name: mu.dataset.mkUpdate }, t("pl.opUpdating", { id: mu.dataset.mkUpdate }))
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
$("#cat-q").addEventListener("input", () => {
  clearTimeout(catTimer);
  catTimer = setTimeout(renderCatalog, 120);
});
$("#cat-mk").addEventListener("change", renderCatalog);

/* ---------------- navigation ---------------- */
// #today · #connections · #system/<tab>. The tray opens a view by setting the hash.
const VIEWS = ["today", "brain", "connections", "system"];
const TABS = ["profiles", "permissions", "plugins", "updates", "health"];

function go(hash) {
  const [v, s] = String(hash).split("/");
  view = VIEWS.includes(v) ? v : "today";
  if (view === "system") sub = TABS.includes(s) ? s : sub;
  const want = view === "system" ? `system/${sub}` : view;
  if (location.hash.slice(1) !== want) history.replaceState(null, "", `#${want}`);

  $$("#nav a").forEach((a) => a.toggleAttribute("aria-current", a.dataset.v === view));
  $$("#nav a[aria-current]").forEach((a) => a.setAttribute("aria-current", "page"));
  $$(".view").forEach((el) => el.hidden = el.id !== `v-${view}`);
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
  $("#title").textContent = t(`title.${view}`);
  $("#eyebrow").textContent = view === "today"
    ? new Date().toLocaleDateString(lang(), { weekday: "long", day: "numeric", month: "long" })
    : S?.machine.hostname ?? "";
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
  $("#lang-lbl").textContent = langPref === "auto" ? `${t("lang.auto")} · ${lang().toUpperCase()}` : langPref.toUpperCase();
  $("#theme-lbl").textContent = t(`theme.${theme}`);
  setLive(liveState);
  if (CAT) renderCatalogSelect();
  if (SUM) renderState();
  renderTitle();
  renderView();
  if (PL) renderPlugins();
  if (BRAIN) renderBrain();
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
  { s: "pal.goto", n: t("nav.brain"), d: "brain", f: () => go("brain") },
  { s: "pal.goto", n: t("nav.connections"), d: "connections", f: () => go("connections") },
  ...TABS.map((x) => ({ s: "pal.goto", n: `${t("nav.system")} · ${t(`sys.${x}`)}`, d: `system/${x}`, f: () => go(`system/${x}`) })),
  { s: "pal.run", n: t("cmd.health"), d: "doctor", f: () => { go("system/health"); $("#rerun").click(); } },
  { s: "pal.run", n: t("cmd.mcpSync"), d: "mcp sync", f: () => runAction("mcp-sync") },
  { s: "pal.run", n: t("cmd.mcpCheck"), d: "mcp check", f: () => runAction("mcp-check") },
  { s: "pal.run", n: t("cmd.fetch"), d: "sync --fetch", f: () => runAction("sync-fetch") },
  { s: "pal.run", n: t("cmd.installDry"), d: "install --dry-run", f: () => runAction("install-dry") },
  { s: "pal.run", n: t("cmd.install"), d: "install", f: () => runAction("install") },
  { s: "pal.run", n: t("cmd.updateCheck"), d: "update --check", f: () => runAction("update-check") },
  { s: "pal.run", n: t("cmd.updateNow"), d: "update --auto", f: () => runAction("update-now") },
  { s: "pal.do", n: t("cmd.addProfile"), d: "new", f: () => { go("system/profiles"); openProfileForm(null); } },
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
(async () => {
  applyTheme();
  applyLang();
  try {
    await loadStatus();
  } catch (e) {
    renderState();
    toast(t("err.server", { e: e.message }), true);
  }
  go(location.hash.slice(1));
  connect();
  // The heartbeat also tells the page the connection is genuinely alive: if nothing arrives for
  // well over the server's 25s ping, the stream is dead even though EventSource still says open.
  setInterval(() => {
    if (es && es.readyState === 1 && lastEvent && Date.now() - lastEvent > 70000) {
      setLive("down");
      connect();
    }
  }, 15000);
})();

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
  if (view === "system") {
    if (sub === "profiles") renderProfiles();
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

/* ---------------- connections ---------------- */
function renderConnections() {
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
const VIEWS = ["today", "connections", "system"];
const TABS = ["profiles", "plugins", "updates", "health"];

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

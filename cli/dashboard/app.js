/* claude-multi console — vanilla JS, no dependencies.
   Data from /api/*, live updates over /api/events (SSE), actions through /api/action. */

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
const usd = (n) => n == null ? "—" : "$" + (n >= 1000 ? n.toFixed(0) : n.toFixed(2));
const money = (n, cur) => n == null ? "—" : `${n.toFixed(2)} ${cur || "EUR"}`;
const pct = (n) => n == null || !isFinite(n) ? "—" : n.toFixed(n >= 10 ? 0 : 1) + "%";
const short = (s, n = 60) => {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const ago = (iso) => {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return Math.round(s / 60) + "m ago";
  if (s < 172800) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
};
const when = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

/** Model ids are long and repetitive in a table: keep the family and the version. */
const modelShort = (m) => String(m).replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/-(\d)-(\d)$/, "-$1.$2");

const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)"];
const colorFor = (() => {
  const m = new Map();
  return (k) => {
    if (!m.has(k)) m.set(k, m.size < SERIES.length ? SERIES[m.size] : "var(--s-other)");
    return m.get(k);
  };
})();

let S = null; // last /api/status payload
let BUDGET = null; // last /api/budget payload
let view = "overview";
// Switching filters quickly leaves two fetches in flight, and the winner is whichever answers
// last rather than whichever was asked last. One token per panel discards stale answers.
const seq = { usage: 0, sessions: 0, budget: 0, overview: 0 };

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

/* ---------------- live connection ---------------- */
let es = null, lastEvent = 0, esRetry = 0;
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
  es.addEventListener("usage", () => {
    lastEvent = Date.now();
    onChange("usage");
  });
  es.addEventListener("state", () => {
    lastEvent = Date.now();
    onChange("state");
  });
}
function setLive(state) {
  const el = $("#live");
  el.className = "live" + (state === "down" ? " down" : state === "busy" ? " busy" : "");
  $("#livetxt").textContent = state === "down" ? "reconnecting" : state === "busy" ? "refreshing" : "live";
}

// Coalesce: a busy session fires events continuously, and the panel only needs the latest.
let pending = null, changeTimer = null;
function onChange(topic) {
  pending = pending === "state" || topic === "state" ? "state" : "usage";
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    const t = pending;
    pending = null;
    refresh(t);
  }, 400);
}

/** Redraw what is actually on screen. The old page polled /api/status and redrew four panels
    regardless of the current view, which is why Usage, Sessions and Budget looked frozen. */
async function refresh(topic = "state") {
  setLive("busy");
  const jobs = [];
  if (topic === "state") jobs.push(loadStatus());
  if (view === "overview") jobs.push(loadOverview());
  if (view === "usage") jobs.push(loadUsage());
  if (view === "sessions") jobs.push(loadSessions());
  if (view === "profiles" && topic === "state") jobs.push(loadStatus().then(renderProfiles));
  await Promise.allSettled(jobs);
  setLive(es && es.readyState === 1 ? "live" : "down");
}

/* ---------------- status ---------------- */
async function loadStatus() {
  S = await api("/api/status");
  const m = S.machine;
  $("#host").textContent = m.hostname;
  $("#ver").textContent = `deno ${m.deno}`;
  $("#meta").innerHTML = [
    `Code ${esc(m.cliVersion || "?")}`,
    m.desktopVersion ? `Desktop ${esc(m.desktopVersion)}` : null,
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join("");

  const names = Object.keys(S.profiles);
  $("#n-profiles").textContent = names.length;
  fillProfileSelects(names);
  renderHealth(S.doctor);
  renderShared();
  if (view === "profiles") renderProfiles();
  if (view === "health") renderHealth(S.doctor);
  return S;
}

function fillProfileSelects(names) {
  for (const id of ["#uprof", "#sprof"]) {
    const sel = $(id);
    if (sel.dataset.filled === names.join(",")) continue;
    const cur = sel.value;
    sel.innerHTML = `<option value="">all profiles</option>` +
      names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    sel.value = cur;
    sel.dataset.filled = names.join(",");
  }
}

/* ---------------- overview ---------------- */
async function loadOverview() {
  const my = ++seq.overview;
  const [budget, days, projects] = await Promise.all([
    api("/api/budget").catch(() => null),
    api("/api/usage?" + new URLSearchParams({ by: "day", since: ovDays, split: "profile", limit: 400 })).catch(() =>
      null
    ),
    api("/api/usage?" + new URLSearchParams({ by: "project", since: "30d", limit: 8 })).catch(() => null),
  ]);
  if (my !== seq.overview) return;
  BUDGET = budget;
  renderBilling(budget);
  renderWindows(budget);
  renderTokens(days);
  renderChart(days);
  renderProjects(projects);
  renderRunning();
}

/** How old a reading is, in words. Every panel that shows cached numbers says this: the billing
 *  cache is refreshed by Claude Code whenever it feels like it, and a figure from weeks ago
 *  presented as current is worse than no figure at all. */
function readingAge(hours) {
  if (hours == null) return "never read";
  if (hours < 1) return "just refreshed";
  if (hours < 48) return `${Math.round(hours)} h old`;
  return `${Math.round(hours / 24)} days old`;
}

function renderBilling(b) {
  if (!b) return;
  let billed = 0, cap = 0, currency = "EUR", any = false, today = 0, haveToday = false;
  let oldest = null;
  for (const p of b.profiles) {
    const x = p.snap.extra;
    if (x?.used != null) {
      billed += x.used;
      any = true;
      currency = x.currency || currency;
    }
    if (p.ctx.cap) cap += p.ctx.cap;
    if (p.ctx.billedToday != null) {
      today += p.ctx.billedToday;
      haveToday = true;
    }
    if (p.snap.ageHours != null && (oldest == null || p.snap.ageHours > oldest)) oldest = p.snap.ageHours;
  }
  $("#billed").textContent = any ? money(billed, currency) : "—";
  const ratio = cap ? Math.min(100, billed / cap * 100) : 0;
  const meter = $("#billed-meter");
  meter.style.width = ratio + "%";
  meter.className = ratio >= 85 ? "crit" : ratio >= 60 ? "warn" : "";
  $("#billed-sub").textContent = [
    cap ? `${pct(ratio)} of the ${money(cap, currency)} cap` : "no cap reported",
    haveToday ? `${money(today, currency)} today` : null,
  ].filter(Boolean).join(" · ");
  $("#billed-age").textContent = readingAge(oldest);
  $("#billed-age").className = "r" + (b.profiles.some((p) => p.snap.stale) ? " stale" : "");

  // One row per profile: the total above is only useful once you can see who spent it.
  $("#billed-rows").innerHTML = b.profiles.map((p) => {
    const x = p.snap.extra;
    const on = x?.active;
    const used = x?.used;
    const capP = p.ctx.cap;
    const r = capP && used != null ? Math.min(100, used / capP * 100) : 0;
    return `<div class="prow">
      <b>${esc(p.snap.profile)}</b>
      <span class="chip${on ? " on" : ""}">${on ? "extra usage on" : "subscription only"}</span>
      <div class="track"><i class="${r >= 85 ? "crit" : r >= 60 ? "warn" : ""}" style="width:${r}%"></i></div>
      <span class="v">${used == null ? "—" : money(used, x.currency)}</span>
    </div>`;
  }).join("");
}

function renderWindows(b) {
  if (!b) return;
  const now = Date.now();
  const rows = [];
  let oldest = null;
  for (const p of b.profiles) {
    if (p.snap.ageHours != null && (oldest == null || p.snap.ageHours > oldest)) oldest = p.snap.ageHours;
    for (const l of p.snap.plan) {
      // A window whose reset time has passed already emptied itself: its percentage describes a
      // period that is over. Showing a stale 100% as a red alert is how this panel lied.
      const expired = !!l.resetsAt && new Date(l.resetsAt).getTime() < now;
      if (!l.percent && !l.active) continue;
      rows.push({ ...l, profile: p.snap.profile, expired });
    }
  }
  rows.sort((a, x) => (a.expired - x.expired) || (x.percent - a.percent));
  const live = rows.filter((r) => !r.expired);
  $("#wins-age").textContent = readingAge(oldest);
  $("#wins-age").className = "r" + (b.profiles.some((p) => p.snap.stale) ? " stale" : "");

  if (!rows.length) {
    $("#wins").innerHTML = `<div class="sub">no window data in the cached reading</div>`;
    return;
  }
  if (!live.length) {
    // Every window in the reading has already reset, so no percentage here describes the present.
    // Five greyed-out rows would just be five ways of saying the same nothing.
    $("#wins").innerHTML = `<div class="nowin">
      <b>Nothing current to show</b>
      <p>Every window in this reading has reset since it was taken. Open a session to refresh it.</p>
    </div>`;
    return;
  }
  $("#wins").innerHTML = live.slice(0, 5).map((l) => {
    const c = l.percent >= 95 ? "crit" : l.percent >= 80 ? "warn" : "";
    const label = `${l.kind.replace(/_/g, " ")} · ${l.profile}`;
    return `<div class="win" title="${esc(label)}">
      <b>${esc(label)}</b>
      <div class="track"><i class="${c}" style="width:${Math.min(100, l.percent)}%"></i></div>
      <span class="v ${c === "crit" ? "hot" : ""}">${pct(l.percent)}</span>
      <span class="win-when">${l.resetsAt ? esc(`resets ${resetIn(l.resetsAt)}`) : ""}</span>
    </div>`;
  }).join("");
}

/** "in 3 h" / "in 2 days" for a future reset. */
function resetIn(iso) {
  const h = (new Date(iso).getTime() - Date.now()) / 36e5;
  if (h < 1) return "within the hour";
  if (h < 48) return `in ${Math.round(h)} h`;
  return `in ${Math.round(h / 24)} days`;
}

function renderTokens(days) {
  const t = days?.total;
  const tiles = [["output", fmt(t?.output)], ["input", fmt(t?.input)], ["cache read", fmt(t?.cache_read)], [
    "cache written",
    fmt(t?.cache_write),
  ]];
  $("#tokentiles").innerHTML = tiles.map(([k, v]) =>
    `<div class="tile"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`
  ).join("");
  // Kept out of the grid on purpose: it is a different kind of number from the four beside it.
  $("#tokenworth").innerHTML = `<span class="k">would have cost</span><span class="v">${
    esc(usd(t?.cost))
  }</span><span class="note-inline">at pay-as-you-go list price</span>`;
}

let ovDays = "14d";
function renderChart(r) {
  const svg = $("#chart"), legend = $("#legend");
  if (!r || !r.rows.length) {
    svg.innerHTML = "";
    legend.innerHTML = `<span class="tot">no data</span>`;
    return;
  }
  // rows are (day, profile) pairs: fold them into one stack per day
  const byDay = new Map();
  const names = new Set();
  for (const row of r.rows) {
    const k = row.key, p = row.profile ?? "—";
    names.add(p);
    if (!byDay.has(k)) byDay.set(k, {});
    byDay.get(k)[p] = (byDay.get(k)[p] ?? 0) + (row.cost ?? 0);
  }
  const dayKeys = [...byDay.keys()].sort();
  const series = [...names].sort();
  series.forEach(colorFor); // claim colours in series order, not in the reversed draw order
  const totals = dayKeys.map((d) => series.reduce((a, p) => a + (byDay.get(d)[p] ?? 0), 0));
  const max = Math.max(1, ...totals);

  const W = 620, H = 172, PL = 44, PR = 10, PT = 12, PB = 24;
  const iw = W - PL - PR, ih = H - PT - PB;
  const x = (i) => PL + (dayKeys.length === 1 ? iw / 2 : i * iw / (dayKeys.length - 1));
  const y = (v) => PT + ih - (v / max) * ih;

  const nice = (v) => !v ? "0" : v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(0) : v.toFixed(1);
  let g = "";
  for (const t of [0, max / 2, max]) {
    g += `<line x1="${PL}" x2="${W - PR}" y1="${y(t).toFixed(1)}" y2="${
      y(t).toFixed(1)
    }" stroke="var(--line)" stroke-width="1"/>`;
    g += `<text x="${PL - 8}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">$${nice(t)}</text>`;
  }
  // stacked areas, drawn from the top of the stack down so each layer stays visible
  let acc = dayKeys.map(() => 0);
  const layers = [];
  for (const p of series) {
    const next = dayKeys.map((d, i) => acc[i] + (byDay.get(d)[p] ?? 0));
    layers.push({ p, lower: acc, upper: next });
    acc = next;
  }
  for (const { p, lower, upper } of layers.reverse()) {
    const top = upper.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const bottom = lower.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse().map((s, i) =>
      `${i ? "L" : "L"}${s}`
    ).join("");
    g += `<path class="area" d="${top}${bottom}Z" fill="${colorFor(p)}"/>`;
    g += `<path d="${top}" fill="none" stroke="${colorFor(p)}" stroke-width="1.6" stroke-linejoin="round"/>`;
  }
  const last = dayKeys.length - 1;
  g += `<circle cx="${x(last).toFixed(1)}" cy="${y(totals[last]).toFixed(1)}" r="3" fill="${colorFor(series[0])}"/>`;
  g += `<text x="${PL}" y="${H - 7}" text-anchor="start">${esc(dayKeys[0] ?? "")}</text>`;
  if (dayKeys.length > 1) g += `<text x="${W - PR}" y="${H - 7}" text-anchor="end">${esc(dayKeys[last])}</text>`;
  svg.innerHTML = g;

  legend.innerHTML = series.map((p) => `<span><i style="background:${colorFor(p)}"></i>${esc(p)}</span>`).join("") +
    `<span class="tot">${usd(r.total.cost)} · ${fmt(r.total.output)} out</span>`;
}

function renderProjects(r) {
  const tb = $("#projects");
  if (!r || !r.rows.length) {
    tb.innerHTML = `<tr><td colspan="2" class="empty">no data</td></tr>`;
    return;
  }
  const top = r.rows[0].cost || 1;
  tb.innerHTML = r.rows.map((p) => {
    const w = Math.max(2, (p.cost ?? 0) / top * 100);
    return `<tr><td title="${esc(p.cwd ?? p.key)}">${esc(short(p.label ?? p.key, 34))}</td>
      <td class="bar-cell">${usd(p.cost)}<i><b style="width:${w}%"></b></i></td></tr>`;
  }).join("");
}

function renderRunning() {
  const cli = S.running.cli, desk = S.running.desktop;
  $("#run-n").textContent = `${cli.length} cli · ${desk.length} desktop`;
  const el = $("#running");
  if (!cli.length && !desk.length) {
    el.innerHTML = `<div class="sub">nothing running</div>`;
    return;
  }
  // Several sessions of one profile are the normal case with Desktop tabs, and profile plus
  // directory is not enough to tell them apart. Model and session id are; and since we have the
  // session id, the row can open that transcript.
  el.innerHTML = `<div class="runlist">` +
    cli.map((c) =>
      `<div class="run${c.session ? " open" : ""}" ${
        c.session ? `data-session="${esc(c.session)}"` : ""
      } title="pid ${c.pid}${c.cwd ? ` · ${esc(c.cwd)}` : ""}">
      <span class="chip on">${esc(c.profile ?? "?")}</span>
      <b>${esc(c.cwd ? c.cwd.split("/").filter(Boolean).pop() : "—")}</b>
      <span class="run-model">${esc(c.model ? modelShort(c.model) : "")}</span>
      <span class="run-meta">${c.embedded ? "desktop" : "terminal"}${
        c.session ? ` · ${esc(c.session.slice(0, 8))}` : ""
      }</span>
    </div>`
    ).join("") +
    desk.map((d) =>
      `<div class="run" title="pid ${d.pid}">
      <span class="chip">${esc(d.variant)}</span>
      <b>Desktop app</b>
      <span class="run-meta">window</span>
    </div>`
    ).join("") +
    `</div>`;
}

$("#running").addEventListener("click", (e) => {
  const r = e.target.closest("[data-session]");
  if (r) openTranscript(r.dataset.session, null);
});

$("#ovdays").addEventListener("click", (e) => {
  const b = e.target.closest("[data-d]");
  if (!b) return;
  $$("#ovdays button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  ovDays = b.dataset.d;
  loadOverview();
});

/* ---------------- profiles ---------------- */
let editing = null;

function renderProfiles() {
  if (!S) return;
  const names = Object.keys(S.profiles);
  const live = new Set(S.running.cli.map((c) => c.profile));
  $("#pcards").innerHTML = names.map((n) => editing === n ? cardEdit(n) : cardView(n, live.has(n))).join("") +
    (editing === "+"
      ? cardEdit(null)
      : `<div class="pcard add" id="addp"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>Add profile</span></div>`);
}

function cardView(name, isLive) {
  const p = S.profiles[name];
  const b = BUDGET?.profiles.find((x) => x.snap.profile === name);
  const extra = b?.snap.extra;
  const reg = S.shared.mcpRegistry ?? {};
  const all = Object.keys(reg);
  const mine = new Set(p.mcp);
  const skills = Object.keys(p.mounted.skills).length;
  return `<div class="pcard">
    <div class="ph">
      <span class="dot ${isLive ? "live" : ""}" title="${isLive ? "session running" : "idle"}"></span>
      <h3>${esc(name)}</h3>
      <span class="acct">${esc(p.account ?? "not signed in")}</span>
      <button class="btn edit" data-edit="${esc(name)}">Edit</button>
    </div>
    <div class="fields">
      <div class="f"><label>Command</label><span class="val">${esc(p.manifest.command ?? "—")}</span></div>
      <div class="f"><label>Desktop</label><span class="val" title="${esc(p.desktopDir)}">${
    esc(shortHome(p.desktopDir))
  }</span></div>
      <div class="f"><label>Billed</label><span class="val">${
    extra ? `${money(extra.used, extra.currency)}${b.ctx.cap ? ` / ${money(b.ctx.cap, extra.currency)}` : ""}` : "—"
  } ${extra?.active ? `<span class="chip on">extra on</span>` : `<span class="chip">subscription</span>`}</span></div>
      <div class="f"><label>Mounted</label><span class="val">${skills} skills · ${
    Object.keys(p.mounted.agents).length
  } agents · ${Object.keys(p.mounted.commands).length} commands</span></div>
      <div class="f"><label>MCP</label><div class="chips">${
    all.length
      ? all.map((m) => `<span class="chip${mine.has(m) ? " on" : ""}">${esc(m)}</span>`).join("")
      : `<span class="chip">none</span>`
  }</div></div>
    </div>
  </div>`;
}

function cardEdit(name) {
  const isNew = !name;
  const p = isNew ? null : S.profiles[name];
  const m = p?.manifest ?? {};
  const reg = S.shared.mcpRegistry ?? {};
  const picked = new Set(isNew ? Object.keys(reg) : p.mcp);
  return `<form class="pcard" id="pform" data-name="${esc(name ?? "")}">
    <div class="ph"><span class="dot"></span><h3>${isNew ? "New profile" : esc(name)}</h3></div>
    <div class="fields">
      <div class="f"><label>Name</label>${
    isNew
      ? `<input name="name" required pattern="[a-z][a-z0-9_-]{1,30}" placeholder="research" autofocus>`
      : `<span class="val">${esc(name)}</span>`
  }</div>
      <div class="f"><label>Description</label><input name="description" value="${
    esc(m.description ?? "")
  }" placeholder="what this profile is for"></div>
      <div class="f"><label>Command</label><input name="command" value="${
    esc(m.command ?? "")
  }" placeholder="claude-research"></div>
      <div class="f"><label>Desktop</label><input name="desktopDir" value="${
    esc(m.desktopDir ?? "")
  }" placeholder="~/.config/Claude-Research"></div>
      <div class="f"><label>Alert cap</label><input name="cap" type="number" min="0" step="1" value="${
    esc(BUDGET?.cfg.profiles?.[name]?.cap ?? "")
  }" placeholder="account limit"></div>
      <div class="f"><label>MCP</label><div class="chips">${
    Object.keys(reg).map((s) =>
      `<span class="chip pick${picked.has(s) ? " on" : ""}" data-pick="${esc(s)}">${esc(s)}</span>`
    ).join("") || `<span class="chip">registry empty</span>`
  }</div></div>
    </div>
    <div class="pfoot">
      <button class="btn primary" type="submit">${isNew ? "Create" : "Save"}</button>
      <button class="btn ghost" type="button" data-cancel>Cancel</button>
      <span class="hint">writes the manifest, then runs install</span>
    </div>
  </form>`;
}

const shortHome = (p) => {
  const h = S?.profiles
    ? Object.values(S.profiles)[0]?.dir?.replace(/\/[^/]+$/, "").replace(/\/\.claude-multi$/, "")
    : null;
  return h && p.startsWith(h) ? "~" + p.slice(h.length) : p;
};

document.addEventListener("click", async (e) => {
  const ed = e.target.closest("[data-edit]");
  if (ed) {
    editing = ed.dataset.edit;
    renderProfiles();
    return;
  }
  if (e.target.closest("#addp")) {
    editing = "+";
    renderProfiles();
    return;
  }
  if (e.target.closest("[data-cancel]")) {
    editing = null;
    renderProfiles();
    return;
  }
  const pick = e.target.closest("[data-pick]");
  if (pick) {
    pick.classList.toggle("on");
    return;
  }
});

$("#pcards").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.dataset.name || f.elements.name.value.trim(),
    description: f.elements.description.value.trim(),
    command: f.elements.command.value.trim(),
    desktopDir: f.elements.desktopDir.value.trim(),
    cap: f.elements.cap.value ? Number(f.elements.cap.value) : null,
    mcp: $$("[data-pick].on", f).map((c) => c.dataset.pick),
  };
  const btn = $("button[type=submit]", f);
  btn.disabled = true;
  btn.textContent = "Working…";
  try {
    const r = await api("/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-multi": "1" },
      body: JSON.stringify(body),
    });
    editing = null;
    await loadStatus();
    renderProfiles();
    toast(r.message ?? `Profile ${body.name} saved`);
    if (r.output) showOutput(`Profile ${body.name}`, r.output);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = f.dataset.name ? "Save" : "Create";
    toast(String(err.message ?? err), true);
  }
});

/* ---------------- usage ---------------- */
const UHEAD = {
  default: ["", "msgs", "sess", "input", "output", "cache rd", "cache wr", "estimate"],
  tool: ["", "uses", "sess", "input", "output", "cache rd", "cache wr", "estimate"],
};

async function loadUsage() {
  const my = ++seq.usage;
  const by = $("#ugroup [aria-pressed=true]").dataset.g;
  const q = new URLSearchParams({ by, since: $("#usince").value, limit: "60" });
  if ($("#uprof").value) q.set("profile", $("#uprof").value);
  let r;
  try {
    r = await api("/api/usage?" + q);
  } catch (e) {
    toast(String(e.message), true);
    return;
  }
  if (my !== seq.usage) return;

  const tool = by === "skill" || by === "command";
  const head = tool ? UHEAD.tool : UHEAD.default;
  head[0] = by[0].toUpperCase() + by.slice(1);
  $("#uhead").innerHTML = head.map((h) => `<th>${esc(h)}</th>`).join("");
  const top = r.rows[0]?.cost || 1;
  $("#urows").innerHTML = r.rows.length
    ? r.rows.map((x) => {
      const label = x.label ?? x.key;
      const w = Math.max(1.5, (x.cost ?? 0) / top * 100);
      return `<tr><td title="${esc(x.cwd ?? label)}">${esc(short(label, 46))}</td>
        <td>${tool ? (x.uses ?? 0) : x.msgs}</td><td>${x.sessions}</td>
        <td>${fmt(x.input)}</td><td>${fmt(x.output)}</td><td>${fmt(x.cache_read)}</td><td>${fmt(x.cache_write)}</td>
        <td class="bar-cell">${usd(x.cost)}${x.unpriced ? "*" : ""}<i><b style="width:${w}%"></b></i></td></tr>`;
    }).join("")
    : `<tr><td colspan="8" class="empty">nothing in this window</td></tr>`;

  const notes = [`total ${usd(r.total.cost)} · ${fmt(r.total.output)} output · ${fmt(r.total.cache_read)} cache read`];
  if (tool) {
    notes.push(
      `estimate is the turn's share, split across the ${by === "skill" ? "skills" : "commands"} of that turn${
        r.orphanMsgs ? ` — ${r.orphanMsgs} messages outside any turn excluded` : ""
      }`,
    );
  }
  if (r.rows.some((x) => x.unpriced)) notes.push("* model with no rate in the table: partial estimate");
  if (r.spawns?.length) notes.push("subagents: " + r.spawns.map((s) => `${s.key} ×${s.n}`).join(" · "));
  $("#ufoot").innerHTML = notes.map(esc).join("<br>");
}

$("#ugroup").addEventListener("click", (e) => {
  const b = e.target.closest("[data-g]");
  if (!b) return;
  $$("#ugroup button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  loadUsage();
});
["#usince", "#uprof"].forEach((id) => $(id).addEventListener("change", loadUsage));

/* ---------------- sessions ---------------- */
async function loadSessions() {
  const my = ++seq.sessions;
  const q = new URLSearchParams({ since: $("#ssince").value, limit: "80" });
  if ($("#sprof").value) q.set("profile", $("#sprof").value);
  let rows;
  try {
    rows = await api("/api/sessions?" + q);
  } catch (e) {
    toast(String(e.message), true);
    return;
  }
  if (my !== seq.sessions) return;
  $("#srows").innerHTML = rows.length
    ? rows.map((s) =>
      `<tr data-session="${esc(s.session_id)}" title="${esc(s.cwd ?? "")}">
        <td>${esc(short(s.project, 34))}</td>
        <td><span class="tag">${esc(s.profile)}</span></td>
        <td>${esc(when(s.started))}</td>
        <td>${s.minutes}</td>
        <td>${s.msgs}${s.sidechain_msgs ? `<span class="sub"> +${s.sidechain_msgs}</span>` : ""}</td>
        <td>${esc(short(s.models.map(modelShort).join(" "), 18))}</td>
        <td>${usd(s.cost)}</td></tr>`
    ).join("")
    : `<tr><td colspan="7" class="empty">no sessions in this window</td></tr>`;
}
["#ssince", "#sprof"].forEach((id) => $(id).addEventListener("change", loadSessions));

$("#srows").addEventListener("click", (e) => {
  const tr = e.target.closest("[data-session]");
  if (tr) openTranscript(tr.dataset.session, tr);
});

async function openTranscript(id, tr) {
  $$("#srows tr").forEach((r) => r.removeAttribute("aria-selected"));
  tr?.setAttribute("aria-selected", "true");
  const cells = tr ? [...tr.children].map((c) => c.textContent) : [];
  const host = drawer(`${cells[0] ?? "Session"}`, `<div class="empty">loading transcript…</div>`);
  let t;
  try {
    t = await api("/api/transcript?" + new URLSearchParams({ session: id }));
  } catch (e) {
    toast(String(e.message), true);
    host.remove();
    return;
  }
  if (!document.body.contains(host)) return;
  const body = t.turns.length
    ? (t.total > t.turns.length
      ? `<div class="turn"><p class="sub">${t.total - t.turns.length} earlier turns not shown</p></div>`
      : "") +
      t.turns.map((x) =>
        `<div class="turn ${x.role === "user" ? "u" : ""}">
        <div class="who">${x.role === "user" ? "You" : "Claude"}${x.model ? ` · ${esc(modelShort(x.model))}` : ""}
          ${x.cost ? `<span class="cost">${usd(x.cost)}</span>` : ""}</div>
        ${x.text ? `<p>${esc(short(x.text, 4000))}</p>` : ""}
        ${
          x.tools.length
            ? `<div class="tools">${x.tools.map((n) => `<span class="chip">${esc(n)}</span>`).join("")}</div>`
            : ""
        }
      </div>`
      ).join("")
    : `<div class="empty">no readable turns in this transcript</div>`;
  $(".turns", host).innerHTML = body;
  $(".dmeta", host).innerHTML = [
    `<span><b>${esc(id.slice(0, 8))}</b></span>`,
    `<span>${t.total} turns</span>`,
    cells[2] ? `<span>${esc(cells[2])}</span>` : "",
    cells[6] ? `<span><b>${esc(cells[6])}</b> est.</span>` : "",
  ].join("");
}

function drawer(title, inner) {
  $(".scrim")?.parentElement?.remove();
  const host = document.createElement("div");
  host.innerHTML = `<div class="scrim" data-close></div>
    <aside class="drawer" role="dialog" aria-label="${esc(title)}">
      <div class="dh"><h3>${esc(title)}</h3><button class="x" data-close aria-label="Close">×</button></div>
      <div class="dmeta"></div>
      <div class="turns">${inner}</div>
    </aside>`;
  document.body.appendChild(host);
  host.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) host.remove();
  });
  const onKey = (e) => {
    if (e.key === "Escape") {
      host.remove();
      document.removeEventListener("keydown", onKey);
    }
  };
  document.addEventListener("keydown", onKey);
  return host;
}

function showOutput(title, text) {
  const host = drawer(title, `<pre class="out">${esc(text)}</pre>`);
  $(".dmeta", host).remove();
  return host;
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
  $("#hsum").textContent = `${n("ok")} pass · ${n("warn")} warn · ${n("fail")} fail`;
  const badge = $("#n-health");
  const bad = n("fail") || n("warn");
  badge.textContent = bad || "";
  badge.className = "n" + (n("fail") ? " crit" : n("warn") ? " warn" : "");
}

/** A fix line is a shell command. When it maps to an allowlisted action we offer the button;
    otherwise it is shown as text to copy, because running arbitrary strings from here would
    quietly turn the console into a remote shell. */
const FIX_ACTIONS = {
  "claude-multi install": "install",
  "claude-multi mcp sync": "mcp-sync",
  "claude-multi doctor": "doctor",
  "claude-multi budget": "budget",
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

$("#checks").addEventListener("click", (e) => {
  const b = e.target.closest("[data-action]");
  if (b) runAction(b.dataset.action);
});

$("#rerun").addEventListener("click", async () => {
  const btn = $("#rerun");
  btn.disabled = true;
  // stream the re-run: mark everything pending, then swap in the fresh verdicts
  renderHealth(S.doctor.map((c) => ({ ...c, status: "run", msg: "checking…", fix: null })));
  try {
    await loadStatus();
    toast("Health check complete");
  } catch (e) {
    toast(String(e.message), true);
  }
  btn.disabled = false;
});

function renderShared() {
  const s = S.shared;
  $("#shared").innerHTML = `<dl class="kv">
    <dt>skills</dt><dd>${Object.keys(s.skills).length}</dd>
    <dt>agents</dt><dd>${Object.keys(s.agents).length}</dd>
    <dt>commands</dt><dd>${Object.keys(s.commands).length}</dd>
    <dt>hooks</dt><dd>${s.hooks.length}</dd>
    <dt>rules</dt><dd>${esc(s.rules.join(", ") || "none")}</dd>
  </dl>`;
  const reg = s.mcpRegistry ?? {};
  const names = Object.keys(reg);
  $("#registry").innerHTML = names.length
    ? `<dl class="kv">` + names.map((n) =>
      `<dt>${esc(n)}</dt><dd>${esc(reg[n].profiles.join(", "))} · ${esc(reg[n].surfaces.join(", "))}</dd>`
    ).join("") + `</dl>`
    : `<div class="sub">registry empty</div>`;
}

/* ---------------- actions ---------------- */
async function runAction(action, opts = []) {
  toast(`Running ${action}…`);
  try {
    const r = await api("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-multi": "1" },
      body: JSON.stringify({ action, opts }),
    });
    showOutput(action, r.output || "(no output)");
    toast(`${action} finished${r.code ? ` with exit ${r.code}` : ""} in ${(r.ms / 1000).toFixed(1)}s`, r.code !== 0);
    await refresh("state");
  } catch (e) {
    toast(String(e.message), true);
  }
}

/* ---------------- navigation ---------------- */
const TITLES = { overview: "Overview", profiles: "Profiles", usage: "Usage", sessions: "Sessions", health: "Health" };
function go(v) {
  view = v;
  $$("#nav button").forEach((b) => b.setAttribute("aria-current", String(b.dataset.v === v)));
  $$(".view").forEach((s) => {
    s.hidden = s.id !== `v-${v}`;
  });
  $("#title").textContent = TITLES[v];
  if (location.hash.slice(1) !== v) history.replaceState(null, "", `#${v}`);
  if (v === "profiles") renderProfiles();
  if (v === "usage") loadUsage();
  if (v === "sessions") loadSessions();
  if (v === "overview") loadOverview();
}
$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest("[data-v]");
  if (b) go(b.dataset.v);
});
addEventListener("hashchange", () => {
  const v = location.hash.slice(1);
  if (TITLES[v] && v !== view) go(v);
});

/* ---------------- theme ---------------- */
let theme = localStorage.getItem("cm-theme") || "auto";
function applyTheme() {
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  $("#theme-lbl").textContent = theme;
  localStorage.setItem("cm-theme", theme);
}
$("#theme-btn").addEventListener("click", () => {
  theme = theme === "auto" ? "dark" : theme === "dark" ? "light" : "auto";
  applyTheme();
});
applyTheme();

/* ---------------- command palette ---------------- */
const CMDS = [
  ...Object.keys(TITLES).map((v) => ({ s: "Go to", n: TITLES[v], d: v, f: () => go(v) })),
  {
    s: "Run",
    n: "Health check",
    d: "doctor",
    f: () => {
      go("health");
      $("#rerun").click();
    },
  },
  { s: "Run", n: "Sync MCP servers", d: "mcp sync", f: () => runAction("mcp-sync") },
  { s: "Run", n: "Check MCP registry", d: "mcp check", f: () => runAction("mcp-check") },
  { s: "Run", n: "Re-ingest usage", d: "usage ingest --full", f: () => runAction("usage-ingest") },
  { s: "Run", n: "Fetch git remote", d: "sync --fetch", f: () => runAction("sync-fetch") },
  { s: "Run", n: "Preview install", d: "install --dry-run", f: () => runAction("install-dry") },
  { s: "Run", n: "Apply install", d: "install", f: () => runAction("install") },
  { s: "Run", n: "Budget report", d: "budget", f: () => runAction("budget") },
  { s: "Run", n: "Check for updates", d: "update --check", f: () => runAction("update-check") },
  {
    s: "Do",
    n: "Add profile",
    d: "new",
    f: () => {
      go("profiles");
      editing = "+";
      renderProfiles();
    },
  },
  { s: "Do", n: "Toggle theme", d: "theme", f: () => $("#theme-btn").click() },
];

let pal = null, sel = 0, hits = CMDS;
function openPal() {
  if (pal) return;
  hits = CMDS;
  sel = 0;
  pal = document.createElement("div");
  pal.className = "pal-wrap";
  pal.innerHTML =
    `<div class="pal"><input placeholder="Search views and commands…" aria-label="Search views and commands"><div class="pal-list"></div></div>`;
  document.body.appendChild(pal);
  const inp = $("input", pal);
  const paint = () => {
    let out = "", last = "";
    hits.forEach((c, i) => {
      if (c.s !== last) {
        out += `<div class="pal-sec">${esc(c.s)}</div>`;
        last = c.s;
      }
      out += `<div class="pal-i" data-i="${i}" data-sel="${i === sel ? 1 : 0}">
        <svg viewBox="0 0 24 24">${
        c.s === "Go to" ? `<path d="M5 12h14M13 6l6 6-6 6"/>` : `<path d="M8 6l6 6-6 6"/><path d="M15 18h4"/>`
      }</svg>
        ${esc(c.n)}<span class="d">${esc(c.d)}</span></div>`;
    });
    $(".pal-list", pal).innerHTML = out || `<div class="pal-sec">no match</div>`;
    $(`[data-sel="1"]`, pal)?.scrollIntoView({ block: "nearest" });
  };
  paint();
  inp.addEventListener("input", () => {
    const q = inp.value.toLowerCase().trim();
    hits = q ? CMDS.filter((c) => `${c.n} ${c.d} ${c.s}`.toLowerCase().includes(q)) : CMDS;
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
  const start = location.hash.slice(1);
  try {
    await loadStatus();
  } catch (e) {
    toast("cannot reach the local server: " + e.message, true);
  }
  go(TITLES[start] ? start : "overview");
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

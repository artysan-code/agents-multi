/* claude-multi dashboard — vanilla JS, nessuna dipendenza. Dati da /api/status e /api/usage, azioni su /api/action. */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (n) => n == null ? "—" : n >= 1e9 ? (n / 1e9).toFixed(2) + "G" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "k" : String(Math.round(n));
const short = (s, n = 64) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const outdated = (u, cur) => !!(u && u.outdated && u.latest && u.latest !== cur);
const usd = (n) => n == null ? "—" : "$" + (n >= 1000 ? n.toFixed(0) : n.toFixed(2));
const pct = (n) => n == null || !isFinite(n) ? "—" : (n * 100).toFixed(0) + "%";
const SERIES = { personal: "var(--s1)", work: "var(--s2)" };
const MODEL_SLOTS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)"];
const modelColor = (() => { const m = new Map(); return (k) => { if (!m.has(k)) m.set(k, m.size < MODEL_SLOTS.length ? MODEL_SLOTS[m.size] : "var(--s-other)"); return m.get(k); }; })();
let S = null; let busy = 0;

// ---------------------------------------------------------------- nav + tema
const TITLES = { overview: "Overview", profiles: "Profili", doctor: "Doctor", usage: "Usage", sync: "Sync", actions: "Azioni" };
function show(t) {
  document.querySelectorAll("nav a[data-t]").forEach((a) => a.classList.toggle("on", a.dataset.t === t));
  document.querySelectorAll("section").forEach((s) => s.classList.toggle("on", s.id === t));
  $("#title").textContent = TITLES[t] ?? t;
  if (t === "usage") loadUsage();
  try { localStorage.setItem("cm.tab", t); } catch { /* */ }
}
document.addEventListener("click", (e) => { const a = e.target.closest("a[data-t]"); if (a) { e.preventDefault(); show(a.dataset.t); } });
(() => { let t = location.hash.slice(1); try { t = t || localStorage.getItem("cm.tab") || "overview"; } catch { t = t || "overview"; } if (!TITLES[t]) t = "overview"; show(t); })();
$("#theme").addEventListener("change", (e) => { document.documentElement.dataset.theme = e.target.checked ? "light" : "dark"; try { localStorage.setItem("cm.theme", e.target.checked ? "light" : "dark"); } catch { /* */ } });
try { const th = localStorage.getItem("cm.theme"); if (th) { document.documentElement.dataset.theme = th; $("#theme").checked = th === "light"; } } catch { /* */ }
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 1800); }
function copy(text) { navigator.clipboard.writeText(text).then(() => toast("Copiato")); }
window.copy = copy;

// ---------------------------------------------------------------- tooltip
const tip = $("#tip");
function tipShow(html, x, y) { tip.innerHTML = html; tip.hidden = false; tipMove(x, y); }
function tipMove(x, y) { const w = tip.offsetWidth, h = tip.offsetHeight; tip.style.left = Math.min(x + 14, innerWidth - w - 8) + "px"; tip.style.top = Math.max(8, y - h - 12) + "px"; }
function tipHide() { tip.hidden = true; }

// ---------------------------------------------------------------- grafici SVG
/** Barre impilate per giorno. days: [{day, parts:{key:value}}], keys: ordine fisso delle serie. */
function stackedBars(el, days, keys, colors, fmtVal) {
  if (!days.length) { el.innerHTML = '<div class="empty">Nessun dato nel periodo.</div>'; return; }
  const W = 720, H = 220, padL = 44, padR = 8, padT = 10, padB = 26;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(1e-9, ...days.map((d) => keys.reduce((a, k) => a + (d.parts[k] || 0), 0)));
  const step = iw / days.length, bw = Math.min(24, step * 0.62);
  const y = (v) => padT + ih - (v / max) * ih;
  const ticks = niceTicks(max, 4);
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="grafico a barre impilate">`;
  svg += '<g class="grid">' + ticks.map((t) => `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/>`).join("") + "</g>";
  svg += '<g class="axis">' + ticks.map((t) => `<text x="${padL - 6}" y="${y(t) + 3.5}" text-anchor="end">${fmtVal(t)}</text>`).join("");
  const every = Math.ceil(days.length / 10);
  svg += days.map((d, i) => i % every === 0 || i === days.length - 1 ? `<text x="${padL + i * step + step / 2}" y="${H - 8}" text-anchor="middle">${d.day.slice(5)}</text>` : "").join("") + "</g>";
  svg += days.map((d, i) => {
    let acc = 0; const x = padL + i * step + (step - bw) / 2;
    const total = keys.reduce((a, k) => a + (d.parts[k] || 0), 0);
    const segs = keys.map((k, ki) => {
      const v = d.parts[k] || 0; if (!v) return "";
      const y1 = y(acc + v), y0 = y(acc); acc += v;
      const last = ki === keys.length - 1 || keys.slice(ki + 1).every((kk) => !(d.parts[kk] || 0));
      const r = last ? 4 : 0; const hgt = Math.max(0, y0 - y1 - (ki ? 2 : 0));
      const yy = ki ? y1 + 2 : y1;
      return `<path class="bar" fill="${colors[k]}" d="${roundTop(x, yy, bw, hgt, r)}"/>`;
    }).join("");
    return `<g data-i="${i}" data-day="${d.day}" data-total="${total}">${segs}<rect x="${padL + i * step}" y="${padT}" width="${step}" height="${ih}" fill="transparent"/></g>`;
  }).join("");
  svg += "</svg>";
  el.innerHTML = svg;
  el.querySelectorAll("g[data-i]").forEach((g) => {
    const d = days[Number(g.dataset.i)];
    g.addEventListener("mouseenter", (e) => { g.classList.add("hover"); tipShow(`<div class="t">${d.day}</div>` + keys.map((k) => `<div><i style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colors[k]};margin-right:6px"></i>${k} <b>${fmtVal(d.parts[k] || 0)}</b></div>`).join("") + `<div class="t" style="margin-top:3px">totale ${fmtVal(keys.reduce((a, k) => a + (d.parts[k] || 0), 0))}</div>`, e.clientX, e.clientY); });
    g.addEventListener("mousemove", (e) => tipMove(e.clientX, e.clientY));
    g.addEventListener("mouseleave", () => { g.classList.remove("hover"); tipHide(); });
  });
}
function roundTop(x, y, w, h, r) {
  if (h <= 0) return "";
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}
function niceTicks(max, n) {
  const raw = max / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), norm = raw / mag;
  const stepv = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = []; for (let v = 0; v <= max + 1e-9; v += stepv) out.push(v); return out;
}
function legend(el, keys, colors) { el.innerHTML = keys.map((k) => `<span><i style="background:${colors[k]}"></i>${esc(k)}</span>`).join(""); }
function hbars(el, rows, color, fmtVal) {
  if (!rows.length) { el.innerHTML = '<div class="empty">Nessun dato.</div>'; return; }
  const max = Math.max(...rows.map((r) => r.v));
  el.innerHTML = rows.map((r) => `<div class="hbar" title="${esc(r.k)}"><span class="lbl">${esc(r.k)}</span><div class="track"><div class="fill" style="width:${(r.v / max * 100).toFixed(1)}%;background:${color(r.k)}"></div></div><span class="val">${fmtVal(r.v)}</span></div>`).join("");
}

// ---------------------------------------------------------------- render: overview
function tile(label, value, sub, cls = "") { return `<div class="card tile ${cls}"><h3>${label}</h3><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`; }
function renderOverview(s, u14) {
  const m = s.machine, r = s.repo, up = s.update || {};
  const cur = { cli: m.cliVersion, desktop: m.desktopVersion };
  const upd = (k) => outdated(up[k], cur[k]) ? `<span class="delta up">⬆ ${esc(up[k].latest)}</span>` : `<span class="delta good">aggiornato</span>`;
  const fails = s.doctor.filter((c) => c.status === "fail").length, warns = s.doctor.filter((c) => c.status === "warn").length;
  const sess = s.running.cli.length;
  $("#ov-tiles").innerHTML =
    tile("Claude Code", `${esc(m.cliVersion || "?")}`, `${upd("cli")} <span class="faint">· ${m.cliVersions.length} in cache</span>`) +
    tile("Claude Desktop", `${esc(m.desktopVersion || "assente")}`, `${upd("desktop")} <span class="faint">· embedded ${Object.values(m.embeddedCode || {}).flat().filter((v, i, a) => a.indexOf(v) === i).join(", ") || "—"}</span>`) +
    tile("Doctor", fails ? `<span class="crit">${fails} fail</span>` : warns ? `<span class="warn">${warns} warn</span>` : `<span class="ok">tutto ok</span>`, `${s.doctor.length} controlli`) +
    tile("Sessioni attive", `${sess}<small>${s.running.desktop.length} Desktop</small>`, sess ? s.running.cli.map((c) => `${c.profile ?? "?"}${c.embedded ? " (desktop)" : " (cli)"}`).join(" · ") : "nessuna sessione Claude Code");
  // repo
  const syncCls = !r.isRepo || !r.upstream ? "crit" : (r.behind && r.ahead) ? "crit" : (r.behind || r.ahead || r.dirty) ? "warn" : "ok";
  $("#ov-repo").innerHTML = r.isRepo ? `<dt>branch</dt><dd>${esc(r.branch)} <span class="faint" title="${esc(r.head)}">@ ${esc(short(r.head))}</span></dd><dt>remote</dt><dd class="mono">${esc(r.remote || "—")}</dd><dt>stato</dt><dd class="${syncCls}">↓${r.behind} ↑${r.ahead} ✎${r.dirty}${r.dirty ? ` <span class="faint">· ${esc(r.dirtyFiles.slice(0, 3).join(", "))}</span>` : ""}</dd><dt>ultimo commit</dt><dd>${r.headDate ? new Date(r.headDate).toLocaleString("it-IT") : "—"}</dd><dt>ultimo fetch</dt><dd>${s.sync?.fetched_at ? new Date(s.sync.fetched_at * 1000).toLocaleString("it-IT") : "mai"}${s.sync?.fetch_ok === false ? ' <span class="warn">fallito</span>' : ""}</dd>` : "<dt>repo</dt><dd class='crit'>non trovato</dd>";
  // running + shared
  $("#ov-running").innerHTML = (s.running.cli.length ? s.running.cli.map((c) => `<div><span class="chip"><span class="k">${c.embedded ? "desktop" : "cli"}</span> ${esc(c.profile || "?")} <span class="k">${esc(c.version || "")}</span></span> <span class="faint mono">${esc((c.cwd || "").replace(/^\/home\/[^/]+/, "~"))}</span></div>`).join("") : '<div class="empty">nessuna sessione Claude Code</div>') + (s.running.desktop.length ? `<div class="faint" style="margin-top:6px">Desktop aperto: ${s.running.desktop.map((d) => d.variant).join(", ")}</div>` : "");
  const sh = s.shared;
  $("#ov-shared").innerHTML = `<dl class="kv"><dt>skill</dt><dd>${Object.keys(sh.skills).length} <span class="faint">(${Object.values(sh.skills).filter((v) => v.link && v.link.includes("/.agents/")).length} da ~/.agents)</span></dd><dt>agenti</dt><dd>${Object.keys(sh.agents).length}</dd><dt>comandi</dt><dd>${Object.keys(sh.commands).length}</dd><dt>hook</dt><dd>${sh.hooks.length}</dd><dt>MCP</dt><dd>${Object.keys(sh.mcpRegistry).join(", ")}</dd></dl>`;
  // doctor excerpt
  const bad = s.doctor.filter((c) => c.status !== "ok");
  $("#ov-doctor").innerHTML = bad.length ? bad.slice(0, 6).map(checkRow).join("") : '<div class="empty ok">Tutte le invarianti sono rispettate.</div>';
  // badge
  const bd = $("#badge-doctor"); bd.hidden = !(fails || warns); bd.textContent = fails ? `${fails}` : `${warns}`; bd.className = "badge " + (fails ? "crit" : "warn");
  const bs = $("#badge-sync"); const pend = (r.behind || 0) + (r.ahead || 0); bs.hidden = !pend && !r.dirty; bs.textContent = pend ? `${r.behind ? "↓" + r.behind : ""}${r.ahead ? "↑" + r.ahead : ""}` : `✎${r.dirty}`; bs.className = "badge warn";
  // usage 14d
  if (u14) {
    const days = groupDays(u14.rows, 14);
    stackedBars($("#ov-chart"), days, ["personal", "work"], SERIES, usd);
    legend($("#ov-legend"), ["personal", "work"], SERIES);
    $("#ov-usage-total").textContent = `${usd(u14.total.cost)} · ${fmt(u14.total.output)} token di output`;
  }
}
function checkRow(c) {
  const mark = { ok: "✓", warn: "!", fail: "✕" }[c.status] || "?";
  return `<div class="check ${c.status}"><span class="mark">${mark}</span><div><div class="msg">${esc(c.msg)}</div>${c.fix && c.status !== "ok" ? `<code class="fix">${esc(c.fix)}</code>` : ""}<div class="id">${esc(c.id)}</div></div>${c.fix && c.status !== "ok" ? `<button class="btn sm copy" onclick="copy(${JSON.stringify(c.fix).replace(/"/g, "&quot;")})">Copia fix</button>` : "<span></span>"}</div>`;
}
/** rows del report --by day+profile → [{day, parts}] ordinati, ultimi n giorni riempiti */
function groupDays(rows, n) {
  const byDay = new Map();
  for (const r of rows) { const d = byDay.get(r.day) || {}; d[r.profile] = (d[r.profile] || 0) + (r.cost || 0); byDay.set(r.day, d); }
  const out = []; const today = new Date();
  for (let i = n - 1; i >= 0; i--) { const d = new Date(today); d.setUTCDate(d.getUTCDate() - i); const key = d.toISOString().slice(0, 10); out.push({ day: key, parts: byDay.get(key) || {} }); }
  return out;
}

// ---------------------------------------------------------------- render: profili
function renderProfiles(s) {
  const chips = (o) => Object.entries(o).map(([n, v]) => `<span class="chip${v.broken ? " broken" : v.link && v.link.includes("/.agents/") ? " extern" : v.link && v.link.startsWith("/") && v.link.includes("/profiles/") ? " own" : ""}">${esc(n)}</span>`).join("") || '<span class="faint">—</span>';
  $("#pf").innerHTML = Object.entries(s.profiles).map(([p, i]) => {
    const mine = s.running.cli.filter((c) => c.profile === p);
    return `<div class="card"><div class="head"><h2>${p} <span class="faint" style="font-weight:400;font-size:var(--t-small)">${esc(i.account || "")}</span></h2><span class="delta ${mine.length ? "good" : ""}">${mine.length} sessioni</span></div>
      <div class="faint" style="margin:6px 0 10px">${esc(i.manifest.description || "")}</div>
      <dl class="kv"><dt>manifest</dt><dd class="mono">skills ${esc(JSON.stringify(i.manifest.skills))} · agents ${esc(JSON.stringify(i.manifest.agents))} · commands ${esc(JSON.stringify(i.manifest.commands))}</dd>
      <dt>credenziali</dt><dd>${i.credentials.present ? `<span class="ok">presenti</span> <span class="faint">mode ${i.credentials.mode}</span>` : '<span class="warn">assenti: /login</span>'}</dd></dl>
      <div class="sep"></div>
      <h3>Skill <span class="faint">${Object.keys(i.mounted.skills).length}</span></h3><div>${chips(i.mounted.skills)}</div>
      <h3 style="margin-top:10px">Agenti <span class="faint">${Object.keys(i.mounted.agents).length}</span></h3><div>${chips(i.mounted.agents)}</div>
      <h3 style="margin-top:10px">Comandi <span class="faint">${Object.keys(i.mounted.commands).length}</span></h3><div>${chips(i.mounted.commands)}</div>
      <div class="sep"></div>
      <h3>MCP</h3><div><span class="faint">cli</span> ${i.mcp.map((x) => `<span class="chip">${esc(x)}</span>`).join("") || "—"}</div><div style="margin-top:4px"><span class="faint">desktop</span> ${i.mcpDesktop.map((x) => `<span class="chip">${esc(x)}</span>`).join("") || '<span class="faint">—</span>'}</div>
      <h3 style="margin-top:10px">Plugin <span class="faint">${i.plugins.length}</span></h3><div>${i.plugins.map((x) => `<span class="chip">${esc(x)}</span>`).join("")}</div>
    </div>`;
  }).join("");
  const sh = s.shared;
  $("#sh").innerHTML = `<div class="faint" style="margin-bottom:8px">legenda chip: <span class="chip extern">da ~/.agents</span> <span class="chip own">propria del profilo</span> <span class="chip broken">link rotto</span></div>
    <dl class="kv"><dt>registry MCP</dt><dd>${Object.entries(sh.mcpRegistry).map(([n, v]) => `<span class="chip">${esc(n)} <span class="k">${v.profiles.join("+")} · ${v.surfaces.join("+")}</span></span>`).join("")}</dd>
    <dt>regole</dt><dd>${sh.rules.map((x) => `<span class="chip">${esc(x)}</span>`).join("")}</dd>
    <dt>hook</dt><dd>${sh.hooks.map((x) => `<span class="chip">${esc(x)}</span>`).join("")}</dd>
    <dt>~/.agents/skills</dt><dd>${sh.agentsSkills.map((x) => `<span class="chip${sh.skills[x] ? "" : " warnc"}">${esc(x)}</span>`).join("")}${sh.agentsSkills.some((x) => !sh.skills[x]) ? ' <span class="faint">(giallo = non montata: claude-multi install)</span>' : ""}</dd></dl>`;
}

// ---------------------------------------------------------------- render: doctor
let dfilter = "all";
function renderDoctor(s) {
  const ord = { fail: 0, warn: 1, ok: 2 };
  const list = s.doctor.slice().sort((a, b) => ord[a.status] - ord[b.status]).filter((c) => dfilter === "all" || c.status === dfilter);
  $("#dlist").innerHTML = list.map(checkRow).join("") || '<div class="empty">Niente in questa categoria.</div>';
  const n = (k) => s.doctor.filter((c) => c.status === k).length;
  $("#dsum").textContent = `${n("ok")} ok · ${n("warn")} warn · ${n("fail")} fail`;
}
$("#dfilter").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; dfilter = b.dataset.f; $("#dfilter").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); if (S) renderDoctor(S); });
$("#dre").addEventListener("click", () => load(true));

// ---------------------------------------------------------------- render: sync
function renderSync(s) {
  const r = s.repo, sy = s.sync || {};
  $("#sy").innerHTML =
    `<div class="card tile"><h3>Remote</h3><div class="mono" style="word-break:break-all">${esc(r.remote || "nessun remote")}</div><div class="sub">upstream ${esc(r.upstream || "—")} · branch ${esc(r.branch || "?")}</div></div>` +
    tile("Ultimo fetch", sy.fetched_at ? new Date(sy.fetched_at * 1000).toLocaleString("it-IT") : "mai", sy.fetch_ok === false ? '<span class="warn">ultimo fetch fallito (offline?)</span>' : "il wrapper rifà il fetch se più vecchio di 12 h") +
    tile("Stato", `<span class="${(r.behind && r.ahead) ? "crit" : (r.behind || r.ahead) ? "warn" : "ok"}">↓${r.behind ?? 0} ↑${r.ahead ?? 0}</span>`, r.behind && r.ahead ? "divergente: risolvi a mano" : r.behind ? "indietro: claude-multi sync" : r.ahead ? "commit da pushare" : "allineato") +
    `<div class="card" style="grid-column: span 3"><h3>Working tree</h3>${r.dirty ? `<div class="warn">${r.dirty} file modificati</div><pre class="mono" style="margin:6px 0 0;white-space:pre-wrap">${esc(r.dirtyFiles.join("\n"))}</pre>` : '<div class="ok">pulito</div>'}</div>`;
}

// ---------------------------------------------------------------- render: usage
async function loadUsage() {
  const q = new URLSearchParams({ by: $("#uby").value, since: $("#usince").value, profile: $("#uprof").value });
  const [r, byDay, byModel] = await Promise.all([
    fetch("/api/usage?" + q).then((x) => x.json()),
    fetch("/api/usage?" + new URLSearchParams({ by: "day", since: $("#usince").value, profile: $("#uprof").value, split: "profile", limit: 400 })).then((x) => x.json()),
    fetch("/api/usage?" + new URLSearchParams({ by: "model", since: $("#usince").value, profile: $("#uprof").value })).then((x) => x.json()),
  ]);
  const t = r.total; const cacheRatio = t.cache_read / Math.max(1, t.cache_read + t.input + t.cache_write);
  $("#u-tiles").innerHTML =
    tile("Costo equivalente", usd(t.cost), `${r.since ? "dal " + r.since : "tutto il periodo"}`, "hero") +
    tile("Output", fmt(t.output) + "<small>token</small>", `${fmt(t.input)} input non in cache`) +
    tile("Cache", pct(cacheRatio) + "<small>letta</small>", `${fmt(t.cache_read)} letti · ${fmt(t.cache_write)} scritti`) +
    tile("Messaggi", fmt(t.msgs), `${r.rows.reduce((a, x) => a + (x.sessions || 0), 0)} sessioni nei gruppi`);
  const days = byDay.rows.length ? byDay.rows.map((x) => x.day).filter((v, i, a) => a.indexOf(v) === i).sort() : [];
  const span = days.length ? Math.min(90, Math.max(7, (Date.now() - new Date(days[0]).getTime()) / 864e5 + 1)) : 14;
  stackedBars($("#u-chart"), groupDays(byDay.rows, Math.round(span)), ["personal", "work"], SERIES, usd);
  legend($("#u-legend"), ["personal", "work"], SERIES);
  hbars($("#u-models"), byModel.rows.map((x) => ({ k: x.key, v: x.cost || 0 })), modelColor, usd);
  $("#u-title").textContent = `Dettaglio per ${$("#uby").selectedOptions[0].text}`;
  $("#u-spawns").textContent = r.spawns.length ? "subagent lanciati: " + r.spawns.map((x) => `${x.key} ×${x.n}`).join(" · ") : "";
  $("#ut").innerHTML = `<thead><tr><th>${esc(r.by)}</th><th class="n">msg</th><th class="n">sess</th><th class="n">input</th><th class="n">output</th><th class="n">cache rd</th><th class="n">cache wr</th><th class="n">costo</th></tr></thead><tbody>` +
    r.rows.map((x) => `<tr><td>${esc(x.key)}</td><td class="n">${x.msgs}</td><td class="n">${x.sessions}</td><td class="n">${fmt(x.input)}</td><td class="n">${fmt(x.output)}</td><td class="n">${fmt(x.cache_read)}</td><td class="n">${fmt(x.cache_write)}</td><td class="n">${usd(x.cost)}${x.unpriced ? "*" : ""}</td></tr>`).join("") +
    `</tbody><tfoot><tr><td>totale</td><td class="n">${t.msgs || 0}</td><td></td><td class="n">${fmt(t.input)}</td><td class="n">${fmt(t.output)}</td><td class="n">${fmt(t.cache_read)}</td><td class="n">${fmt(t.cache_write)}</td><td class="n">${usd(t.cost)}</td></tr></tfoot>`;
}
["uby", "usince", "uprof"].forEach((id) => $("#" + id).addEventListener("change", loadUsage));

// ---------------------------------------------------------------- azioni
const ACTIONS = [
  { id: "doctor", title: "Doctor", desc: "Riesegue tutti i controlli e aggiorna la pagina.", btn: "Esegui" },
  { id: "sync-fetch", title: "Sync repo", desc: "Fetch dal remote e pull fast-forward se il working tree è pulito.", btn: "Fetch + pull" },
  { id: "mcp-check", title: "MCP: verifica", desc: "Confronta il registry con .claude.json e claude_desktop_config.json.", btn: "Verifica" },
  { id: "mcp-sync", title: "MCP: applica registry", desc: "Scrive le superfici CLI e Desktop. Rifiuta se ci sono istanze attive che riscriverebbero i file.", btn: "Applica", danger: true, opts: [{ id: "force", label: "ignora le istanze attive (--force)" }] },
  { id: "install-dry", title: "Install: anteprima", desc: "Mostra cosa farebbe claude-multi install senza toccare nulla.", btn: "Dry-run" },
  { id: "install", title: "Install: materializza", desc: "Applica manifest, symlink, unit e .desktop. Meglio a Claude chiuso.", btn: "Install", danger: true },
  { id: "usage-ingest", title: "Usage: reindicizza", desc: "Rilegge tutti i transcript da zero e ricostruisce il database.", btn: "Ingest --full" },
  { id: "update-check", title: "Update: controlla", desc: "Interroga i canali di Claude Code e Claude Desktop e aggiorna la cache della statusline.", btn: "Controlla" },
];
$("#ax").innerHTML = ACTIONS.map((a) => `<div class="card action"><h3>${a.title}</h3><p>${a.desc}</p><div class="row"><button class="btn ${a.danger ? "danger" : "primary"}" data-a="${a.id}">${a.btn}</button>${(a.opts || []).map((o) => `<label class="switch"><input type="checkbox" data-opt="${o.id}" data-for="${a.id}"> ${o.label}</label>`).join("")}</div></div>`).join("");
$("#ax").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-a]"); if (!b) return;
  const id = b.dataset.a; const opts = [...document.querySelectorAll(`input[data-for="${id}"]:checked`)].map((x) => x.dataset.opt);
  b.disabled = true; setBusy(true);
  const out = $("#ax-out"); out.textContent += `\n$ claude-multi ${id}${opts.length ? " " + opts.map((o) => "--" + o).join(" ") : ""}\n`;
  try {
    const r = await fetch("/api/action", { method: "POST", headers: { "content-type": "application/json", "x-claude-multi": "1" }, body: JSON.stringify({ action: id, opts }) }).then((x) => x.json());
    out.textContent += (r.output || "") + `\n[exit ${r.code}]${r.ms ? ` · ${(r.ms / 1000).toFixed(1)}s` : ""}\n`;
    toast(r.code === 0 ? `${id}: ok` : `${id}: exit ${r.code}`);
  } catch (err) { out.textContent += `errore: ${err}\n`; }
  out.scrollTop = out.scrollHeight; b.disabled = false; setBusy(false);
  load(true);
});
$("#ax-clear").addEventListener("click", () => { $("#ax-out").textContent = ""; });

// ---------------------------------------------------------------- caricamento
function setBusy(on) { busy += on ? 1 : -1; $("#dot").classList.toggle("busy", busy > 0); }
async function load(force = false) {
  setBusy(true);
  try {
    const [s, u14] = await Promise.all([
      fetch("/api/status" + (force ? "?fresh=1" : "")).then((x) => x.json()),
      fetch("/api/usage?" + new URLSearchParams({ by: "day", since: "14d", split: "profile", limit: 200 })).then((x) => x.json()).catch(() => null),
    ]);
    S = s;
    $("#host").textContent = s.machine.hostname; $("#gen").textContent = new Date(s.generatedAt).toLocaleTimeString("it-IT");
    $("#ver").textContent = `deno ${s.machine.deno}`;
    $("#meta").innerHTML = `<span>${esc(s.machine.hostname)}</span><span>·</span><span>Code ${esc(s.machine.cliVersion || "?")}</span><span>·</span><span>Desktop ${esc(s.machine.desktopVersion || "—")}</span>`;
    renderOverview(s, u14); renderProfiles(s); renderDoctor(s); renderSync(s);
  } catch (e) { toast("stato non disponibile: " + e.message); }
  setBusy(false);
}
load();
setInterval(() => { if ($("#auto").checked && !document.hidden) load(); }, 30000);

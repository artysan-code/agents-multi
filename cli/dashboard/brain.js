// deno-lint-ignore-file no-window no-unused-vars -- browser scripts sharing one global scope (app.js, brain.js, tasks.js)
/* claude-multi console — the Brain: Samuel's memory on the brain service, read through the console
   (cli/memory.ts, the token stays there). The seven areas as a tree, search by words and by meaning,
   a reader with who wrote what and when, the links both ways, every version and what changed, the
   page's neighbourhood as a small live graph, and the whole graph on its own screen. Only a view:
   changes are Claude's, where the brain's rules answer.
   Loaded after app.js (helpers: $, esc, api, t, toast, mdToHtml, ago, short). */

const AREAS = ["io", "progetti", "clienti", "persone", "note", "diario", "inbox"];
const areaOf = (a) => AREAS.includes(a) ? a : "other";
let BRAIN = null, bSel = null, bMode = "read", bDepth2 = false, bOpen = new Set(["progetti"]);
const bOff = new Set();
let bPage = null; // the page on screen, as /api/brain/page answers it
let bVer = null; // an older version on screen: { rev, body, at, by, diff }
let bFound = null; // the last search: { q, results, note }
try {
  bMode = localStorage.getItem("cm-bmode") === "graph" ? "graph" : "read";
  bOpen = new Set(JSON.parse(localStorage.getItem("cm-bopen2") ?? '["progetti"]'));
} catch { /* storage blocked: defaults */ }
const remember = () => { try { localStorage.setItem("cm-bopen2", JSON.stringify([...bOpen])); localStorage.setItem("cm-bmode", bMode); } catch { /* not remembered */ } };
const bare = (path) => String(path).replace(/\.md$/, "");

async function loadBrain() {
  try {
    BRAIN = await api("/api/brain/pages");
  } catch (e) {
    BRAIN = null;
    $("#bn-tree").innerHTML = "";
    $("#bn-page").innerHTML = `<div class="bn-body"><p class="sub">${esc(t("brain.away", { e: errText(e) }))}</p></div>`;
    throw e;
  }
  BRAIN.byPath = new Map(BRAIN.pages.map((p) => [p.path, p]));
  BRAIN.out = new Map(), BRAIN.in = new Map();
  for (const [a, b] of BRAIN.edges) {
    if (!BRAIN.out.has(a)) BRAIN.out.set(a, new Set());
    if (!BRAIN.in.has(b)) BRAIN.in.set(b, new Set());
    BRAIN.out.get(a).add(b);
    BRAIN.in.get(b).add(a);
  }
  if (bSel && !BRAIN.byPath.has(bSel)) bSel = null;
  bSel ??= BRAIN.byPath.has("progetti/claude-multi.md") ? "progetti/claude-multi.md" : BRAIN.pages[0]?.path ?? null;
  renderBrainAll();
  // a change elsewhere: the page on screen is read again, unless an old version is being looked at
  if (bSel && !bVer && (bPage?.path !== bSel || BRAIN.byPath.get(bSel)?.rev !== bPage?.rev)) readInto(bSel);
}

/** The service's answer inside an error, without the status line. */
const errText = (e) => {
  const m = String(e.message ?? e).match(/\{.*\}/s);
  try { return m ? JSON.parse(m[0]).error ?? e.message : e.message; } catch { return e.message; }
};

function renderBrainAll() {
  if (!BRAIN) return;
  $$("#bn-modes [data-bmode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.bmode === bMode)));
  $("#bn-read").hidden = bMode !== "read";
  $("#bn-graph").hidden = bMode !== "graph";
  $("#b-sum").textContent = t("brain.sum", { p: BRAIN.pages.length, l: BRAIN.edges.length });
  renderTree();
  if (bMode === "graph") showGlobalGraph();
  else showLocalGraph();
}

/** Opens a page in the reader from elsewhere (a task's attachment, a link). */
async function openBrainPage(target) {
  if (!BRAIN) await loadBrain().catch((e) => toast(errText(e), true)); // the tab may never have been opened
  const path = resolvePage(target);
  if (!path) return toast(t("brain.missing", { p: target }), true);
  bMode = "read";
  remember();
  selectPage(path);
}

/** Where a [[target]] points, as the brain resolves it: the exact path, else the shallowest page
    with that name. */
function resolvePage(target) {
  if (!BRAIN || !target) return null;
  const tg = bare(String(target).replace(/^\/+/, ""));
  if (BRAIN.byPath.has(`${tg}.md`)) return `${tg}.md`;
  const name = tg.split("/").pop().toLowerCase();
  const hits = BRAIN.pages.filter((p) => bare(p.path).split("/").pop().toLowerCase() === name);
  hits.sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
  return hits[0]?.path ?? null;
}

function selectPage(path) {
  bSel = path;
  bVer = null;
  const parts = bare(path).split("/");
  for (let i = 1; i < parts.length; i++) bOpen.add(parts.slice(0, i).join("/"));
  remember();
  renderBrainAll();
  readInto(path);
  $(`#bn-tree [data-page="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" });
}

/** Who wrote: "claude:Claude Code" → "Claude · Claude Code", "token:fisso" → "fisso". */
const who = (by) => {
  const [kind, rest] = String(by ?? "").split(/:(.*)/s);
  if (kind === "claude") return rest && rest !== "Claude" ? `Claude · ${rest}` : "Claude";
  if (kind === "token") return rest || t("brain.machine");
  return by || "—";
};
const when = (iso) => new Date(iso).toLocaleString(lang(), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/* ---------------- the tree ---------------- */
/** Titles and paths matching what is typed, at once; the service's search follows on Enter. */
function matches() {
  const q = $("#b-q").value.trim().toLowerCase();
  if (!q) return null;
  const set = new Set(BRAIN.pages.filter((p) => `${p.title} ${p.path}`.toLowerCase().includes(q)).map((p) => p.path));
  if (bFound?.q === $("#b-q").value.trim()) for (const r of bFound.results) set.add(r.path);
  return set;
}

function renderTree() {
  if (bFound && bFound.q === $("#b-q").value.trim()) return renderResults();
  const hits = matches();
  const roots = new Map(AREAS.map((a) => [a, { dirs: new Map(), pages: [], path: a }]));
  for (const p of BRAIN.pages) {
    if (hits && !hits.has(p.path)) continue;
    const parts = bare(p.path).split("/");
    if (!roots.has(parts[0])) roots.set(parts[0], { dirs: new Map(), pages: [], path: parts[0] });
    let node = roots.get(parts[0]);
    for (let i = 1; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), pages: [], path: parts.slice(0, i + 1).join("/") });
      node = node.dirs.get(parts[i]);
    }
    node.pages.push(p);
  }
  const count = (n) => n.pages.length + [...n.dirs.values()].reduce((s, d) => s + count(d), 0);
  const pageBtn = (p, depth) =>
    `<button class="bt-p${p.path === bSel ? " on" : ""}" data-page="${esc(p.path)}" style="--d:${depth}" title="${esc(bare(p.path))}">${esc(p.title)}</button>`;
  const draw = (node, depth, area) => {
    const dirs = [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b));
    // the diary reads newest first; elsewhere by title
    const pages = [...node.pages].sort(area === "diario" ? (a, b) => b.path.localeCompare(a.path) : (a, b) => a.title.localeCompare(b.title));
    return dirs.map(([name, d]) => folder(d, name, depth, area)).join("") + pages.map((p) => pageBtn(p, depth)).join("");
  };
  const folder = (d, label, depth, area) => {
    const n = count(d);
    const open = hits ? n > 0 : bOpen.has(d.path);
    return `<div class="bt-dir${open ? " open" : ""}${n ? "" : " empty"}">
      <button class="bt-f" data-dir="${esc(d.path)}" style="--d:${depth}">
        <svg viewBox="0 0 24 24" class="ico chev"><path d="M9 6l6 6-6 6"/></svg>
        ${depth === 0 ? `<i class="gdot" style="background:var(--g-${areaOf(area)})"></i>` : ""}
        <span>${esc(label)}</span><em>${n}</em>
      </button>
      ${open ? draw(d, depth + 1, area) : ""}
    </div>`;
  };
  $("#bn-tree").innerHTML = [...roots.entries()]
    .map(([a, node]) => folder(node, AREAS.includes(a) ? t(`brain.g.${a}`) : a, 0, a)).join("");
}

/* ---------------- search ---------------- */
let searchSeq = 0;
async function searchBrain(q) {
  const seq = ++searchSeq;
  $("#bn-tree").innerHTML = `<div class="sub bt-note">${esc(t("brain.searching"))}</div>`;
  try {
    const r = await api(`/api/brain/search?q=${encodeURIComponent(q)}&limit=30`);
    if (seq !== searchSeq) return;
    bFound = { q, results: r.results ?? [], note: r.note };
  } catch (e) {
    if (seq !== searchSeq) return;
    bFound = { q, results: [], note: errText(e) };
  }
  renderTree();
  if (bMode === "graph") gGlobal?.setMatch(matches());
}

function renderResults() {
  const mark = (s) => esc(s).replace(/«/g, "<mark>").replace(/»/g, "</mark>");
  // an excerpt is raw Markdown: links read as their names, headings and emphasis without the marks
  const plain = (s) => s.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, tg, label) => label ?? tg.trim().split("/").pop())
    .replace(/\[\[[^\]]*$/, "…").replace(/(^|\s)#{1,6}\s/g, "$1").replace(/\*\*|`/g, "").replace(/\s+/g, " ");
  const rows = bFound.results.map((r) => {
    const p = BRAIN.byPath.get(r.path);
    return `<button class="bt-r${r.path === bSel ? " on" : ""}" data-page="${esc(r.path)}">
      <span class="bt-rt"><i class="gdot" style="background:var(--g-${areaOf(p?.area)})"></i>${esc(r.title)}</span>
      <span class="bt-rp">${esc(bare(r.path))}</span>
      ${r.excerpt ? `<span class="bt-rx">${mark(short(plain(r.excerpt), 180))}</span>` : ""}
    </button>`;
  }).join("");
  $("#bn-tree").innerHTML = `<div class="bt-rh"><b>${esc(t("brain.results", { n: bFound.results.length }))}</b>
      <button class="btn sm" data-clear>${esc(t("brain.clear"))}</button></div>
    ${bFound.note ? `<div class="sub bt-note">${esc(/words only|parole/.test(bFound.note) ? t("brain.wordsOnly") : bFound.note)}</div>` : ""}
    ${rows || `<div class="sub bt-note">${esc(t("cat.nothing"))}</div>`}`;
}

/* ---------------- the reader ---------------- */
async function readInto(path) {
  const el = $("#bn-page");
  if (!BRAIN.byPath.get(path)) return;
  if (bPage?.path !== path) el.innerHTML = `<div class="bn-body"><p class="sub">${esc(t("pl.loading"))}</p></div>`;
  try {
    const page = await api(`/api/brain/page?path=${encodeURIComponent(path)}`);
    if (bSel !== path) return; // another page was chosen meanwhile
    const same = bPage?.path === path;
    bPage = page;
    renderPage(!same);
    renderSide();
  } catch (e) {
    el.innerHTML = `<div class="bn-body"><p class="sub">${esc(errText(e))}</p></div>`;
  }
}

function renderPage(top = true) {
  const el = $("#bn-page"), p = bPage;
  const v = bVer;
  const body = (v ? v.body : p.body).replace(/^\s*#\s+.*\n/, ""); // the title is shown above
  const banner = v
    ? `<div class="bn-ver">
        <span>${esc(t("brain.ver.title", { n: v.rev, d: when(v.at), w: who(v.by) }))}</span>
        <span class="seg">
          <button data-vview="read" aria-pressed="${!v.diff}">${esc(t("brain.ver.read"))}</button>
          <button data-vview="diff" aria-pressed="${!!v.diff}">${esc(t("brain.ver.diff"))}</button>
        </span>
        <button class="btn sm" data-vclose>${esc(t("brain.ver.back"))}</button>
      </div>`
    : "";
  el.innerHTML = `<div class="bn-body">
    <div class="bn-crumb">${bare(p.path).split("/").map(esc).join(" <span>/</span> ")}</div>
    <h1 class="bn-title">${esc(p.title)}</h1>
    <div class="bn-meta">
      <i class="gdot" style="background:var(--g-${areaOf(p.area)})"></i>${esc(AREAS.includes(p.area) ? t(`brain.g.${p.area}`) : p.area)}
      <span title="${esc(when(p.updated))}">${esc(t("brain.updatedBy", { d: ago(p.updated), w: who(p.by) }))}</span>
      <span class="chip">${esc(t("brain.rev", { n: p.rev }))}</span>
    </div>
    ${banner}
    ${v?.diff ? diffHtml(v.body, p.body) : `<div class="md bn-md">${mdToHtml(body)}</div>`}
  </div>`;
  if (top) el.scrollTop = 0;
}

function renderSide() {
  const box = $("#bn-links");
  if (!bPage || bPage.path !== bSel) { box.innerHTML = ""; return; }
  const area = (path) => areaOf(BRAIN.byPath.get(path)?.area);
  const row = (path, label) =>
    `<button class="bl" data-page="${esc(path)}"><i class="gdot" style="background:var(--g-${area(path)})"></i><span>${esc(label)}</span></button>`;
  const back = bPage.links.back.map((x) => BRAIN.byPath.get(x)).filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));
  const out = bPage.links.out.map((l) => l.path ? row(l.path, BRAIN.byPath.get(l.path)?.title ?? bare(l.path))
    : `<span class="bl broken" title="${esc(t("brain.broken"))}"><i class="gdot"></i><span>${esc(l.target)}</span></span>`);
  const versions = bPage.versions.map((x) => `<button class="bv${bVer?.rev === x.rev ? " on" : ""}${x.rev === bPage.rev ? " cur" : ""}" data-rev="${x.rev}">
      <b>${esc(String(x.rev))}</b><span>${esc(ago(x.at))} · ${esc(who(x.by))}</span><em>${esc(t(`brain.op.${x.op}`))}</em>
    </button>`).join("");
  box.innerHTML = `
    <div class="panel-h"><h3>${esc(t("brain.backlinks"))}</h3><span class="r">${back.length}</span></div>
    <div class="bl-list">${back.map((p) => row(p.path, p.title)).join("") || `<span class="sub">${esc(t("brain.none"))}</span>`}</div>
    <div class="panel-h"><h3>${esc(t("brain.outlinks"))}</h3><span class="r">${out.length}</span></div>
    <div class="bl-list">${out.join("") || `<span class="sub">${esc(t("brain.none"))}</span>`}</div>
    <div class="panel-h"><h3>${esc(t("brain.versions"))}</h3><span class="r">${bPage.versions.length}</span></div>
    <div class="bl-list">${versions}</div>`;
}

async function showVersion(rev) {
  if (!bPage) return;
  if (rev === bPage.rev) { bVer = null; renderPage(false); renderSide(); return; }
  try {
    const r = await api(`/api/brain/page?path=${encodeURIComponent(bPage.path)}&rev=${rev}`);
    bVer = { rev, body: r.body, at: r.at, by: r.by, diff: bVer?.diff ?? true };
    renderPage(false);
    renderSide();
  } catch (e) { toast(errText(e), true); }
}

/** Pure: the lines of two texts as kept, removed and added (a longest common subsequence: pages
    are a few hundred lines at most). */
function lineDiff(a, b) {
  const x = a.split("\n"), y = b.split("\n"), n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push([" ", x[i]]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push(["-", x[i++]]);
    else out.push(["+", y[j++]]);
  }
  while (i < n) out.push(["-", x[i++]]);
  while (j < m) out.push(["+", y[j++]]);
  return out;
}

/** The old version against the current one, changed lines with three lines of context around. */
function diffHtml(old, cur) {
  const d = lineDiff(old, cur);
  const near = d.map((_, k) => d.slice(Math.max(0, k - 3), k + 4).some(([op]) => op !== " "));
  if (!d.some(([op]) => op !== " ")) return `<p class="sub">${esc(t("brain.ver.same"))}</p>`;
  let gap = false;
  const rows = d.map(([op, line], k) => {
    if (!near[k]) { const g = gap ? "" : `<div class="df-gap">⋯</div>`; gap = true; return g; }
    gap = false;
    return `<div class="df-l${op === "+" ? " add" : op === "-" ? " del" : ""}"><i>${op === " " ? "" : op}</i><span>${esc(line) || "&nbsp;"}</span></div>`;
  }).join("");
  return `<p class="sub bn-dlegend">${esc(t("brain.ver.legend"))}</p><div class="df">${rows}</div>`;
}

/* ---------------- a force graph on a canvas ---------------- */
/** A small live graph in the way of Obsidian's: nodes repel, links pull, the whole drifts to the
    centre; drag a node, drag the background to pan, wheel to zoom, hover lights a node's
    neighbours. No library: a hundred pages settle in a few hundred frames, and O(n²) repulsion
    is nothing at that size. */
function forceGraph(canvas, { onClick, onOpen, charge = 260, distance = 60, labelRoom = 0 } = {}) {
  const ctx = canvas.getContext("2d");
  let nodes = [], links = [], byId = new Map(), adj = new Map(), top = new Set();
  let tf = { k: 1, x: 0, y: 0 }, alpha = 0, raf = 0, W = 0, H = 0, dpr = 1, moved = false, fitted = false;
  let hover = null, drag = null, pan = null, selected = null, match = null, colorsAt = 0;
  const colors = {};

  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    for (const g of [...AREAS, "other"]) colors[g] = cs.getPropertyValue(`--g-${g}`).trim() || "#888";
    for (const k of ["line", "fg", "fg-dim", "fg-faint", "accent", "surface"]) colors[k] = cs.getPropertyValue(`--${k}`).trim();
    colorsAt = Date.now();
  };
  const radius = (n) => 3.5 + Math.sqrt(n.deg) * 1.9;
  const world = (sx, sy) => ({ x: (sx - tf.x) / tf.k, y: (sy - tf.y) / tf.k });
  const nodeAt = (sx, sy) => {
    const p = world(sx, sy);
    let best = null, bd = Infinity;
    for (const n of nodes) {
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < radius(n) + 5 / tf.k && d < bd) { best = n; bd = d; }
    }
    return best;
  };

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = r.width; H = r.height;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    if (!moved) fit();
    draw();
  }
  /** Everything in view; `labelRoom` keeps space on the right for the labels drawn there. */
  function fit(pad = 40) {
    if (!nodes.length || !W) return;
    const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const room = Math.min(labelRoom, W / 3);
    const k = Math.min((W - pad * 2 - room) / Math.max(x1 - x0, 1), (H - pad * 2) / Math.max(y1 - y0, 1), 2.2);
    tf = { k, x: (W - room) / 2 - (x0 + x1) / 2 * k, y: H / 2 - (y0 + y1) / 2 * k };
  }

  function tick() {
    const N = nodes.length;
    for (let i = 0; i < N; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < N; j++) {
        const b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - .5; dy = Math.random() - .5; d2 = 1; }
        if (d2 > 250000) continue; // far apart: no measurable push
        const w = -charge * alpha / d2;
        a.vx += dx * w; a.vy += dy * w; b.vx -= dx * w; b.vy -= dy * w;
      }
    }
    for (const l of links) {
      const dx = l.t.x + l.t.vx - l.s.x - l.s.vx, dy = l.t.y + l.t.vy - l.s.y - l.s.vy;
      const d = Math.hypot(dx, dy) || 1, k = (d - distance) / d * alpha * (0.9 / Math.min(l.s.deg, l.t.deg));
      l.t.vx -= dx * k * .5; l.t.vy -= dy * k * .5; l.s.vx += dx * k * .5; l.s.vy += dy * k * .5;
    }
    for (const n of nodes) {
      // pages with no links would drift to the edge and shrink the picture when it is fitted
      const g = n.deg ? .03 : .12;
      n.vx -= n.x * g * alpha; n.vy -= n.y * g * alpha;
      if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = n.vy = 0; continue; }
      n.vx *= .6; n.vy *= .6;
      n.x += n.vx; n.y += n.vy;
    }
    alpha += (0 - alpha) * .0228;
  }

  function draw() {
    if (!W || !H) return;
    if (Date.now() - colorsAt > 1500) readColors();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.translate(tf.x, tf.y);
    ctx.scale(tf.k, tf.k);
    const focus = hover ?? selected;
    const near = focus ? adj.get(focus.id) : null;
    const lit = (n) => !focus || n === focus || near.has(n.id);
    const inMatch = (n) => !match || match.has(n.id);
    ctx.lineCap = "round";
    for (const l of links) {
      const hot = focus && (l.s === focus || l.t === focus);
      const dim = (match && !(match.has(l.s.id) && match.has(l.t.id))) || (focus && !hot);
      ctx.globalAlpha = hot ? .95 : dim ? .08 : .32;
      ctx.strokeStyle = hot ? colors.accent : colors["fg-faint"];
      ctx.lineWidth = (hot ? 1.8 : 1) / tf.k;
      ctx.beginPath(); ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y); ctx.stroke();
    }
    for (const n of nodes) {
      const r = radius(n);
      ctx.globalAlpha = lit(n) && inMatch(n) ? 1 : .18;
      ctx.fillStyle = colors[n.group] ?? colors.other;
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
      if (n === selected) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = colors.fg;
        ctx.lineWidth = 2 / tf.k;
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 3 / tf.k, 0, Math.PI * 2); ctx.stroke();
      }
    }
    // labels: what is in focus, what matches a search, the big hubs, and everything once zoomed in
    const fs = 12 / tf.k;
    ctx.font = `500 ${fs}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (const n of nodes) {
      const show = n === focus || (near && near.has(n.id)) || (match && match.has(n.id) && match.size <= 40) ||
        (!focus && !match && (tf.k > 1.25 || top.has(n.id)));
      if (!show) continue;
      const label = n.title.length > 38 ? n.title.slice(0, 37) + "…" : n.title;
      const x = n.x + radius(n) + 4 / tf.k;
      ctx.globalAlpha = lit(n) && inMatch(n) ? 1 : .35;
      ctx.lineWidth = 3.5 / tf.k;
      ctx.strokeStyle = colors.surface;
      ctx.strokeText(label, x, n.y);
      ctx.fillStyle = n === focus ? colors.fg : colors["fg-dim"];
      ctx.fillText(label, x, n.y);
    }
    ctx.globalAlpha = 1;
  }

  function frame() {
    raf = 0;
    if (alpha > .004) {
      tick();
      if (!moved && !fitted) fit();
      if (alpha < .2) fitted = true;
    }
    draw();
    if (alpha > .004 || drag) raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };

  // pointer: a node drags, the background pans; a press without a move is a click
  let down = null;
  canvas.addEventListener("pointerdown", (e) => {
    const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    const n = nodeAt(sx, sy);
    down = { sx, sy, n, far: false };
    canvas.setPointerCapture(e.pointerId);
    if (n) { drag = n; n.fx = n.x; n.fy = n.y; }
    else pan = { x: tf.x, y: tf.y };
  });
  canvas.addEventListener("pointermove", (e) => {
    const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (down && Math.hypot(sx - down.sx, sy - down.sy) > 4) down.far = true;
    if (drag && down?.far) {
      const p = world(sx, sy);
      drag.fx = p.x; drag.fy = p.y;
      alpha = Math.max(alpha, .25);
      kick();
      return;
    }
    if (pan && down?.far) {
      tf.x = pan.x + sx - down.sx; tf.y = pan.y + sy - down.sy;
      moved = true;
      draw();
      return;
    }
    if (!down) {
      const n = nodeAt(sx, sy);
      if (n !== hover) { hover = n; canvas.style.cursor = n ? "pointer" : "grab"; draw(); }
    }
  });
  const up = () => {
    if (!down) return;
    if (drag) { drag.fx = drag.fy = null; }
    if (!down.far) onClick?.(down.n ? down.n.id : null);
    drag = pan = down = null;
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("pointerleave", () => { if (!down && hover) { hover = null; draw(); } });
  canvas.addEventListener("dblclick", (e) => {
    const r = canvas.getBoundingClientRect();
    const n = nodeAt(e.clientX - r.left, e.clientY - r.top);
    if (n) onOpen?.(n.id);
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    const k = Math.min(6, Math.max(.15, tf.k * Math.exp(-e.deltaY * .0015)));
    tf.x = sx - (sx - tf.x) * k / tf.k; tf.y = sy - (sy - tf.y) * k / tf.k; tf.k = k;
    moved = true;
    draw();
  }, { passive: false });
  new ResizeObserver(resize).observe(canvas);

  return {
    /** New data; nodes already there keep their place, so a change does not reshuffle the picture. */
    setData(ns, ls) {
      const old = new Map(nodes.map((n) => [n.id, n]));
      nodes = ns.map((n, i) => {
        const o = old.get(n.id);
        if (o) return Object.assign(o, n);
        const a = i * 2.4; // a spiral start settles faster than noise
        return { ...n, x: Math.cos(a) * (8 + i * 2.2), y: Math.sin(a) * (8 + i * 2.2), vx: 0, vy: 0 };
      });
      byId = new Map(nodes.map((n) => [n.id, n]));
      links = ls.map(([a, b]) => ({ s: byId.get(a), t: byId.get(b) })).filter((l) => l.s && l.t && l.s !== l.t);
      adj = new Map(nodes.map((n) => [n.id, new Set()]));
      for (const l of links) { adj.get(l.s.id).add(l.t.id); adj.get(l.t.id).add(l.s.id); }
      for (const n of nodes) n.deg = adj.get(n.id).size;
      top = new Set([...nodes].sort((a, b) => b.deg - a.deg).slice(0, 8).map((n) => n.id));
      const fresh = nodes.some((n) => !old.has(n.id)) || nodes.length !== old.size;
      if (fresh) {
        // most of the settling happens before the first frame: the graph opens in order, and
        // keeps moving only when touched
        alpha = 1;
        for (let i = 0; i < 260 && alpha > .03; i++) tick();
        moved = false;
        fitted = true;
        fit();
      }
      if (selected) selected = byId.get(selected.id) ?? null;
      readColors();
      kick();
    },
    select(id) { selected = id ? byId.get(id) ?? null : null; draw(); },
    setMatch(set) { match = set; draw(); },
    refit() { moved = false; fitted = false; fit(); draw(); },
    resize,
  };
}

/* ---------------- the two graphs ---------------- */
let gLocal = null, gGlobal = null;
const nodeOf = (p) => ({ id: p.path, title: p.title, group: areaOf(p.area) });

function showLocalGraph() {
  if (!bSel) return;
  gLocal ??= forceGraph($("#bn-local"), { onClick: (id) => id && id !== bSel && selectPage(id), onOpen: selectPage, charge: 180, distance: 55, labelRoom: 110 });
  const ids = new Set([bSel]);
  const grow = () => {
    for (const id of [...ids]) {
      for (const x of BRAIN.out.get(id) ?? []) ids.add(x);
      for (const x of BRAIN.in.get(id) ?? []) ids.add(x);
    }
  };
  grow();
  if (bDepth2) grow();
  const pages = [...ids].map((id) => BRAIN.byPath.get(id)).filter(Boolean);
  gLocal.setData(pages.map(nodeOf), BRAIN.edges.filter(([a, b]) => ids.has(a) && ids.has(b)));
  gLocal.select(bSel);
  gLocal.resize();
}

function showGlobalGraph() {
  gGlobal ??= forceGraph($("#bn-canvas"), {
    charge: 420, distance: 80,
    onClick: (id) => { bSel = id ?? bSel; gGlobal.select(id); renderCard(id); },
    onOpen: (id) => { bMode = "read"; remember(); selectPage(id); },
  });
  const pages = BRAIN.pages.filter((p) => !bOff.has(areaOf(p.area)));
  const ids = new Set(pages.map((p) => p.path));
  gGlobal.setData(pages.map(nodeOf), BRAIN.edges.filter(([a, b]) => ids.has(a) && ids.has(b)));
  gGlobal.setMatch(matches());
  gGlobal.select(bSel);
  gGlobal.resize();
  const present = new Set(BRAIN.pages.map((p) => areaOf(p.area)));
  $("#bn-legend").innerHTML = [...AREAS, "other"].filter((g) => present.has(g)).map((g) =>
    `<button class="lg${bOff.has(g) ? " off" : ""}" data-group="${g}"><i style="background:var(--g-${g})"></i>${esc(t(`brain.g.${g}`))}</button>`
  ).join("");
  renderCard(ids.has(bSel) ? bSel : null);
}

function renderCard(id) {
  const el = $("#bn-card");
  const p = id && BRAIN.byPath.get(id);
  el.hidden = !p;
  if (!p) return;
  const nIn = BRAIN.in.get(id)?.size ?? 0, nOut = BRAIN.out.get(id)?.size ?? 0;
  el.innerHTML = `<div class="sub">${esc(bare(p.path))}</div>
    <b>${esc(p.title)}</b>
    <div class="sub">${esc(t("brain.updatedBy", { d: ago(p.updated), w: who(p.by) }))}</div>
    <div class="sub">${esc(t("brain.linkCount", { i: nIn, o: nOut }))}</div>
    <button class="btn primary sm" data-read="${esc(p.path)}">${esc(t("brain.read"))}</button>`;
}

/* ---------------- events ---------------- */
{
  const root = $("#v-brain");
  $("#bn-modes").addEventListener("click", (e) => {
    const b = e.target.closest("[data-bmode]");
    if (!b || !BRAIN) return;
    bMode = b.dataset.bmode;
    remember();
    renderBrainAll();
    // a page picked in the graph is the one to read
    if (bMode === "read" && bSel && bPage?.path !== bSel) readInto(bSel);
  });
  let qTimer = null;
  $("#b-q").addEventListener("input", () => {
    clearTimeout(qTimer);
    if (!BRAIN) return;
    searchSeq++; // a search still on its way is for a query no longer there
    qTimer = setTimeout(() => { renderTree(); if (bMode === "graph") gGlobal?.setMatch(matches()); }, 120);
  });
  $("#b-q").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.target.value = ""; bFound = null; renderTree(); gGlobal?.setMatch(null); return; }
    if (e.key !== "Enter" || !BRAIN) return;
    const q = e.target.value.trim();
    if (!q) return;
    // a second Enter on the same results opens the first one
    if (bFound?.q === q) { const first = bFound.results[0]; if (first) selectPage(first.path); return; }
    searchBrain(q);
  });
  $("#bn-d2").addEventListener("change", (e) => { bDepth2 = e.target.checked; showLocalGraph(); });
  $("#bn-fit").addEventListener("click", () => gGlobal?.refit());
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-clear]")) { $("#b-q").value = ""; bFound = null; renderTree(); gGlobal?.setMatch(null); return; }
    const d = e.target.closest("[data-dir]");
    if (d) {
      const k = d.dataset.dir;
      bOpen.has(k) ? bOpen.delete(k) : bOpen.add(k);
      remember();
      return renderTree();
    }
    const rv = e.target.closest("[data-rev]");
    if (rv) return void showVersion(Number(rv.dataset.rev));
    const vv = e.target.closest("[data-vview]");
    if (vv && bVer) { bVer.diff = vv.dataset.vview === "diff"; return renderPage(false); }
    if (e.target.closest("[data-vclose]")) { bVer = null; renderPage(false); return renderSide(); }
    const pg = e.target.closest("[data-page]");
    if (pg) {
      e.preventDefault();
      const path = resolvePage(pg.dataset.page);
      return path ? selectPage(path) : toast(t("brain.missing", { p: pg.dataset.page }), true);
    }
    const rd = e.target.closest("[data-read]");
    if (rd) { bMode = "read"; remember(); return selectPage(rd.dataset.read); }
    const lg = e.target.closest("[data-group]");
    if (lg) {
      const g = lg.dataset.group;
      bOff.has(g) ? bOff.delete(g) : bOff.add(g);
      return showGlobalGraph();
    }
  });
}

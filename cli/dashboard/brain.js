/* claude-multi console — the Brain: the wiki (~/brains/claude) the way Obsidian shows it. Pages as a
   tree of folders, a reader with what links in and out, the page's neighbourhood as a small live
   graph, and the whole graph on its own screen. A view: pages are written by Claude through
   /wiki-ingest, never from here; what the console adds goes to _raw/, the inbox.
   Loaded after app.js (helpers: $, esc, api, t, toast, drawer, mdToHtml, ago). */

const GROUPS = ["projects", "references", "concepts", "skills", "entities", "synthesis", "journal"];
const groupOf = (g) => GROUPS.includes(g) ? g : "other";
/** Pages that link to everything (the index, the log): in a graph they are a star that hides the
    structure, so the graph leaves them out unless asked. They stay in the tree and the reader. */
const HUBS = new Set(["index", "log", "CONVENTIONS", "README", "hot"]);
let BRAIN = null, bSel = null, bMode = "read", bShowHubs = false, bDepth2 = false, bOff = new Set(), bOpen = new Set(["projects"]);
let bPage = null; // the page on screen: { path, body, data }
try {
  bMode = localStorage.getItem("cm-bmode") === "graph" ? "graph" : "read";
  bOpen = new Set(JSON.parse(localStorage.getItem("cm-bopen") ?? '["projects"]'));
} catch { /* storage blocked: defaults */ }
const remember = () => { try { localStorage.setItem("cm-bopen", JSON.stringify([...bOpen])); localStorage.setItem("cm-bmode", bMode); } catch { /* not remembered */ } };

async function loadBrain() {
  BRAIN = await api("/api/brain");
  BRAIN.byPath = new Map(BRAIN.pages.map((p) => [p.path, p]));
  BRAIN.out = new Map(), BRAIN.in = new Map();
  for (const [a, b] of BRAIN.links) {
    if (!BRAIN.out.has(a)) BRAIN.out.set(a, new Set());
    if (!BRAIN.in.has(b)) BRAIN.in.set(b, new Set());
    BRAIN.out.get(a).add(b);
    BRAIN.in.get(b).add(a);
  }
  if (bSel && !BRAIN.byPath.has(bSel)) bSel = null;
  bSel ??= BRAIN.byPath.has("index") ? "index" : BRAIN.pages[0]?.path ?? null;
  renderBrainAll();
  if (bSel && bPage?.path !== bSel) readInto(bSel);
}

function renderBrainAll() {
  if (!BRAIN) return;
  $$("#bn-modes [data-bmode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.bmode === bMode)));
  $("#bn-read").hidden = bMode !== "read";
  $("#bn-graph").hidden = bMode !== "graph";
  $("#b-sum").textContent = t("brain.sum", { p: BRAIN.pages.length, l: BRAIN.links.length });
  renderTree();
  renderSide();
  renderInboxBadge();
  if (bMode === "graph") showGlobalGraph();
  else showLocalGraph();
}

/** Opens a page in the reader from elsewhere (a task's attachment, a link). */
function openBrainPage(target) {
  const path = resolvePage(target);
  if (!path) return toast(t("brain.missing", { p: target }), true);
  bMode = "read";
  remember();
  selectPage(path);
}

/** A wikilink target to a page: the full path, or the one page with that file name. */
function resolvePage(target) {
  if (!BRAIN || !target) return null;
  const tg = String(target).replace(/\.md$/, "").replace(/^\/+/, "");
  if (BRAIN.byPath.has(tg)) return tg;
  const name = tg.split("/").pop();
  const hits = BRAIN.pages.filter((p) => p.path.split("/").pop() === name);
  return hits.length === 1 ? hits[0].path : null;
}

function selectPage(path) {
  bSel = path;
  // the folders down to the page open in the tree
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) bOpen.add(parts.slice(0, i).join("/"));
  remember();
  renderBrainAll();
  readInto(path);
  $(`#bn-tree [data-page="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" });
}

/* ---------------- the tree ---------------- */
function matches() {
  const q = $("#b-q").value.trim().toLowerCase();
  if (!q) return null;
  return new Set(BRAIN.pages.filter((p) => `${p.title} ${p.path} ${p.summary} ${p.tags.join(" ")}`.toLowerCase().includes(q)).map((p) => p.path));
}

function renderTree() {
  const hits = matches();
  const root = { dirs: new Map(), pages: [] };
  for (const p of BRAIN.pages) {
    if (hits && !hits.has(p.path)) continue;
    const parts = p.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), pages: [], path: parts.slice(0, i + 1).join("/") });
      node = node.dirs.get(parts[i]);
    }
    node.pages.push(p);
  }
  const count = (n) => n.pages.length + [...n.dirs.values()].reduce((s, d) => s + count(d), 0);
  const draw = (node, depth) => {
    // a project folder usually has a page with its own name: that page stands for the folder
    const dirs = [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b));
    const pages = [...node.pages].sort((a, b) => a.title.localeCompare(b.title));
    return dirs.map(([name, d]) => {
      const open = hits ? true : bOpen.has(d.path);
      const g = depth === 0 ? groupOf(name) : null;
      return `<div class="bt-dir${open ? " open" : ""}">
        <button class="bt-f" data-dir="${esc(d.path)}" style="--d:${depth}">
          <svg viewBox="0 0 24 24" class="ico chev"><path d="M9 6l6 6-6 6"/></svg>
          ${g ? `<i class="gdot" style="background:var(--g-${g})"></i>` : ""}
          <span>${esc(depth === 0 && GROUPS.includes(name) ? t(`brain.g.${name}`) : name)}</span><em>${count(d)}</em>
        </button>
        ${open ? draw(d, depth + 1) : ""}
      </div>`;
    }).join("") + pages.map((p) =>
      `<button class="bt-p${p.path === bSel ? " on" : ""}" data-page="${esc(p.path)}" style="--d:${depth}" title="${esc(p.path)}">${esc(p.title)}</button>`
    ).join("");
  };
  $("#bn-tree").innerHTML = draw(root, 0) || `<div class="sub" style="padding:10px">${esc(t("cat.nothing"))}</div>`;
}

/* ---------------- the reader ---------------- */
async function readInto(path) {
  const el = $("#bn-page");
  const p = BRAIN.byPath.get(path);
  if (!p) return;
  if (bPage?.path !== path) el.innerHTML = `<div class="bn-body"><p class="sub">${esc(t("pl.loading"))}</p></div>`;
  try {
    const page = await api(`/api/brain/page?path=${encodeURIComponent(path)}`);
    if (bSel !== path) return; // another page was chosen meanwhile
    bPage = page;
    const body = page.body.replace(/^\s*#\s+.*\n/, ""); // the title is shown above
    const vault = BRAIN.root.split("/").pop();
    const chips = [p.category && p.category !== p.group ? p.category : null, p.lifecycle].filter(Boolean);
    el.innerHTML = `<div class="bn-body">
      <div class="bn-crumb">${path.split("/").map(esc).join(" <span>/</span> ")}</div>
      <h1 class="bn-title">${esc(p.title)}</h1>
      <div class="bn-meta">
        <i class="gdot" style="background:var(--g-${groupOf(p.group)})"></i>${esc(t(`brain.g.${groupOf(p.group)}`))}
        ${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join("")}
        ${p.updated ? `<span>${esc(t("brain.updated", { d: ago(p.updated) }))}</span>` : ""}
        <a class="btn sm" href="obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(p.path)}">${esc(t("brain.obsidian"))}</a>
      </div>
      ${p.tags.length ? `<div class="bn-tags">${p.tags.map((x) => `<button class="tag" data-tag="${esc(x)}">#${esc(x)}</button>`).join("")}</div>` : ""}
      ${p.summary ? `<p class="bn-sum">${esc(p.summary)}</p>` : ""}
      <div class="md bn-md">${mdToHtml(body)}</div>
    </div>`;
    el.scrollTop = 0;
  } catch (e) {
    el.innerHTML = `<div class="bn-body"><p class="sub">${esc(e.message)}</p></div>`;
  }
}

function renderSide() {
  const box = $("#bn-links");
  if (!bSel) { box.innerHTML = ""; return; }
  const out = [...(BRAIN.out.get(bSel) ?? [])], inn = [...(BRAIN.in.get(bSel) ?? [])];
  const list = (xs) => xs.map((x) => BRAIN.byPath.get(x)).filter(Boolean).sort((a, b) => a.title.localeCompare(b.title))
    .map((p) => `<button class="bl" data-page="${esc(p.path)}"><i class="gdot" style="background:var(--g-${groupOf(p.group)})"></i><span>${esc(p.title)}</span></button>`).join("");
  box.innerHTML = `
    <div class="panel-h"><h3>${esc(t("brain.backlinks"))}</h3><span class="r">${inn.length}</span></div>
    <div class="bl-list">${list(inn) || `<span class="sub">${esc(t("brain.none"))}</span>`}</div>
    <div class="panel-h"><h3>${esc(t("brain.outlinks"))}</h3><span class="r">${out.length}</span></div>
    <div class="bl-list">${list(out) || `<span class="sub">${esc(t("brain.none"))}</span>`}</div>`;
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
  let hover = null, drag = null, pan = null, selected = null, match = null, colors = {}, colorsAt = 0;

  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    for (const g of [...GROUPS, "other"]) colors[g] = cs.getPropertyValue(`--g-${g}`).trim() || "#888";
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
const nodeOf = (p) => ({ id: p.path, title: p.title, group: groupOf(p.group) });

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
  // the hubs only when they are the page, or on request: otherwise every neighbourhood includes them
  for (const h of HUBS) if (h !== bSel && !bShowHubs) ids.delete(h);
  const pages = [...ids].map((id) => BRAIN.byPath.get(id)).filter(Boolean);
  gLocal.setData(pages.map(nodeOf), BRAIN.links.filter(([a, b]) => ids.has(a) && ids.has(b)));
  gLocal.select(bSel);
  gLocal.resize();
}

function showGlobalGraph() {
  gGlobal ??= forceGraph($("#bn-canvas"), {
    charge: 420, distance: 80,
    onClick: (id) => { bSel = id ?? bSel; gGlobal.select(id); renderCard(id); },
    onOpen: (id) => { bMode = "read"; remember(); selectPage(id); },
  });
  const pages = BRAIN.pages.filter((p) => (bShowHubs || !HUBS.has(p.path)) && !bOff.has(groupOf(p.group)));
  const ids = new Set(pages.map((p) => p.path));
  gGlobal.setData(pages.map(nodeOf), BRAIN.links.filter(([a, b]) => ids.has(a) && ids.has(b)));
  gGlobal.setMatch(matches());
  gGlobal.select(bSel);
  gGlobal.resize();
  const present = new Set(BRAIN.pages.map((p) => groupOf(p.group)));
  $("#bn-legend").innerHTML = [...GROUPS, "other"].filter((g) => present.has(g)).map((g) =>
    `<button class="lg${bOff.has(g) ? " off" : ""}" data-group="${g}"><i style="background:var(--g-${g})"></i>${esc(t(`brain.g.${g}`))}</button>`
  ).join("");
  $("#bn-hubs").checked = bShowHubs;
  renderCard(ids.has(bSel) ? bSel : null);
}

function renderCard(id) {
  const el = $("#bn-card");
  const p = id && BRAIN.byPath.get(id);
  el.hidden = !p;
  if (!p) return;
  const nIn = BRAIN.in.get(id)?.size ?? 0, nOut = BRAIN.out.get(id)?.size ?? 0;
  el.innerHTML = `<div class="sub">${esc(p.path)}</div>
    <b>${esc(p.title)}</b>
    ${p.summary ? `<p>${esc(short(p.summary, 220))}</p>` : ""}
    <div class="sub">${esc(t("brain.linkCount", { i: nIn, o: nOut }))}</div>
    <button class="btn primary sm" data-read="${esc(p.path)}">${esc(t("brain.read"))}</button>`;
}

/* ---------------- adding to the brain ---------------- */
function renderInboxBadge() {
  const n = BRAIN.inbox.length;
  $("#b-add").innerHTML = `${esc(t("brain.add"))}${n ? ` <i class="n">${n}</i>` : ""}`;
}

function openAddDrawer() {
  const cmd = "/wiki-ingest process my drafts";
  const items = BRAIN.inbox;
  const host = drawer(t("brain.add"), `<div class="panel-b bn-add">
    <p class="sub">${esc(t("brain.add.lede"))}</p>
    <label class="b-zone" id="b-zone">
      <input type="file" id="b-file" multiple accept=".pdf,.md,.txt,.html,.htm,.docx,.csv,.json" hidden>
      <svg viewBox="0 0 24 24" class="ico"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>
      <span>${esc(t("brain.drop"))}</span>
    </label>
    <form class="b-row" id="b-link"><input name="url" class="search" type="url" placeholder="${esc(t("brain.link.ph"))}" required><button class="btn" type="submit">${esc(t("mk.add"))}</button></form>
    <form class="b-row" id="b-note"><textarea name="text" class="search" rows="3" placeholder="${esc(t("brain.note.ph"))}" required></textarea><button class="btn" type="submit">${esc(t("mk.add"))}</button></form>
    ${items.length ? `<div class="b-inbox"><b>${esc(t("brain.inbox", { n: items.length }))}</b>
      ${items.slice(0, 12).map((f) => `<code title="${esc(f.name)}">${esc(f.name)}</code>`).join("")}
      <span class="sub">${esc(t("brain.inbox.how"))}</span>
      <div class="b-cmd"><code>${esc(cmd)}</code><button class="btn sm" data-copy="${esc(cmd)}">${esc(t("today.copy"))}</button></div></div>` : ""}
  </div>`);
  const send = async (body, headers = {}) => {
    const r = await api("/api/brain/inbox", { method: "POST", headers: { "x-claude-multi": "1", ...headers }, body }).catch((e) => ({ ok: false, message: e.message }));
    toast(r.ok ? t("brain.added", { n: r.message }) : r.message, !r.ok);
    return r.ok;
  };
  const files = async (fs) => { for (const f of fs) await send(f, { "x-filename": encodeURIComponent(f.name) }); host.remove(); await loadBrain(); openAddDrawer(); };
  const zone = $("#b-zone", host);
  $("#b-file", host).addEventListener("change", (e) => files([...e.target.files]));
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("over"); files([...e.dataTransfer.files]); });
  $("#b-link", host).addEventListener("submit", async (e) => {
    e.preventDefault();
    if (await send(JSON.stringify({ kind: "link", url: e.target.elements.url.value.trim() }), { "content-type": "application/json" })) { e.target.reset(); loadBrain(); }
  });
  $("#b-note", host).addEventListener("submit", async (e) => {
    e.preventDefault();
    if (await send(JSON.stringify({ kind: "note", text: e.target.elements.text.value }), { "content-type": "application/json" })) { e.target.reset(); loadBrain(); }
  });
  host.addEventListener("click", (e) => {
    const cp = e.target.closest("[data-copy]");
    if (cp) navigator.clipboard.writeText(cp.dataset.copy).then(() => toast(t("today.copied")), () => toast(cp.dataset.copy, true));
  });
}

/* ---------------- events ---------------- */
{
  const root = $("#v-brain");
  $("#bn-modes").addEventListener("click", (e) => {
    const b = e.target.closest("[data-bmode]");
    if (!b) return;
    bMode = b.dataset.bmode;
    remember();
    renderBrainAll();
  });
  let qTimer = null;
  $("#b-q").addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { renderTree(); if (bMode === "graph") gGlobal?.setMatch(matches()); }, 120);
  });
  $("#b-q").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const first = $("#bn-tree .bt-p");
    if (first) selectPage(first.dataset.page);
  });
  $("#b-add").addEventListener("click", openAddDrawer);
  $("#bn-d2").addEventListener("change", (e) => { bDepth2 = e.target.checked; showLocalGraph(); });
  $("#bn-hubs").addEventListener("change", (e) => { bShowHubs = e.target.checked; showGlobalGraph(); });
  $("#bn-fit").addEventListener("click", () => gGlobal?.refit());
  root.addEventListener("click", (e) => {
    const d = e.target.closest("[data-dir]");
    if (d) {
      const k = d.dataset.dir;
      bOpen.has(k) ? bOpen.delete(k) : bOpen.add(k);
      remember();
      return renderTree();
    }
    const pg = e.target.closest("[data-page]");
    if (pg) {
      e.preventDefault();
      const path = resolvePage(pg.dataset.page);
      return path ? selectPage(path) : toast(t("brain.missing", { p: pg.dataset.page }), true);
    }
    const rd = e.target.closest("[data-read]");
    if (rd) { bMode = "read"; remember(); return selectPage(rd.dataset.read); }
    const tg = e.target.closest("[data-tag]");
    if (tg) { $("#b-q").value = tg.dataset.tag; renderTree(); return; }
    const lg = e.target.closest("[data-group]");
    if (lg) {
      const g = lg.dataset.group;
      bOff.has(g) ? bOff.delete(g) : bOff.add(g);
      return showGlobalGraph();
    }
  });
}

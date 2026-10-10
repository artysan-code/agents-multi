// graph.ts — a small live graph in the way of Obsidian's, laid out by d3-force: pages repel and do
// not overlap, links pull, and each area gathers around its own place so the colours read as
// regions; drag a node, drag the background to pan, wheel to zoom, hover lights a node's neighbours.
// Drawn on a canvas, imperatively: d3 only moves the points. The components own the canvas element
// and call `destroy()` when it goes.

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";
import { AREAS } from "./model.ts";

export interface GNode {
  id: string;
  title: string;
  group: string;
}

interface Node extends GNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx?: number | null;
  fy?: number | null;
  deg: number;
}
interface Link {
  s: Node;
  t: Node;
}

interface GraphOpts {
  onClick?: (id: string | null) => void;
  onOpen?: (id: string) => void;
  charge?: number;
  distance?: number;
  labelRoom?: number;
  cluster?: number;
}

export interface Graph {
  setData(ns: GNode[], ls: [string, string][]): void;
  select(id: string | null): void;
  setMatch(set: Set<string> | null): void;
  refit(): void;
  resize(): void;
  destroy(): void;
}

export function forceGraph(canvas: HTMLCanvasElement, opts: GraphOpts = {}): Graph {
  const { onClick, onOpen, charge = 260, distance = 60, labelRoom = 0, cluster = .05 } = opts;
  const ctx = canvas.getContext("2d")!;
  let nodes: Node[] = [], links: Link[] = [], byId = new Map<string, Node>(), adj = new Map<string, Set<string>>();
  let top = new Set<string>();
  let tf = { k: 1, x: 0, y: 0 }, raf = 0, W = 0, H = 0, dpr = 1, moved = false, fitted = false;
  let hover: Node | null = null, drag: Node | null = null, pan: { x: number; y: number } | null = null;
  let selected: Node | null = null, match: Set<string> | null = null, colorsAt = 0, dead = false;
  const colors: Record<string, string> = {};

  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    for (const g of [...AREAS, "other"]) colors[g] = cs.getPropertyValue(`--g-${g}`).trim() || "#888";
    for (const k of ["line", "fg", "fg-dim", "fg-faint", "accent", "surface"]) {
      colors[k] = cs.getPropertyValue(`--${k}`).trim();
    }
    colorsAt = Date.now();
  };
  const radius = (n: Node) => 3.5 + Math.sqrt(n.deg) * 1.9;
  const world = (sx: number, sy: number) => ({ x: (sx - tf.x) / tf.k, y: (sy - tf.y) / tf.k });
  const nodeAt = (sx: number, sy: number): Node | null => {
    const p = world(sx, sy);
    let best: Node | null = null, bd = Infinity;
    for (const n of nodes) {
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < radius(n) + 5 / tf.k && d < bd) {
        best = n;
        bd = d;
      }
    }
    return best;
  };

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = r.width;
    H = r.height;
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

  // where each area gathers: points on a circle, in the order of AREAS
  const anchors = new Map<string, { x: number; y: number }>();
  const place = () => {
    const groups = [...AREAS, "other"].filter((g) => nodes.some((n) => n.group === g));
    const R = groups.length > 1 ? 30 + Math.sqrt(nodes.length) * 16 : 0;
    groups.forEach((g, i) => {
      const a = i / groups.length * Math.PI * 2 - Math.PI / 2;
      anchors.set(g, { x: Math.cos(a) * R, y: Math.sin(a) * R });
    });
  };
  const anchor = (n: Node) => anchors.get(n.group) ?? { x: 0, y: 0 };
  type SimLink = { source: Node; target: Node };
  const linkForce = forceLink<Node, SimLink>().distance(distance).strength((l) =>
    0.9 / Math.min(l.source.deg, l.target.deg)
  );
  // a page with no links would drift to the edge and shrink the picture: it is held closer
  const pull = (n: Node) => n.deg ? cluster : cluster * 3;
  const sim = forceSimulation<Node>()
    .force("charge", forceManyBody<Node>().strength(-charge / 4).distanceMax(600))
    .force("link", linkForce)
    .force("collide", forceCollide<Node>((n) => radius(n) + 10))
    .force("x", forceX<Node>((n) => anchor(n).x).strength(pull))
    .force("y", forceY<Node>((n) => anchor(n).y).strength(pull))
    .stop(); // the frames below drive it: drawing and settling stay in step
  const tick = () => sim.tick();
  const alpha = () => sim.alpha();

  function draw() {
    if (!W || !H) return;
    if (Date.now() - colorsAt > 1500) readColors();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.translate(tf.x, tf.y);
    ctx.scale(tf.k, tf.k);
    const focus = hover ?? selected;
    const near = focus ? adj.get(focus.id) ?? null : null;
    const lit = (n: Node) => !focus || n === focus || !!near?.has(n.id);
    const inMatch = (n: Node) => !match || match.has(n.id);
    ctx.lineCap = "round";
    for (const l of links) {
      const hot = !!focus && (l.s === focus || l.t === focus);
      const dim = (match && !(match.has(l.s.id) && match.has(l.t.id))) || (focus && !hot);
      ctx.globalAlpha = hot ? .95 : dim ? .08 : .32;
      ctx.strokeStyle = hot ? colors.accent : colors["fg-faint"];
      ctx.lineWidth = (hot ? 1.8 : 1) / tf.k;
      ctx.beginPath();
      ctx.moveTo(l.s.x, l.s.y);
      ctx.lineTo(l.t.x, l.t.y);
      ctx.stroke();
    }
    for (const n of nodes) {
      const r = radius(n);
      ctx.globalAlpha = lit(n) && inMatch(n) ? 1 : .18;
      ctx.fillStyle = colors[n.group] ?? colors.other;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (n === selected) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = colors.fg;
        ctx.lineWidth = 2 / tf.k;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 3 / tf.k, 0, Math.PI * 2);
        ctx.stroke();
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
    if (dead) return;
    if (alpha() > .004) {
      tick();
      if (!moved && !fitted) fit();
      if (alpha() < .2) fitted = true;
    }
    draw();
    if (alpha() > .004 || drag) raf = requestAnimationFrame(frame);
  }
  const kick = () => {
    if (!raf && !dead) raf = requestAnimationFrame(frame);
  };

  // pointer: a node drags, the background pans; a press without a move is a click
  let down: { sx: number; sy: number; n: Node | null; far: boolean } | null = null;
  const at = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  };
  const onDown = (e: PointerEvent) => {
    const { sx, sy } = at(e);
    const n = nodeAt(sx, sy);
    down = { sx, sy, n, far: false };
    canvas.setPointerCapture(e.pointerId);
    if (n) {
      drag = n;
      n.fx = n.x;
      n.fy = n.y;
    } else pan = { x: tf.x, y: tf.y };
  };
  const onMove = (e: PointerEvent) => {
    const { sx, sy } = at(e);
    if (down && Math.hypot(sx - down.sx, sy - down.sy) > 4) down.far = true;
    if (drag && down?.far) {
      const p = world(sx, sy);
      drag.fx = p.x;
      drag.fy = p.y;
      sim.alpha(Math.max(alpha(), .25));
      kick();
      return;
    }
    if (pan && down?.far) {
      tf.x = pan.x + sx - down.sx;
      tf.y = pan.y + sy - down.sy;
      moved = true;
      draw();
      return;
    }
    if (!down) {
      const n = nodeAt(sx, sy);
      if (n !== hover) {
        hover = n;
        canvas.style.cursor = n ? "pointer" : "grab";
        draw();
      }
    }
  };
  const up = () => {
    if (!down) return;
    if (drag) drag.fx = drag.fy = null;
    if (!down.far) onClick?.(down.n ? down.n.id : null);
    drag = pan = down = null;
  };
  const onLeave = () => {
    if (!down && hover) {
      hover = null;
      draw();
    }
  };
  const onDbl = (e: MouseEvent) => {
    const { sx, sy } = at(e);
    const n = nodeAt(sx, sy);
    if (n) onOpen?.(n.id);
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const { sx, sy } = at(e);
    const k = Math.min(6, Math.max(.15, tf.k * Math.exp(-e.deltaY * .0015)));
    tf.x = sx - (sx - tf.x) * k / tf.k;
    tf.y = sy - (sy - tf.y) * k / tf.k;
    tf.k = k;
    moved = true;
    draw();
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("dblclick", onDbl);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  return {
    /** New data; nodes already there keep their place, so a change does not reshuffle the picture. */
    setData(ns, ls) {
      const old = new Map(nodes.map((n) => [n.id, n]));
      nodes = ns.map((n, i) => {
        const o = old.get(n.id);
        if (o) return Object.assign(o, n);
        const a = i * 2.4; // a spiral start settles faster than noise
        return { ...n, x: Math.cos(a) * (8 + i * 2.2), y: Math.sin(a) * (8 + i * 2.2), vx: 0, vy: 0, deg: 0 };
      });
      byId = new Map(nodes.map((n) => [n.id, n]));
      links = ls.map(([a, b]) => ({ s: byId.get(a)!, t: byId.get(b)! })).filter((l) => l.s && l.t && l.s !== l.t);
      adj = new Map(nodes.map((n) => [n.id, new Set<string>()]));
      for (const l of links) {
        adj.get(l.s.id)!.add(l.t.id);
        adj.get(l.t.id)!.add(l.s.id);
      }
      for (const n of nodes) n.deg = adj.get(n.id)!.size;
      top = new Set([...nodes].sort((a, b) => b.deg - a.deg).slice(0, 8).map((n) => n.id));
      // d3 reads the anchors, the degrees and the links when it is handed the nodes
      place();
      sim.nodes(nodes);
      linkForce.links(links.map((l) => ({ source: l.s, target: l.t })));
      const fresh = nodes.some((n) => !old.has(n.id)) || nodes.length !== old.size;
      if (fresh) {
        // most of the settling happens before the first frame: the graph opens in order, and
        // keeps moving only when touched
        sim.alpha(1);
        for (let i = 0; i < 300 && alpha() > .03; i++) tick();
        moved = false;
        fitted = true;
        fit();
      }
      if (selected) selected = byId.get(selected.id) ?? null;
      readColors();
      kick();
    },
    select(id) {
      selected = id ? byId.get(id) ?? null : null;
      draw();
    },
    setMatch(set) {
      match = set;
      draw();
    },
    refit() {
      moved = false;
      fitted = false;
      fit();
      draw();
    },
    resize,
    destroy() {
      dead = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      sim.stop();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("dblclick", onDbl);
      canvas.removeEventListener("wheel", onWheel);
    },
  };
}

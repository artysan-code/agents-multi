// pager.tsx — the tabs as a row of panes you can drag between with a finger. The pane you are on is mounted; the one
// beside it joins when a drag begins, follows the finger, and a spring settles it (with the finger's speed) on one or
// the other. Each pane scrolls by itself, so nothing here ever scrolls the page. Sideways wins only when the finger
// clearly goes sideways: up and down is the pane's scroll, a field, a code block that scrolls, or a text selection is
// left alone, and a row that takes the swipe for its own action (swipe.tsx) keeps it.

import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { intentOf, neighbour, rubber, settle, velocityOf } from "./gesture.ts";
import { scrollsSideways, springTo, swipeClaims } from "./motion.ts";
import { tabOf, type View } from "./lib.ts";
import { wide } from "./state.ts";

export interface Entry {
  /** keeps a pane's state while it moves from the side to the middle */
  key: string;
  view: View;
  id?: string;
}

interface Props {
  here: Entry;
  /** the tabs in order */
  tabs: View[];
  render: (e: Entry) => ComponentChildren;
  /** the tab swiped to */
  onGo: (view: View) => void;
}

/** One pane. It plays its entrance only when it appears on its own (a tap on a tab, a link): a pane that joined because
 *  a finger was dragging it in is already moving, and the class is fixed at the first render so it never replays. */
function Pane({ fresh, k, here, children }: { fresh: boolean; k: number; here: boolean; children: ComponentChildren }) {
  const enter = useRef(fresh).current;
  return (
    <section class={`pane scroller${enter ? " enter" : ""}${here ? " here" : ""}`} style={{ "--k": k }} aria-hidden={here ? undefined : true} inert={here ? undefined : true}>
      {children}
    </section>
  );
}

export function Pager({ here, tabs, render, onGo }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [extra, setExtra] = useState<Entry[]>([]);
  const carry = useRef<{ from: number; v: number } | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const live = useRef({ here, tabs, onGo });
  live.current = { here, tabs, onGo };
  const lastKey = useRef(here.key);

  const setOff = (x: number) => root.current?.style.setProperty("--off", `${x}px`);

  // a swipe committed: the route changed, the pane that was beside now is the middle one, still where the finger left
  // it plus the width it had to cross; the spring takes it the rest of the way
  useLayoutEffect(() => {
    if (lastKey.current === here.key) return;
    lastKey.current = here.key;
    stop.current?.();
    const c = carry.current;
    carry.current = null;
    if (!c) {
      // a tap on a tab, a link: the new pane enters by its own animation
      setOff(0);
      setExtra([]);
      return;
    }
    setOff(c.from);
    stop.current = springTo(c.from, 0, c.v, setOff, () => (setOff(0), setExtra([])));
  }, [here.key]);

  useEffect(() => {
    const el = root.current!;
    let g: { id: number; x0: number; y0: number; mode: "pending" | "drag" | "ignore"; dx: number; samples: { x: number; t: number }[]; sides: { left: boolean; right: boolean } | null; width: number; dir: number } | null = null;
    let blockClick = false;

    const entryOf = (view: View): Entry => ({ key: view, view });

    const down = (e: PointerEvent) => {
      if (wide.value || document.querySelector(".scrim") || (e.pointerType === "mouse" && e.button !== 0)) return;
      const target = e.target as Element;
      if (target.closest("input, textarea, select, [contenteditable], [data-noswipe]") || getSelection()?.type === "Range") return;
      if (scrollsSideways(target, el)) return;
      stop.current?.();
      blockClick = false;
      g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, mode: "pending", dx: 0, samples: [{ x: e.clientX, t: e.timeStamp }], sides: swipeClaims.get(e) ?? null, width: el.clientWidth, dir: 0 };
    };

    const move = (e: PointerEvent) => {
      if (!g || e.pointerId !== g.id) return;
      const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      if (g.mode === "pending") {
        const intent = intentOf(dx, dy);
        if (!intent) return;
        // a row that has an action on this side keeps the gesture
        if (intent === "v" || (g.sides && ((dx > 0 && g.sides.right) || (dx < 0 && g.sides.left)))) {
          g.mode = "ignore";
          return;
        }
        g.mode = "drag";
        blockClick = true;
        el.setPointerCapture(e.pointerId);
        el.classList.add("dragging");
        getSelection()?.removeAllRanges();
      }
      if (g.mode !== "drag") return;
      g.dx = dx;
      g.samples.push({ x: e.clientX, t: e.timeStamp });
      if (g.samples.length > 8) g.samples.shift();
      const { here: h, tabs: order } = live.current;
      const next = neighbour(order, tabOf(h.view), dx);
      const dir = next ? (dx < 0 ? 1 : -1) : 0;
      if (dir !== g.dir) {
        g.dir = dir;
        setExtra(next ? [entryOf(next)] : []);
      }
      setOff(next ? dx : rubber(dx, g.width * 0.22));
    };

    const end = (e: PointerEvent, cancelled: boolean) => {
      if (!g || e.pointerId !== g.id) return;
      const was = g;
      g = null;
      if (was.mode !== "drag") return;
      el.classList.remove("dragging");
      setTimeout(() => (blockClick = false), 60);
      const { here: h, tabs: order, onGo: go } = live.current;
      const v = velocityOf(was.samples);
      const next = neighbour(order, tabOf(h.view), was.dx);
      const out = cancelled || !next ? "stay" : settle(was.dx, v, was.width);
      if (out === "stay") {
        stop.current = springTo(was.dx, 0, v * 1000, setOff, () => (setOff(0), setExtra([])));
        return;
      }
      // the pane being left stays mounted while the spring runs
      carry.current = { from: was.dx + (out === "forward" ? was.width : -was.width), v: v * 1000 };
      setExtra([{ key: h.key, view: h.view, id: h.id }]);
      go(next!);
    };

    const up = (e: PointerEvent) => end(e, false);
    const cancel = (e: PointerEvent) => end(e, true);
    const click = (e: Event) => {
      if (blockClick) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("click", click, true);
    return () => {
      stop.current?.();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", cancel);
      el.removeEventListener("click", click, true);
    };
  }, []);

  const mid = tabs.indexOf(tabOf(here.view));
  const panes = [here, ...extra.filter((x) => x.key !== here.key)];
  return (
    <div class={`pager${extra.length ? " moving" : ""}`} ref={root}>
      {panes.map((p) => (
        <Pane key={p.key} fresh={!extra.length} k={tabs.indexOf(tabOf(p.view)) - mid} here={p.key === here.key}>
          {render(p)}
        </Pane>
      ))}
    </div>
  );
}

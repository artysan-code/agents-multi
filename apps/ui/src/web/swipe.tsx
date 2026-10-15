// swipe.tsx — a row you can swipe: to the right or to the left, an action shows under it, follows the finger, and
// happens past a distance or a flick (a spring takes it the rest of the way). Pointer events, no library. Sideways
// only: up and down is the page's scroll, and a gesture that starts on a field or over a text selection is left alone.
// Every action a row offers by swipe is also a button in the row: the swipe is a shortcut, never the only way.

import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { intentOf, rowCommits, rowFollow, velocityOf } from "./gesture.ts";
import { springTo, swipeClaims } from "./motion.ts";
import { Icon, type IconName } from "./ui.tsx";

export interface SwipeAction {
  label: string;
  tone: "ok" | "crit" | "accent";
  icon: IconName;
  run: () => void | Promise<void>;
  /** the row goes away with the action (a deleted chat, a task done) instead of coming back */
  leave?: boolean;
}

interface Props {
  /** shown when the row is dragged to the right */
  right?: SwipeAction;
  /** shown when the row is dragged to the left */
  left?: SwipeAction;
  disabled?: boolean;
  class?: string;
  children: ComponentChildren;
}

export function Swipe({ right, left, disabled, class: cls = "", children }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const live = useRef({ right, left, disabled });
  live.current = { right, left, disabled };
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const el = top.current!, box = root.current!;
    let g: { id: number; x0: number; y0: number; mode: "pending" | "drag" | "ignore"; dx: number; samples: { x: number; t: number }[]; width: number } | null = null;
    let stop: (() => void) | null = null;
    let blockClick = false;

    const set = (x: number) => {
      el.style.transform = x ? `translate3d(${x}px,0,0)` : "";
      box.dataset.side = x > 0 ? "r" : x < 0 ? "l" : "";
    };
    const armed = (on: boolean) => box.classList.toggle("armed", on);

    const down = (e: PointerEvent) => {
      const { right: r, left: l, disabled: off } = live.current;
      swipeClaims.set(e, { right: !!r && !off, left: !!l && !off });
      if (off || (!r && !l) || (e.pointerType === "mouse" && e.button !== 0)) return;
      if ((e.target as Element).closest("input, textarea, select, [data-noswipe]") || getSelection()?.type === "Range") return;
      stop?.();
      blockClick = false;
      g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, mode: "pending", dx: 0, samples: [{ x: e.clientX, t: e.timeStamp }], width: box.clientWidth };
    };
    const move = (e: PointerEvent) => {
      if (!g || e.pointerId !== g.id) return;
      const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      if (g.mode === "pending") {
        const intent = intentOf(dx, dy);
        if (!intent) return;
        const { right: r, left: l } = live.current;
        if (intent === "v" || (dx > 0 && !r) || (dx < 0 && !l)) {
          g.mode = "ignore";
          return;
        }
        g.mode = "drag";
        blockClick = true;
        el.setPointerCapture(e.pointerId);
        box.classList.add("dragging");
        getSelection()?.removeAllRanges();
      }
      if (g.mode !== "drag") return;
      const { right: r, left: l } = live.current;
      g.dx = dx;
      g.samples.push({ x: e.clientX, t: e.timeStamp });
      if (g.samples.length > 8) g.samples.shift();
      const x = rowFollow(dx, !!r, !!l, g.width);
      set(x);
      armed(rowCommits(x, 0, g.width));
    };
    const finish = async (e: PointerEvent, cancelled: boolean) => {
      if (!g || e.pointerId !== g.id) return;
      const was = g;
      g = null;
      if (was.mode !== "drag") return;
      box.classList.remove("dragging");
      const x = rowFollow(was.dx, !!live.current.right, !!live.current.left, was.width);
      const v = velocityOf(was.samples);
      const action = x > 0 ? live.current.right : live.current.left;
      armed(false);
      setTimeout(() => (blockClick = false), 60);
      if (cancelled || !action || !rowCommits(x, v, was.width)) {
        stop = springTo(x, 0, v * 1000, set, () => set(0));
        return;
      }
      if (action.leave) {
        // out of the way, then the space closes, then the action: a list change that reads as one movement
        const out = (x > 0 ? 1 : -1) * was.width;
        await new Promise<void>((done) => (stop = springTo(x, out, v * 1000, set, done)));
        box.style.height = `${box.offsetHeight}px`;
        box.style.transition = "height .2s ease, opacity .2s ease";
        requestAnimationFrame(() => {
          box.style.height = "0px";
          box.style.opacity = "0";
        });
        await new Promise((done) => setTimeout(done, 200));
        try {
          await action.run();
        } finally {
          // still here (the action failed, or the list kept it): bring it back
          if (mounted.current) {
            box.style.transition = "";
            box.style.height = "";
            box.style.opacity = "";
            set(0);
          }
        }
        return;
      }
      stop = springTo(x, 0, v * 1000, set, () => set(0));
      await action.run();
    };
    const up = (e: PointerEvent) => void finish(e, false);
    const cancel = (e: PointerEvent) => void finish(e, true);
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
      mounted.current = false;
      stop?.();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", cancel);
      el.removeEventListener("click", click, true);
    };
  }, []);

  return (
    <div class={`sw ${cls}`} ref={root}>
      {right && (
        <div class={`sw-under r ${right.tone}`} aria-hidden="true">
          <Icon name={right.icon} size={22} />
          <span>{right.label}</span>
        </div>
      )}
      {left && (
        <div class={`sw-under l ${left.tone}`} aria-hidden="true">
          <span>{left.label}</span>
          <Icon name={left.icon} size={22} />
        </div>
      )}
      <div class="sw-top" ref={top}>{children}</div>
    </div>
  );
}

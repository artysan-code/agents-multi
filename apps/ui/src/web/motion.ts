// motion.ts — the DOM side of moving things: the spring that settles a drag (arithmetic in gesture.ts), reduced
// motion, and the note a row leaves for the tab pager so a swipe on a row is not also a swipe between tabs.

import { springDone, springStep } from "./gesture.ts";

const quiet = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
/** Whether the person asked for no motion: springs jump to their end, CSS animations are shortened by the sheet. */
export const reduced = () => !!quiet?.matches;

/** Moves a value from `from` to `to` with a spring, one `frame(x)` per animation frame, `done()` at rest. `v0` is the
 *  speed the finger had (px per second). Returns a function that stops it where it is (no `done`). */
export function springTo(from: number, to: number, v0: number, frame: (x: number) => void, done?: () => void): () => void {
  if (reduced() || from === to) {
    frame(to);
    done?.();
    return () => {};
  }
  let x = from, v = v0, last = performance.now(), raf = 0, fallback = 0, live = true;
  // an animation frame, or a timer when the browser holds frames back (a pane that is not on screen): the spring
  // must always end where it should
  const next = () => {
    raf = requestAnimationFrame(tick);
    fallback = setTimeout(tick, 48) as unknown as number;
  };
  const tick = () => {
    if (!live) return;
    cancelAnimationFrame(raf);
    clearTimeout(fallback);
    const now = performance.now();
    const dt = Math.max(0, Math.min((now - last) / 1000, 1 / 20));
    last = now;
    [x, v] = springStep(x, v, to, dt);
    if (springDone(x, v, to)) {
      frame(to);
      live = false;
      done?.();
      return;
    }
    frame(x);
    next();
  };
  next();
  return () => {
    live = false;
    cancelAnimationFrame(raf);
    clearTimeout(fallback);
  };
}

/** Which sides a row consumes a sideways swipe on. The row writes it on the pointerdown it handles first; the pager,
 *  higher up, reads it on the same event and leaves that direction to the row. */
export interface SwipeSides {
  left: boolean;
  right: boolean;
}
export const swipeClaims = new WeakMap<Event, SwipeSides>();

/** Whether something between `from` and `stop` scrolls sideways (a code block, a table): a swipe that starts on it
 *  scrolls it, it never changes the tab. */
export function scrollsSideways(from: Element | null, stop: Element): boolean {
  for (let el = from; el && el !== stop; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 2) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
  }
  return false;
}

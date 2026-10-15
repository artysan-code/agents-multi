// gesture.ts — the arithmetic of swiping, with no DOM so a test can run it: which way a finger is going, how far a
// row or a view follows it, where it settles, and the spring that takes it there. The DOM side is swipe.tsx
// (rows) and pager.tsx (the tabs).

/** Pure: whether a drag is going sideways (`h`), up or down (`v`), or has not moved enough to say (null). Sideways
 *  must clearly win, so a diagonal scroll never swipes. */
export function intentOf(dx: number, dy: number, slop = 10): "h" | "v" | null {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ax < slop && ay < slop) return null;
  return ax > ay * 1.4 ? "h" : "v";
}

/** Pure: the finger's distance as the view moves it. Past the end (nothing to go to) it resists: the further, the
 *  less it follows, never past `limit` (a rubber band). */
export function rubber(dx: number, limit: number): number {
  const a = Math.abs(dx);
  return Math.sign(dx) * limit * (1 - 1 / (a / limit * 0.55 + 1));
}

/** Pure: the tab a swipe of `dx` pixels (negative: to the left) leads to, or the same one. */
export function neighbour<T>(order: T[], here: T, dx: number): T | null {
  const i = order.indexOf(here);
  if (i < 0 || dx === 0) return null;
  return order[i + (dx < 0 ? 1 : -1)] ?? null;
}

/** Pure: where a released drag goes. Past a third of the width, or fast enough in the same direction, it commits
 *  (`next`: the view to the right of the finger's travel); otherwise it comes back. `vx` is px per ms. */
export function settle(dx: number, vx: number, width: number): "stay" | "forward" | "back" {
  const far = Math.abs(dx) > width * 0.33;
  const fast = Math.abs(vx) > 0.5 && Math.abs(dx) > 24 && Math.sign(vx) === Math.sign(dx);
  if (!far && !fast) return "stay";
  return dx < 0 ? "forward" : "back";
}

/** Pure: whether a row's drag has gone far enough to act: a fixed distance on a narrow row, a third on a wide one,
 *  or a quick flick. */
export function rowCommits(dx: number, vx: number, width: number, min = 96): boolean {
  const a = Math.abs(dx);
  return a >= Math.min(min, width * 0.4) || (Math.abs(vx) > 0.6 && a > 40 && Math.sign(vx) === Math.sign(dx));
}

/** Pure: how far a row follows the finger: one way only when the other has no action, and slowed past the width
 *  an action needs so it feels attached but not loose. */
export function rowFollow(dx: number, hasRight: boolean, hasLeft: boolean, width: number): number {
  if (dx > 0 && !hasRight) return 0;
  if (dx < 0 && !hasLeft) return 0;
  const max = width * 0.9;
  return Math.abs(dx) <= 120 ? dx : Math.sign(dx) * Math.min(max, 120 + (Math.abs(dx) - 120) * 0.35);
}

/** Pure: the finger's speed (px per ms) from the last samples of the drag, over about 100 ms. */
export function velocityOf(samples: { x: number; t: number }[]): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  const first = samples.find((s) => last.t - s.t <= 100) ?? samples[0];
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

/** Pure: one step of a spring pulling `x` to `target` (stiffness and damping slightly under critical, so it settles
 *  with a small overshoot). Returns the new position and speed (px per second). */
export function springStep(x: number, v: number, target: number, dt: number, k = 300, c = 30): [number, number] {
  // semi-implicit Euler in small steps: stable whatever the frame time
  const n = Math.max(1, Math.ceil(dt / 0.004));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    v += (-k * (x - target) - c * v) * h;
    x += v * h;
  }
  return [x, v];
}

/** Pure: whether the spring has come to rest. */
export const springDone = (x: number, v: number, target: number) => Math.abs(x - target) < 0.4 && Math.abs(v) < 8;

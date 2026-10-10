// status-cache.ts — the status report, kept between requests. Computing it takes a second or more
// (it runs the doctor), so it is computed at start, served from memory, and refreshed behind the
// scenes once it is older than five seconds. A request waits only when something changed (a state
// event, an action) and the kept report would be wrong. Concurrent requests share one computation.
//
// State events come in bursts while sessions work: a report is recomputed at most once every
// `minGap` for them, the last change caught by a computation after the gap. An action asks `fresh`,
// which always waits for a new one.

import { status } from "../status.ts";

export type StatusReport = Awaited<ReturnType<typeof status>>;

export class StatusCache<R = StatusReport> {
  #cache: { at: number; gen: number; body: string; report: R } | null = null;
  /** Counts changes: a report computed before the last change is not served where freshness matters. */
  #gen = 0;
  #inflight: Promise<void> | null = null;
  #trailing: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private compute: () => Promise<R> = status as unknown as () => Promise<R>,
    private minGap = 5000,
    private now = () => Date.now(),
  ) {}

  /** Marks the kept report as outdated; the next request that needs it waits for a new one. */
  invalidate(): void {
    this.#gen++;
  }

  /** Starts a computation unless one is running; resolves when it ends. */
  refresh(): Promise<void> {
    return this.#inflight ??= (async () => {
      const g = this.#gen;
      try {
        const report = await this.compute();
        this.#cache = { at: this.now(), gen: g, body: JSON.stringify(report), report };
        // caught up with every change: a computation waiting for the gap has nothing left to do
        if (g === this.#gen && this.#trailing) {
          clearTimeout(this.#trailing);
          this.#trailing = null;
        }
      } finally {
        this.#inflight = null;
      }
    })();
  }

  /** The current report, serialised and as an object. `fresh` invalidates first and always waits. */
  async get(fresh: boolean): Promise<{ body: string; report: R }> {
    if (fresh) {
      this.invalidate();
      while (this.#cache?.gen !== this.#gen) await this.refresh();
      return this.#cache;
    }
    while (!this.#cache) await this.refresh();
    const c = this.#cache, age = this.now() - c.at;
    if (c.gen !== this.#gen) {
      // changed since: wait for a new report, unless the last one is younger than the gap — then
      // it is served, and one computation after the gap catches up with every change in between
      if (age >= this.minGap) {
        while (this.#cache.gen !== this.#gen && this.now() - this.#cache.at >= this.minGap) await this.refresh();
        return this.#cache;
      }
      this.#trailing ??= setTimeout(() => {
        this.#trailing = null;
        void this.refresh().catch(() => {});
      }, this.minGap - age);
    } else if (age > 5000) void this.refresh().catch(() => {});
    return c;
  }
}

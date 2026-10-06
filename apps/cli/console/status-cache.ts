// status-cache.ts — the status report, kept between requests. Computing it takes a second or more
// (it runs the doctor), so it is computed at start, served from memory, and refreshed behind the
// scenes once it is older than five seconds. A request waits only when something changed (a state
// event, an action) and the kept report would be wrong. Concurrent requests share one computation.

import { status } from "../status.ts";

export type StatusReport = Awaited<ReturnType<typeof status>>;

export class StatusCache {
  #cache: { at: number; gen: number; body: string; report: StatusReport } | null = null;
  /** Counts changes: a report computed before the last change is not served where freshness matters. */
  #gen = 0;
  #inflight: Promise<void> | null = null;

  /** Marks the kept report as outdated; the next request that needs it waits for a new one. */
  invalidate(): void {
    this.#gen++;
  }

  /** Starts a computation unless one is running; resolves when it ends. */
  refresh(): Promise<void> {
    return this.#inflight ??= (async () => {
      const g = this.#gen;
      try {
        const report = await status();
        this.#cache = { at: Date.now(), gen: g, body: JSON.stringify(report), report };
      } finally {
        this.#inflight = null;
      }
    })();
  }

  /** The current report, serialised and as an object. `fresh` invalidates first. */
  async get(fresh: boolean): Promise<{ body: string; report: StatusReport }> {
    if (fresh) this.invalidate();
    while (!this.#cache || this.#cache.gen !== this.#gen) await this.refresh();
    if (Date.now() - this.#cache.at > 5000) void this.refresh().catch(() => {});
    return this.#cache;
  }
}

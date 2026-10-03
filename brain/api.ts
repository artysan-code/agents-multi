// api.ts — the brain read over plain HTTP, for the owner's machines: the console's Brain page asks
// here with the personal token from the vault (the browser never sees it). Only reads: writing
// stays with Claude, over MCP, where the rules answer.
//
//   GET /api/brain/state            a version that changes with every write to the memory, nothing else
//   GET /api/brain/pages            every page (no tasks) with its area, and the links between them
//   GET /api/brain/page?path=[&rev=] a page in full with its links and its versions; with rev, how it was
//   GET /api/brain/search?q=        words and meaning, as brain_search
//   GET /api/brain/health           what brain_check finds

import { AREAS, areaOf } from "./rules.ts";
import type { Store } from "./store.ts";
import { health, search, type ToolContext } from "./tools.ts";

/** What the memory is at, tasks left out: their writes do not change the pages. */
export function memoryVersion(store: Store): string {
  const r = store.db.prepare("select count(*) n, max(at) last from revisions where path not like 'tasks/%'").get() as { n: number; last: string | null };
  return `${r.n}:${r.last ?? ""}`;
}

/** The answer to a GET under /api/brain, or null when the path is not one of these. */
export async function brainApi(ctx: ToolContext, u: URL): Promise<{ status: number; body: unknown } | null> {
  const { store } = ctx;
  const ok = (body: unknown) => ({ status: 200, body });
  const missing = (error: string) => ({ status: 404, body: { error } });
  switch (u.pathname) {
    case "/api/brain/state":
      return ok({ version: memoryVersion(store) });
    case "/api/brain/pages": {
      const pages = store.list("", { limit: 100000 }).map((p) => ({ ...p, area: areaOf(p.path) }));
      const areas = Object.fromEntries(AREAS.map((a) => [a, pages.filter((p) => p.area === a).length]));
      return ok({ version: memoryVersion(store), areas, pages, edges: store.graph().edges });
    }
    case "/api/brain/page": {
      const path = u.searchParams.get("path") ?? "";
      const rev = Number(u.searchParams.get("rev") ?? 0);
      const d = store.get(path) ?? (store.resolve(path) ? store.get(store.resolve(path)!) : null);
      if (rev) {
        const r = store.revision(d?.path ?? path, rev);
        return r ? ok(r) : missing(`no version ${rev} of ${path}`);
      }
      if (!d) return missing(`no document ${path}`);
      return ok({ ...d, area: areaOf(d.path), links: store.links(d.path), versions: store.history(d.path) });
    }
    case "/api/brain/search": {
      const q = (u.searchParams.get("q") ?? "").trim();
      if (!q) return ok({ results: [] });
      return ok(await search(ctx, q, Math.min(Number(u.searchParams.get("limit")) || 20, 50)));
    }
    case "/api/brain/health":
      return ok(health(store));
  }
  return null;
}

// embed.ts — search by meaning: each document cut into chunks, each chunk turned into a vector by
// an embedding model behind an Ollama-compatible API (bge-m3 by default: multilingual, good in
// Italian), and a question compared against all of them. A brain of a few thousand documents is a
// few tens of thousands of vectors: a plain scan answers in milliseconds, no vector index needed.
//
// Writes clear a document's chunks (store.ts); the indexer here notices and fills them again in
// the background, so a write never waits for the model and a model that is down only delays this.
// The indexers of every account take turns at the model, one document at a time; a search goes
// straight to it and waits at most a few seconds, then answers with words alone (tools.ts).

import type { Store } from "./store.ts";
import { Gate } from "./guard.ts";

export interface EmbedConfig {
  url: string;
  model: string;
}

/** Pure: a document cut where its structure allows — headings, then paragraphs — into pieces of
 *  about `size` characters, each carrying its heading so a chunk read alone still says what it is. */
export function chunk(body: string, size = 1200): string[] {
  const text = body.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  if (!text) return [];
  const out: string[] = [];
  let heading = "", cur = "";
  const flush = () => {
    if (cur.trim()) out.push((heading && !cur.startsWith(heading) ? `${heading}\n` : "") + cur.trim());
    cur = "";
  };
  for (const para of text.split(/\n{2,}/)) {
    const h = para.match(/^#{1,6}\s+(.+)$/m);
    if (h && para.trim().startsWith("#")) {
      flush();
      heading = h[0];
    }
    if (cur.length + para.length > size) flush();
    if (para.length > size) {
      for (let i = 0; i < para.length; i += size) out.push((heading ? `${heading}\n` : "") + para.slice(i, i + size));
      continue;
    }
    cur += (cur ? "\n\n" : "") + para;
  }
  flush();
  return out;
}

const toBlob = (v: number[]) => {
  const f = new Float32Array(v);
  let n = 0;
  for (const x of f) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < f.length; i++) f[i] /= n; // stored unit-length: a dot product is the cosine
  return new Uint8Array(f.buffer);
};
const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

/** How long a search waits for the model before answering with words alone. */
const SEARCH_TIMEOUT_MS = 4_000;
/** The indexers of every open brain, one document at a time: a brain being filled for the first
 *  time does not keep the model from the others, nor from the searches, which skip this line. */
const indexing = new Gate(1, Infinity);

/** The vectors of `input`, all within `timeoutMs` however many requests it takes. */
export async function embed(cfg: EmbedConfig, input: string[], timeoutMs = 120_000): Promise<number[][]> {
  const signal = AbortSignal.timeout(timeoutMs);
  const post = (path: string, body: unknown) =>
    fetch(`${cfg.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  const r = await post("/api/embed", { model: cfg.model, input });
  if (r.status === 404) {
    // an older Ollama-compatible API: one text per request
    await r.body?.cancel();
    const out: number[][] = [];
    for (const prompt of input) {
      const one = await post("/api/embeddings", { model: cfg.model, prompt });
      if (!one.ok) throw new Error(`embedding model: HTTP ${one.status}`);
      out.push((await one.json() as { embedding: number[] }).embedding);
    }
    return out;
  }
  if (!r.ok) throw new Error(`embedding model: HTTP ${r.status}`);
  const j = await r.json() as { embeddings?: number[][] };
  if (!j.embeddings || j.embeddings.length !== input.length) throw new Error("embedding model: unexpected answer");
  return j.embeddings;
}

/** Fills the chunks of every document that has none (new, changed, or embedded by another model). */
async function indexPending(store: Store, cfg: EmbedConfig, max = 50): Promise<number> {
  const stale = store.db.prepare(
    `select d.path, d.body from docs d where d.deleted = 0 and not exists (select 1 from chunks c where c.path = d.path and c.model = ?) limit ?`,
  ).all(cfg.model, max) as { path: string; body: string }[];
  for (const d of stale) {
    const pieces = chunk(d.body);
    const vecs = pieces.length ? (await indexing.run(() => embed(cfg, pieces)))! : [];
    store.tx(() => {
      store.db.prepare("delete from chunks where path = ?").run(d.path);
      // an empty document still gets a marker row, or it would be picked up again forever
      if (!pieces.length) {
        store.db.prepare("insert into chunks (path, ord, text, vec, model) values (?, 0, '', null, ?)").run(
          d.path,
          cfg.model,
        );
      }
      pieces.forEach((p, i) =>
        store.db.prepare("insert into chunks (path, ord, text, vec, model) values (?, ?, ?, ?, ?)").run(
          d.path,
          i,
          p,
          toBlob(vecs[i]),
          cfg.model,
        )
      );
    });
  }
  return stale.length;
}

/** Keeps indexing in the background; `kick()` after a write starts it at once. */
export function indexer(store: Store, cfg: EmbedConfig) {
  let running = false, again = false, lastError = "";
  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        while (await indexPending(store, cfg) > 0) { /* next batch */ }
      } while (again);
      lastError = "";
    } catch (e) {
      lastError = (e as Error).message; // the model is down: try again on the next write or tick
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, 60_000);
  void run();
  return {
    kick: () => void run(),
    stop: () => clearInterval(timer),
    status: () => ({
      lastError,
      pending: (store.db.prepare(
        "select count(*) n from docs d where d.deleted = 0 and not exists (select 1 from chunks c where c.path = d.path and c.model = ?)",
      ).get(cfg.model) as { n: number }).n,
    }),
  };
}

/** By meaning: each document scored by its best chunk. */
export async function searchMeaning(
  store: Store,
  cfg: EmbedConfig,
  q: string,
  limit = 20,
  tasks = false,
  timeoutMs = SEARCH_TIMEOUT_MS,
) {
  const [qv] = await embed(cfg, [q], timeoutMs);
  const v = fromBlob(toBlob(qv));
  const best = new Map<string, { score: number; text: string }>();
  for (
    const r of store.db.prepare(
      `select path, text, vec from chunks where vec is not null and model = ? ${
        tasks ? "" : "and path not like 'tasks/%'"
      }`,
    ).iterate(cfg.model) as Iterable<{ path: string; text: string; vec: Uint8Array }>
  ) {
    const c = fromBlob(r.vec);
    let s = 0;
    for (let i = 0; i < c.length; i++) s += c[i] * v[i];
    const cur = best.get(r.path);
    if (!cur || s > cur.score) best.set(r.path, { score: s, text: r.text });
  }
  return [...best].sort((a, b) => b[1].score - a[1].score).slice(0, limit).map(([path, x]) => ({
    path,
    score: x.score,
    text: x.text,
  }));
}

/** Pure: two rankings fused by reciprocal rank (k = 60): no scores to calibrate against each other. */
export function fuse(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const l of lists) l.forEach((p, i) => score.set(p, (score.get(p) ?? 0) + 1 / (k + i + 1)));
  return [...score].sort((a, b) => b[1] - a[1]).map(([p]) => p);
}

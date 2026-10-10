// store.ts — the brain's documents: Markdown with a path, kept in one SQLite file.
//
// Every write keeps the version it replaces (revisions), so any document can be read as it was and
// put back; nothing is ever removed for good, a deletion is a revision that marks it gone. The
// links between documents ([[target]] or [[target|label]], as Obsidian writes them) are kept per
// document for the graph and the backlinks, and a full-text index (FTS5) answers searches by
// words. The meaning-based half of search lives in embed.ts, over the chunks stored here.
//
// No structure is imposed: a path is a folder/name.md the client chooses. One prefix is reserved,
// tasks/, where tasks.ts keeps one document per task.

import type { Areas } from "./rules.ts";
import { DatabaseSync } from "node:sqlite";
import { migrate, type Migration } from "./migrate.ts";

export interface Doc {
  path: string;
  title: string;
  body: string;
  rev: number;
  created: string;
  updated: string;
  by: string;
}
export interface Revision {
  path: string;
  rev: number;
  at: string;
  by: string;
  op: "write" | "delete" | "restore";
  body: string;
}

const SCHEMA = `
create table if not exists docs (
  path text primary key, title text not null, body text not null, rev integer not null,
  created text not null, updated text not null, by text not null, deleted integer not null default 0);
create table if not exists revisions (
  path text not null, rev integer not null, at text not null, by text not null, op text not null, body text not null,
  primary key (path, rev));
create table if not exists links (src text not null, dst text not null, primary key (src, dst));
create index if not exists links_dst on links (dst);
create virtual table if not exists docs_fts using fts5(path unindexed, title, body, tokenize = 'unicode61 remove_diacritics 2');
create table if not exists chunks (
  path text not null, ord integer not null, text text not null, vec blob, model text,
  primary key (path, ord));
`;
/** The brain database's schema, step by step: step 1 is the schema as it was before versions. */
export const BRAIN_MIGRATIONS: Migration[] = [
  (db) => db.exec(SCHEMA),
  // the live documents are what nearly every query asks for; the index keeps those scans short
  (db) => db.exec("create index if not exists docs_live on docs(path) where deleted = 0"),
  // a counter of writes (see Store.version) so the memory's version never scans the revisions
  (db) => {
    db.exec("create table if not exists meta (k text primary key, v text not null)");
    db.exec("create index if not exists revisions_at on revisions(at)");
    // started at the revisions already there, so the version strings stay what they were
    db.exec(`insert or ignore into meta (k, v) select 'writes_all', count(*) from revisions`);
    db.exec(
      `insert or ignore into meta (k, v) select 'writes_pages', count(*) from revisions where path not like 'tasks/%'`,
    );
  },
];

/** Resolves a [[target]] to a document path (see Store.resolver). */
export type Resolver = (target: string) => string | null;

/** Pure: a resolver over a set of live paths — the exact path, else the shallowest document with
 *  that name (ties by name order). Built once, it answers each target without touching the database. */
export function makeResolver(paths: Iterable<string>): Resolver {
  const exact = new Set<string>();
  const byName = new Map<string, string>();
  const depth = (p: string) => p.split("/").length;
  for (const p of paths) {
    exact.add(p);
    const name = p.split("/").pop()!.toLowerCase();
    const cur = byName.get(name);
    if (!cur || depth(p) < depth(cur) || (depth(p) === depth(cur) && p.localeCompare(cur) < 0)) byName.set(name, p);
  }
  return (target) => {
    const t = target.replace(/\.md$/i, "");
    if (exact.has(`${t}.md`)) return `${t}.md`;
    return byName.get(`${t.split("/").pop()!.toLowerCase()}.md`) ?? null;
  };
}

/** Settings every brain database gets: WAL with `synchronous = normal` (a crash can lose the last
 *  commits, never corrupt the file), a bigger page cache, temporaries in memory. */
export const PRAGMAS =
  "pragma journal_mode = wal; pragma synchronous = normal; pragma foreign_keys = on; pragma busy_timeout = 5000; pragma cache_size = -16000; pragma temp_store = memory;";

/** Pure: a path the brain accepts — folders and a name ending in .md, no way out of the tree. */
export function cleanPath(p: string): string {
  const s = String(p ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  const withExt = /\.md$/i.test(s) ? s : `${s}.md`;
  const control = [...withExt].some((c) => c.charCodeAt(0) < 32);
  if (
    !s || withExt.length > 300 || withExt.split("/").some((seg) => !seg || seg === "." || seg === "..") || control ||
    /[<>:"|?*]/.test(withExt)
  ) {
    throw new Error(`not a document path: ${p}`);
  }
  return withExt;
}

/** Pure: the title of a document — its frontmatter `title`, else its first heading, else its name. */
export function titleOf(path: string, body: string): string {
  const fm = body.match(/^---\n([\s\S]*?)\n---/);
  const t = fm?.[1].match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1];
  if (t) return t.trim();
  const h = body.replace(/^---\n[\s\S]*?\n---\n?/, "").match(/^#\s+(.+)$/m)?.[1];
  return (h ?? path.split("/").pop()!.replace(/\.md$/i, "")).trim();
}

/** Pure: the targets a document links to, as written ([[a/b|label]] → "a/b"), without headings. */
export function linksIn(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    out.add(m[1].trim().replace(/\.md$/i, ""));
  }
  return [...out];
}

export class Store {
  db: DatabaseSync;
  /** The area names of the account (rules.ts `areasFor`); unset, the Italian ones. */
  areas?: Areas;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(PRAGMAS);
    migrate(this.db, BRAIN_MIGRATIONS);
  }

  /** Counts a write in the same transaction as the revision it made. */
  private bump(path: string) {
    const up = (k: string) => this.db.prepare("update meta set v = cast(v as integer) + 1 where k = ?").run(k);
    up("writes_all");
    if (!path.startsWith("tasks/")) up("writes_pages");
  }

  /** What the memory is at: it changes with every write and never otherwise. `pages` leaves the
   *  tasks out (their writes do not change the pages). Reads a counter, not the revisions. */
  version(pages = false): { version: string; revisions: number; last: string | null } {
    const row = this.db.prepare("select v from meta where k = ?").get(pages ? "writes_pages" : "writes_all") as
      | { v: string }
      | undefined;
    const n = Number(row?.v ?? 0);
    const last = (this.db.prepare(
      pages ? "select max(at) last from revisions where path not like 'tasks/%'" : "select max(at) last from revisions",
    ).get() as { last: string | null }).last;
    return { version: `${n}:${last ?? ""}`, revisions: n, last };
  }

  /** How many writes the tasks have had: the validator of the task list (changes with each task write). */
  tasksVersion(): number {
    return this.version().revisions - this.version(true).revisions;
  }

  /** The task documents' bodies, from a range on the primary key (tasks/t-…) rather than a LIKE. */
  taskBodies(): string[] {
    return (this.db.prepare("select body from docs where path >= 'tasks/t-' and path < 'tasks/t.' and deleted = 0")
      .all() as { body: string }[]).map((r) => r.body);
  }

  get(path: string): Doc | null {
    const r = this.db.prepare(
      "select path, title, body, rev, created, updated, by from docs where path = ? and deleted = 0",
    ).get(cleanPath(path));
    return (r as unknown as Doc) ?? null;
  }

  /** The documents under a folder (all of them for ""), newest first; tasks only when asked. */
  list(prefix = "", opts: { tasks?: boolean; limit?: number } = {}): Omit<Doc, "body">[] {
    const rows = this.db.prepare(
      `select path, title, rev, created, updated, by from docs where deleted = 0 and path like ? escape '\\' ${
        opts.tasks ? "" : "and path not like 'tasks/%'"
      }
       order by updated desc limit ?`,
    ).all(`${prefix.replace(/[\\%_]/g, "\\$&")}%`, opts.limit ?? 1000);
    return rows as unknown as Omit<Doc, "body">[];
  }

  /** Writes a document; `base` (the rev the writer read) refuses to overwrite a newer one. */
  write(path: string, body: string, by: string, base?: number, op: "write" | "restore" = "write"): Doc {
    const p = cleanPath(path);
    const now = new Date().toISOString();
    const cur = this.db.prepare("select rev, created, deleted from docs where path = ?").get(p) as {
      rev: number;
      created: string;
      deleted: number;
    } | undefined;
    if (base !== undefined && (cur?.deleted ? 0 : cur?.rev ?? 0) !== base) {
      throw new Error(`${p} changed meanwhile (now rev ${cur?.rev ?? 0}): read it again`);
    }
    const rev = (cur?.rev ?? 0) + 1;
    const title = titleOf(p, body);
    this.tx(() => {
      this.db.prepare(
        `insert into docs (path, title, body, rev, created, updated, by, deleted) values (?, ?, ?, ?, ?, ?, ?, 0)
        on conflict (path) do update set title = excluded.title, body = excluded.body, rev = excluded.rev, updated = excluded.updated, by = excluded.by, deleted = 0`,
      )
        .run(p, title, body, rev, cur?.created ?? now, now, by);
      this.db.prepare("insert into revisions (path, rev, at, by, op, body) values (?, ?, ?, ?, ?, ?)").run(
        p,
        rev,
        now,
        by,
        op,
        body,
      );
      this.db.prepare("delete from links where src = ?").run(p);
      for (const d of linksIn(body)) this.db.prepare("insert or ignore into links (src, dst) values (?, ?)").run(p, d);
      this.db.prepare("delete from docs_fts where path = ?").run(p);
      this.db.prepare("insert into docs_fts (path, title, body) values (?, ?, ?)").run(p, title, body);
      this.db.prepare("delete from chunks where path = ?").run(p); // embed.ts fills them again
      this.bump(p);
    });
    return this.get(p)!;
  }

  /** A deletion is a revision: the document leaves every list and search, its history stays. */
  remove(path: string, by: string): void {
    const p = cleanPath(path);
    const cur = this.get(p);
    if (!cur) throw new Error(`no document ${p}`);
    const now = new Date().toISOString();
    this.tx(() => {
      this.db.prepare("update docs set deleted = 1, rev = ?, updated = ?, by = ? where path = ?").run(
        cur.rev + 1,
        now,
        by,
        p,
      );
      this.db.prepare("insert into revisions (path, rev, at, by, op, body) values (?, ?, ?, ?, 'delete', '')").run(
        p,
        cur.rev + 1,
        now,
        by,
      );
      this.db.prepare("delete from links where src = ?").run(p);
      this.db.prepare("delete from docs_fts where path = ?").run(p);
      this.db.prepare("delete from chunks where path = ?").run(p);
      this.bump(p);
    });
  }

  history(path: string): Omit<Revision, "body">[] {
    return this.db.prepare("select path, rev, at, by, op from revisions where path = ? order by rev desc").all(
      cleanPath(path),
    ) as unknown as Omit<Revision, "body">[];
  }

  revision(path: string, rev: number): Revision | null {
    return (this.db.prepare("select * from revisions where path = ? and rev = ?").get(
      cleanPath(path),
      rev,
    ) as unknown as Revision) ?? null;
  }

  /** Puts an older version back, as a new revision on top. */
  restore(path: string, rev: number, by: string): Doc {
    const r = this.revision(path, rev);
    if (!r || r.op === "delete") throw new Error(`no version ${rev} of ${path} to restore`);
    return this.write(path, r.body, by, undefined, "restore");
  }

  /** A resolver over the live documents, from one query: build it once per request, not per link. */
  resolver(): Resolver {
    return makeResolver(
      (this.db.prepare("select path from docs where deleted = 0").all() as { path: string }[]).map((r) => r.path),
    );
  }

  /** Where a [[target]] points: the exact path, else the shallowest document with that name. */
  resolve(target: string, resolver: Resolver = this.resolver()): string | null {
    return resolver(target);
  }

  /** A document's links both ways, resolved to paths where they exist. */
  links(path: string, resolver: Resolver = this.resolver()): {
    out: { target: string; path: string | null }[];
    back: string[];
  } {
    const p = cleanPath(path);
    const out = (this.db.prepare("select dst from links where src = ?").all(p) as { dst: string }[]).map((r) => ({
      target: r.dst,
      path: resolver(r.dst),
    }));
    // a link reaches this document when it names it (by path or by name) and resolves to it
    const name = p.replace(/\.md$/, "").split("/").pop()!.toLowerCase();
    const cands = this.db.prepare("select src, dst from links where lower(dst) = ? or lower(dst) like ? escape '\\'")
      .all(name, `%/${name.replace(/[\\%_]/g, "\\$&")}`) as { src: string; dst: string }[];
    const back = [...new Set(cands.filter((c) => c.src !== p && resolver(c.dst) === p).map((c) => c.src))].sort();
    return { out, back };
  }

  /** Every document and every resolved link, for the graph. */
  graph(resolver: Resolver = this.resolver()): { nodes: { path: string; title: string }[]; edges: [string, string][] } {
    const nodes = this.db.prepare("select path, title from docs where deleted = 0 and path not like 'tasks/%'")
      .all() as { path: string; title: string }[];
    const edges: [string, string][] = [];
    for (
      const l of this.db.prepare("select src, dst from links where src not like 'tasks/%'").all() as {
        src: string;
        dst: string;
      }[]
    ) {
      const d = resolver(l.dst);
      if (d && d !== l.src) edges.push([l.src, d]);
    }
    return { nodes, edges };
  }

  /** Full-text: the best matches by BM25, title words weighing more, with a snippet. */
  searchWords(q: string, limit = 20, tasks = false): { path: string; title: string; snippet: string; score: number }[] {
    const terms = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!terms.length) return [];
    const match = terms.map((w) => `"${w}"*`).join(" OR ");
    const rows = this.db.prepare(
      `select path, title, snippet(docs_fts, 2, '«', '»', '…', 14) as snippet, bm25(docs_fts, 0, 4, 1) as score
       from docs_fts where docs_fts match ? ${tasks ? "" : "and path not like 'tasks/%'"} order by score limit ?`,
    ).all(match, limit) as { path: string; title: string; snippet: string; score: number }[];
    return rows;
  }

  tx(fn: () => void) {
    this.db.exec("begin");
    try {
      fn();
      this.db.exec("commit");
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  close() {
    this.db.close();
  }
}

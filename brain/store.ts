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

import { DatabaseSync } from "node:sqlite";

export interface Doc {
  path: string;
  title: string;
  body: string;
  rev: number;
  created: string;
  updated: string;
  by: string;
}
export interface Revision { path: string; rev: number; at: string; by: string; op: "write" | "delete" | "restore"; body: string }

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

/** Pure: a path the brain accepts — folders and a name ending in .md, no way out of the tree. */
export function cleanPath(p: string): string {
  const s = String(p ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  const withExt = /\.md$/i.test(s) ? s : `${s}.md`;
  const control = [...withExt].some((c) => c.charCodeAt(0) < 32);
  if (!s || withExt.length > 300 || withExt.split("/").some((seg) => !seg || seg === "." || seg === "..") || control || /[<>:"|?*]/.test(withExt)) {
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
  for (const m of body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) out.add(m[1].trim().replace(/\.md$/i, ""));
  return [...out];
}

export class Store {
  db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  get(path: string): Doc | null {
    const r = this.db.prepare("select path, title, body, rev, created, updated, by from docs where path = ? and deleted = 0").get(cleanPath(path));
    return (r as unknown as Doc) ?? null;
  }

  /** The documents under a folder (all of them for ""), newest first; tasks only when asked. */
  list(prefix = "", opts: { tasks?: boolean; limit?: number } = {}): Omit<Doc, "body">[] {
    const rows = this.db.prepare(
      `select path, title, rev, created, updated, by from docs where deleted = 0 and path like ? escape '\\' ${opts.tasks ? "" : "and path not like 'tasks/%'"}
       order by updated desc limit ?`,
    ).all(`${prefix.replace(/[\\%_]/g, "\\$&")}%`, opts.limit ?? 1000);
    return rows as unknown as Omit<Doc, "body">[];
  }

  /** Writes a document; `base` (the rev the writer read) refuses to overwrite a newer one. */
  write(path: string, body: string, by: string, base?: number, op: "write" | "restore" = "write"): Doc {
    const p = cleanPath(path);
    const now = new Date().toISOString();
    const cur = this.db.prepare("select rev, created, deleted from docs where path = ?").get(p) as { rev: number; created: string; deleted: number } | undefined;
    if (base !== undefined && (cur?.deleted ? 0 : cur?.rev ?? 0) !== base) throw new Error(`${p} changed meanwhile (now rev ${cur?.rev ?? 0}): read it again`);
    const rev = (cur?.rev ?? 0) + 1;
    const title = titleOf(p, body);
    this.tx(() => {
      this.db.prepare(`insert into docs (path, title, body, rev, created, updated, by, deleted) values (?, ?, ?, ?, ?, ?, ?, 0)
        on conflict (path) do update set title = excluded.title, body = excluded.body, rev = excluded.rev, updated = excluded.updated, by = excluded.by, deleted = 0`)
        .run(p, title, body, rev, cur?.created ?? now, now, by);
      this.db.prepare("insert into revisions (path, rev, at, by, op, body) values (?, ?, ?, ?, ?, ?)").run(p, rev, now, by, op, body);
      this.db.prepare("delete from links where src = ?").run(p);
      for (const d of linksIn(body)) this.db.prepare("insert or ignore into links (src, dst) values (?, ?)").run(p, d);
      this.db.prepare("delete from docs_fts where path = ?").run(p);
      this.db.prepare("insert into docs_fts (path, title, body) values (?, ?, ?)").run(p, title, body);
      this.db.prepare("delete from chunks where path = ?").run(p); // embed.ts fills them again
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
      this.db.prepare("update docs set deleted = 1, rev = ?, updated = ?, by = ? where path = ?").run(cur.rev + 1, now, by, p);
      this.db.prepare("insert into revisions (path, rev, at, by, op, body) values (?, ?, ?, ?, 'delete', '')").run(p, cur.rev + 1, now, by);
      this.db.prepare("delete from links where src = ?").run(p);
      this.db.prepare("delete from docs_fts where path = ?").run(p);
      this.db.prepare("delete from chunks where path = ?").run(p);
    });
  }

  history(path: string): Omit<Revision, "body">[] {
    return this.db.prepare("select path, rev, at, by, op from revisions where path = ? order by rev desc").all(cleanPath(path)) as unknown as Omit<Revision, "body">[];
  }

  revision(path: string, rev: number): Revision | null {
    return (this.db.prepare("select * from revisions where path = ? and rev = ?").get(cleanPath(path), rev) as unknown as Revision) ?? null;
  }

  /** Puts an older version back, as a new revision on top. */
  restore(path: string, rev: number, by: string): Doc {
    const r = this.revision(path, rev);
    if (!r || r.op === "delete") throw new Error(`no version ${rev} of ${path} to restore`);
    return this.write(path, r.body, by, undefined, "restore");
  }

  /** Where a [[target]] points: the exact path, else the shallowest document with that name. */
  resolve(target: string): string | null {
    const t = target.replace(/\.md$/i, "");
    const exact = this.db.prepare("select path from docs where deleted = 0 and path = ?").get(`${t}.md`) as { path: string } | undefined;
    if (exact) return exact.path;
    const name = t.split("/").pop()!.toLowerCase();
    const rows = this.db.prepare("select path from docs where deleted = 0 and (lower(path) = ? or lower(path) like ? escape '\\')")
      .all(`${name}.md`, `%/${name.replace(/[\\%_]/g, "\\$&")}.md`) as { path: string }[];
    return rows.map((r) => r.path).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0] ?? null;
  }

  /** A document's links both ways, resolved to paths where they exist. */
  links(path: string): { out: { target: string; path: string | null }[]; back: string[] } {
    const p = cleanPath(path);
    const out = (this.db.prepare("select dst from links where src = ?").all(p) as { dst: string }[]).map((r) => ({ target: r.dst, path: this.resolve(r.dst) }));
    // a link reaches this document when it names it (by path or by name) and resolves to it
    const name = p.replace(/\.md$/, "").split("/").pop()!.toLowerCase();
    const cands = this.db.prepare("select src, dst from links where lower(dst) = ? or lower(dst) like ? escape '\\'")
      .all(name, `%/${name.replace(/[\\%_]/g, "\\$&")}`) as { src: string; dst: string }[];
    const back = [...new Set(cands.filter((c) => c.src !== p && this.resolve(c.dst) === p).map((c) => c.src))].sort();
    return { out, back };
  }

  /** Every document and every resolved link, for the graph. */
  graph(): { nodes: { path: string; title: string }[]; edges: [string, string][] } {
    const nodes = this.db.prepare("select path, title from docs where deleted = 0 and path not like 'tasks/%'").all() as { path: string; title: string }[];
    const edges: [string, string][] = [];
    for (const l of this.db.prepare("select src, dst from links where src not like 'tasks/%'").all() as { src: string; dst: string }[]) {
      const d = this.resolve(l.dst);
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

  close() { this.db.close(); }
}

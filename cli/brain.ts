// brain.ts — the wiki (~/brains/claude) as the console shows it: pages with their frontmatter, the
// links between them, and the inbox of material waiting to be distilled.
//
// A view, not an editor: pages are written by Claude through /wiki-ingest (with its confirmation
// guard), never from here. What the console can do is put material in `_raw/`, the staging
// directory /wiki-ingest's raw mode reads and empties.

import { HOME } from "./lib.ts";

export const BRAIN = Deno.env.get("CLAUDE_MULTI_BRAIN") ?? `${HOME}/brains/claude`;
const SKIP_DIRS = new Set(["_raw", "_archives", ".obsidian", ".git", ".stfolder", "wiki-export", "graphify-out"]);

export interface Page {
  path: string; // relative, without .md: the form wikilinks use
  title: string;
  category: string;
  /** the top folder (projects, references…), or "meta" for the pages at the root: what colours the
   *  graph. The frontmatter category is not used for that, it is spelled inconsistently. */
  group: string;
  tags: string[];
  summary: string;
  updated: string | null;
  lifecycle: string | null;
}

/** Pure: the frontmatter fields the console uses. A small reader for the flat YAML the wiki writes
 *  (scalars and inline lists), not a YAML parser. */
export function frontmatter(text: string): { data: Record<string, string | string[]>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string | string[]> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    if (v.startsWith("[") && v.endsWith("]")) {
      data[kv[1]] = v.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else data[kv[1]] = v.replace(/^["']|["']$/g, "");
  }
  return { data, body: text.slice(m[0].length) };
}

/** Pure: the wikilink targets in a text ([[target]], [[target|label]], [[target#heading]]). */
export function wikilinks(text: string): string[] {
  return [...text.matchAll(/\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g)].map((m) => m[1].trim().replace(/\.md$/, ""));
}

/** Pure: a link target to a page path. Full paths match as written; a bare name matches the one
 *  page with that file name. Unknown or ambiguous targets resolve to nothing. */
export function resolveLink(target: string, paths: string[], byName: Map<string, string[]>): string | null {
  if (paths.includes(target)) return target;
  const hits = byName.get(target.split("/").pop()!) ?? [];
  return hits.length === 1 ? hits[0] : null;
}

async function walk(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.name.startsWith(".") && e.isDirectory) continue;
    if (e.isDirectory) {
      if (!rel && SKIP_DIRS.has(e.name)) continue;
      out.push(...await walk(`${dir}/${e.name}`, rel ? `${rel}/${e.name}` : e.name));
    } else if (e.isFile && e.name.endsWith(".md")) out.push(rel ? `${rel}/${e.name}` : e.name);
  }
  return out;
}

export async function brainGraph() {
  const files = await walk(BRAIN).catch(() => [] as string[]);
  const pages: Page[] = [];
  const raw: Record<string, string> = {};
  for (const f of files) {
    const text = await Deno.readTextFile(`${BRAIN}/${f}`).catch(() => "");
    const path = f.slice(0, -3);
    const { data, body } = frontmatter(text);
    raw[path] = body;
    const str = (k: string) => typeof data[k] === "string" ? data[k] as string : "";
    pages.push({
      path,
      title: str("title") || path.split("/").pop()!,
      category: str("category") || path.split("/")[0] || "other",
      group: path.includes("/") ? path.split("/")[0] : "meta",
      tags: Array.isArray(data.tags) ? data.tags : [],
      summary: str("summary"),
      updated: str("updated") || null,
      lifecycle: str("lifecycle") || null,
    });
  }
  const paths = pages.map((p) => p.path);
  const byName = new Map<string, string[]>();
  for (const p of paths) {
    const n = p.split("/").pop()!;
    byName.set(n, [...(byName.get(n) ?? []), p]);
  }
  const seen = new Set<string>();
  const links: [string, string][] = [];
  for (const p of paths) {
    for (const t of wikilinks(raw[p])) {
      const to = resolveLink(t, paths, byName);
      if (!to || to === p) continue;
      const key = p < to ? `${p}\n${to}` : `${to}\n${p}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push([p, to]);
    }
  }
  return { root: BRAIN, pages, links, inbox: await inbox() };
}

/** One page for the reader: its frontmatter and its body as written. */
export async function brainPage(path: string) {
  if (!/^[\w./-]+$/.test(path) || path.includes("..")) throw new Error("bad page path");
  const text = await Deno.readTextFile(`${BRAIN}/${path}.md`);
  return { path, ...frontmatter(text) };
}

// ---------------------------------------------------------------- the inbox (_raw/)
const INBOX = () => `${BRAIN}/_raw`;
/** What can be dropped: documents /wiki-ingest reads. */
export const INBOX_TYPES = /\.(pdf|md|txt|html?|docx|csv|json)$/i;
export const INBOX_MAX = 50 * 1024 * 1024;

export async function inbox(): Promise<{ name: string; size: number; at: string | null }[]> {
  const out = [];
  try {
    for await (const e of Deno.readDir(INBOX())) {
      if (!e.isFile || e.name.startsWith(".")) continue; // sessions/ is the history importer's
      const st = await Deno.stat(`${INBOX()}/${e.name}`);
      out.push({ name: e.name, size: st.size, at: st.mtime?.toISOString() ?? null });
    }
  } catch { /* no _raw yet */ }
  return out.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}

/** Pure: a name safe to write under _raw/: basename only, tame characters, date in front. */
export function inboxName(original: string, now = new Date()): string {
  const base = original.split(/[\\/]/).pop()!.normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+/, "");
  return `${now.toISOString().slice(0, 10)}-${base || "file"}`;
}

async function freeName(name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  for (let i = 0; ; i++) {
    const n = i ? `${name.slice(0, dot)}-${i}${name.slice(dot)}` : name;
    try { await Deno.lstat(`${INBOX()}/${n}`); } catch { return n; }
  }
}

export async function addToInbox(kind: "file" | "link" | "note", input: { name?: string; bytes?: Uint8Array; url?: string; text?: string }): Promise<string> {
  await Deno.mkdir(INBOX(), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  if (kind === "file") {
    if (!input.name || !INBOX_TYPES.test(input.name)) throw new Error("only documents: pdf, md, txt, html, docx, csv, json");
    if (!input.bytes?.length || input.bytes.length > INBOX_MAX) throw new Error("empty, or over 50 MB");
    const n = await freeName(inboxName(input.name));
    await Deno.writeFile(`${INBOX()}/${n}`, input.bytes);
    return n;
  }
  if (kind === "link") {
    let u: URL;
    try { u = new URL(String(input.url)); } catch { throw new Error("not a valid address"); }
    if (!/^https?:$/.test(u.protocol)) throw new Error("only http(s) addresses");
    const n = await freeName(inboxName(`link-${u.hostname}${u.pathname}`.slice(0, 80) + ".md"));
    await Deno.writeTextFile(`${INBOX()}/${n}`, `---\nsource: ${u.href}\nadded: ${today}\nkind: link\n---\n\n${u.href}\n${input.text?.trim() ? `\n${input.text.trim()}\n` : ""}`);
    return n;
  }
  const text = String(input.text ?? "").trim();
  if (!text) throw new Error("an empty note");
  const n = await freeName(inboxName(`note-${text.split("\n")[0].slice(0, 40)}.md`));
  await Deno.writeTextFile(`${INBOX()}/${n}`, `---\nadded: ${today}\nkind: note\n---\n\n${text}\n`);
  return n;
}

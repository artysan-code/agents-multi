// rules.ts — how the brain is written. Claude writes without asking, so the rules are enforced
// here rather than recommended: a write that breaks one is refused with the reason, and the writer
// fixes it. Agreed with Samuel on 2026-10-01 and meant to be tuned while using it: the numbers are
// the constants below.
//
// Seven areas, named the way Samuel thinks: io (who he is), progetti (his folders), clienti (who
// he works for, directly or through someone: the relationship, not the work), persone, note
// (what he knows how to do), diario (what happened, one page a day, only added to), inbox (said in
// passing, to sort later). Pages are small and linked: one subject each, a title and a sentence
// saying what it is, at least one link to an existing page.

import { maskText } from "../shared/mcp/lib/mask.ts";
import { linksIn, type Store } from "./store.ts";

export const AREAS = ["io", "progetti", "clienti", "persone", "note", "diario", "inbox"] as const;
export type Area = typeof AREAS[number];
/** Areas written by adding lines, not by rewriting. */
export const LOGS: Area[] = ["diario", "inbox"];
export const MAX_WORDS = 400;
export const MAX_WORDS_LOG = 1000;
export const MAX_CODE_LINES = 15;
export const DUPLICATE = 0.6; // title similarity from which a new page is taken for an existing one

/** Pure: a path in the form the brain keeps — lower case, no accents, dashes for spaces. */
export function slugPath(p: string): string {
  const s = String(p ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/i, "");
  const slug = s.split("/").map((seg) =>
    seg.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "")
  ).filter(Boolean).join("/");
  return `${slug}.md`;
}

const words = (s: string) => (s.replace(/^---\n[\s\S]*?\n---\n?/, "").match(/[\p{L}\p{N}]+/gu) ?? []).length;
const titleWords = (s: string) => new Set((s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2));

/** Pure: how alike two titles are, by their words (Jaccard), 1 when one contains the other. */
export function similarity(a: string, b: string): number {
  const x = titleWords(a), y = titleWords(b);
  if (!x.size || !y.size) return 0;
  const inter = [...x].filter((w) => y.has(w)).length;
  if (inter === Math.min(x.size, y.size)) return 1;
  return inter / (x.size + y.size - inter);
}

export const areaOf = (path: string) => path.split("/")[0] as Area;

/** Pure: what is wrong with a page's place and shape, before anything is looked up. */
export function shapeErrors(path: string, body: string): string[] {
  const err: string[] = [];
  const parts = path.replace(/\.md$/, "").split("/");
  const area = parts[0] as Area;
  if (!AREAS.includes(area)) return [`a page lives in one of: ${AREAS.join(", ")} (not "${parts[0]}")`];
  if (parts.length < 2) err.push(`${area}/ needs a name: ${area}/<name>.md`);
  if (["io", "clienti", "persone", "note", "inbox"].includes(area) && parts.length > 2) err.push(`${area}/ is flat: ${area}/<name>.md, no subfolders`);
  if (area === "diario" && !/^diario\/\d{4}-\d{2}-\d{2}$/.test(parts.join("/"))) err.push("a diary page is diario/YYYY-MM-DD.md, one a day");

  const text = body.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  const lines = text.split("\n");
  if (!/^# \S/.test(lines[0] ?? "")) err.push("the page starts with its title: \"# Title\"");
  const first = lines.slice(1).find((l) => l.trim());
  if (!first || /^\s*([#>|-]|\*|\d+\.|```)/.test(first)) err.push("under the title, one plain sentence saying what the page is");

  const n = words(body), max = LOGS.includes(area) ? MAX_WORDS_LOG : MAX_WORDS;
  if (n > max) err.push(`${n} words: at most ${max}. Split it into smaller pages linked to each other`);
  let code = 0, inCode = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) { inCode = !inCode; continue; }
    if (inCode) code++;
  }
  if (code > MAX_CODE_LINES) err.push(`${code} lines of code: at most ${MAX_CODE_LINES}. Code lives in its repository; here, where to find it`);
  if (maskText(body) !== body) err.push("it contains what looks like a secret (a password, a token, credentials in an address): never in the brain");
  return err;
}

export interface Verdict { ok: boolean; errors: string[]; similar?: { path: string; title: string }[] }

/** A write checked against the rules and against what the brain already holds. */
export function check(store: Store, path: string, body: string, opts: { creating: boolean; distinct?: boolean }): Verdict {
  const errors = shapeErrors(path, body);
  const area = areaOf(path);
  if (!LOGS.includes(area)) {
    // a living page links to at least one page that exists — unless there is none yet to link to
    const others = store.db.prepare("select count(*) n from docs where deleted = 0 and path not like 'tasks/%' and path not like 'diario/%' and path not like 'inbox/%' and path <> ?")
      .get(path) as { n: number };
    const live = linksIn(body).map((t) => store.resolve(t)).filter((p) => p && p !== path);
    if (others.n > 0 && !live.length) errors.push("link at least one existing page with [[path]]: the project, person or note this belongs to");
  }
  let similar: Verdict["similar"];
  if (opts.creating && !opts.distinct && !LOGS.includes(area)) {
    const title = body.replace(/^---\n[\s\S]*?\n---\n?/, "").trim().match(/^# (.+)$/m)?.[1] ?? path;
    const name = path.split("/").pop()!.replace(/\.md$/, "").replace(/-/g, " ");
    const rows = store.db.prepare("select path, title from docs where deleted = 0 and path not like 'tasks/%' and path not like 'diario/%'").all() as { path: string; title: string }[];
    similar = rows.filter((r) => Math.max(similarity(title, r.title), similarity(name, r.path.split("/").pop()!.replace(/\.md$/, "").replace(/-/g, " "))) >= DUPLICATE).slice(0, 5);
    if (similar.length) errors.push("pages with a very similar title exist: update one of them, or pass distinct: true if this really is another subject");
  }
  return { ok: !errors.length, errors, ...(similar?.length ? { similar } : {}) };
}

/** Pure: a document's text with every link that meant `from` pointing at `to` instead. */
export function relink(body: string, from: string, to: string, resolve: (t: string) => string | null): string {
  const target = to.replace(/\.md$/, "");
  return body.replace(/\[\[([^\]|#]+)((?:#[^\]|]*)?)((?:\|[^\]]*)?)\]\]/g, (m, t: string, h: string, label: string) =>
    resolve(t.trim()) === from ? `[[${target}${h}${label}]]` : m);
}

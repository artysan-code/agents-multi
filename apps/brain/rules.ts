// rules.ts — how the brain is written. Claude writes without asking, so the rules are enforced
// here rather than recommended: a write that breaks one is refused with the reason, and the writer
// fixes it. Agreed with the owner on 2026-10-01 and meant to be tuned while using it: the numbers are
// the constants below.
//
// Seven areas, named in the account's language (Italian: io, progetti, clienti, persone, note, diario,
// inbox; otherwise me, projects, clients, people, notes, diary, inbox): who they are, their folders, who
// they work for (the relationship, not the work), people, what they know how to do, what happened (one
// page a day, only added to), what was said in passing, to sort later. Pages are small and linked: one subject each, a title and a sentence
// saying what it is, at least one link to an existing page.

import { maskText } from "../../shared/mcp/lib/mask.ts";
import { linksIn, type Store } from "./store.ts";

/** What each area is for; its name depends on the account's language, chosen when it is created. */
const ROLES = ["self", "projects", "clients", "people", "notes", "diary", "inbox"] as const;
export type Areas = Record<typeof ROLES[number], string> & { all: string[] };
const areas = (names: string[]): Areas =>
  ({ ...Object.fromEntries(ROLES.map((r, i) => [r, names[i]])), all: names }) as Areas;
/** Italian, as the brain began (its pages never move); every other language gets the English names. */
export const AREAS_IT = areas(["io", "progetti", "clienti", "persone", "note", "diario", "inbox"]);
export const AREAS_EN = areas(["me", "projects", "clients", "people", "notes", "diary", "inbox"]);
/** Pure: the area names of an account, from its language ("Italian", "italiano", "it"…). */
export const areasFor = (language: string): Areas => /^\s*it(al|$)/i.test(language) ? AREAS_IT : AREAS_EN;
/** The area names a brain uses. */
export const areasOf = (store: Store): Areas => store.areas ?? AREAS_IT;
/** Pure: the areas written by adding lines, not by rewriting. */
export const logs = (a: Areas) => [a.diary, a.inbox];
export const MAX_WORDS = 400;
const MAX_WORDS_LOG = 1000; // the inbox: what is said in passing waits there to be sorted, it does not pile up
export const MAX_ENTRY_WORDS = 40; // one diary line: what changed, in a sentence; the detail lives on the project page
export const MAX_CODE_LINES = 15;
const DUPLICATE = 0.6; // title similarity from which a new page is taken for an existing one

/** Pure: a path in the form the brain keeps — lower case, no accents, dashes for spaces. */
export function slugPath(p: string): string {
  const s = String(p ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/i, "");
  const slug = s.split("/").map((seg) =>
    seg.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-{2,}/g, "-")
      .replace(/^-|-$/g, "")
  ).filter(Boolean).join("/");
  return `${slug}.md`;
}

/** The diary is a record: a busy day may be long, but nothing is refused for the size of the page. */
export const maxWords = (area: string, a: Areas = AREAS_IT) =>
  area === a.diary ? Infinity : area === a.inbox ? MAX_WORDS_LOG : MAX_WORDS;
const words = (s: string) => (s.replace(/^---\n[\s\S]*?\n---\n?/, "").match(/[\p{L}\p{N}]+/gu) ?? []).length;
const titleWords = (s: string) =>
  new Set((s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2));

/** Pure: how alike two titles are, by their words (Jaccard), 1 when one contains the other. */
export function similarity(a: string, b: string): number {
  const x = titleWords(a), y = titleWords(b);
  if (!x.size || !y.size) return 0;
  const inter = [...x].filter((w) => y.has(w)).length;
  if (inter === Math.min(x.size, y.size)) return 1;
  return inter / (x.size + y.size - inter);
}

export const areaOf = (path: string) => path.split("/")[0];

/** Pure: the words of a diary entry, its [[links]] not counted. */
const entryWords = (s: string) => words(s.replace(/\[\[[^\]]*\]\]/g, ""));

/** Pure: a diary entry too long to be one line of the record. */
export function entryErrors(text: string): string[] {
  const n = entryWords(text);
  return n > MAX_ENTRY_WORDS
    ? [`${n} words: a diary line says what changed in at most ${MAX_ENTRY_WORDS}; the detail goes on the project page`]
    : [];
}

/** Pure: whether a diary page may be rewritten as `next` — tidied, never edited away: every timed
 *  line stays, at the same time and in the same order, none is added, and each fits a line. */
export function diaryRewriteErrors(cur: string, next: string): string[] {
  const entries = (b: string) => b.split("\n").filter((l) => /^- \d{2}:\d{2} /.test(l));
  const was = entries(cur).map((l) => l.slice(2, 7)), now = entries(next);
  if (now.map((l) => l.slice(2, 7)).join() !== was.join()) {
    return [
      `a diary page is tidied, not edited: keep every timed line, at its time and in its order (${was.join(", ")})`,
    ];
  }
  return now.flatMap((l) => entryErrors(l.slice(8)).map((e) => `${l.slice(2, 7)}: ${e}`));
}

/** Pure: what is wrong with a page's place and shape, before anything is looked up. */
export function shapeErrors(path: string, body: string, a: Areas = AREAS_IT): string[] {
  const err: string[] = [];
  const parts = path.replace(/\.md$/, "").split("/");
  const area = parts[0];
  if (!a.all.includes(area)) return [`a page lives in one of: ${a.all.join(", ")} (not "${parts[0]}")`];
  if (parts.length < 2) err.push(`${area}/ needs a name: ${area}/<name>.md`);
  if ([a.self, a.clients, a.people, a.notes, a.inbox].includes(area) && parts.length > 2) {
    err.push(`${area}/ is flat: ${area}/<name>.md, no subfolders`);
  }
  if (area === a.diary && !/^\d{4}-\d{2}-\d{2}$/.test(parts.slice(1).join("/"))) {
    err.push(`a diary page is ${a.diary}/YYYY-MM-DD.md, one a day`);
  }

  const text = body.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  const lines = text.split("\n");
  if (!/^# \S/.test(lines[0] ?? "")) err.push('the page starts with its title: "# Title"');
  const first = lines.slice(1).find((l) => l.trim());
  if (!first || /^\s*([#>|-]|\*|\d+\.|```)/.test(first)) {
    err.push("under the title, one plain sentence saying what the page is");
  }

  const n = words(body), max = maxWords(area, a);
  if (n > max) err.push(`${n} words: at most ${max}. Split it into smaller pages linked to each other`);
  let code = 0, inCode = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) code++;
  }
  if (code > MAX_CODE_LINES) {
    err.push(`${code} lines of code: at most ${MAX_CODE_LINES}. Code lives in its repository; here, where to find it`);
  }
  if (maskText(body) !== body) {
    err.push(
      "it contains what looks like a secret (a password, a token, credentials in an address): never in the brain",
    );
  }
  return err;
}

export interface Verdict {
  ok: boolean;
  errors: string[];
  similar?: { path: string; title: string }[];
}

/** A write checked against the rules and against what the brain already holds. */
export function check(
  store: Store,
  path: string,
  body: string,
  opts: { creating: boolean; distinct?: boolean },
): Verdict {
  const a = areasOf(store);
  const errors = shapeErrors(path, body, a);
  const area = areaOf(path);
  if (!logs(a).includes(area)) {
    // a living page links to at least one page that exists — unless there is none yet to link to
    const others = store.db.prepare(
      "select count(*) n from docs where deleted = 0 and path not like 'tasks/%' and path not like ? and path not like ? and path <> ?",
    )
      .get(`${a.diary}/%`, `${a.inbox}/%`, path) as { n: number };
    const live = linksIn(body).map((t) => store.resolve(t)).filter((p) => p && p !== path);
    if (others.n > 0 && !live.length) {
      errors.push("link at least one existing page with [[path]]: the project, person or note this belongs to");
    }
  }
  let similar: Verdict["similar"];
  if (opts.creating && !opts.distinct && !logs(a).includes(area)) {
    const title = body.replace(/^---\n[\s\S]*?\n---\n?/, "").trim().match(/^# (.+)$/m)?.[1] ?? path;
    const name = path.split("/").pop()!.replace(/\.md$/, "").replace(/-/g, " ");
    // only within the area: a client and its project, or a person and the client they work for, share a name by nature
    const rows = store.db.prepare("select path, title from docs where deleted = 0 and path like ?").all(
      `${area}/%`,
    ) as { path: string; title: string }[];
    similar = rows.filter((r) =>
      Math.max(
        similarity(title, r.title),
        similarity(name, r.path.split("/").pop()!.replace(/\.md$/, "").replace(/-/g, " ")),
      ) >= DUPLICATE
    ).slice(0, 5);
    if (similar.length) {
      errors.push(
        "pages with a very similar title exist: update one of them, or pass distinct: true if this really is another subject",
      );
    }
  }
  return { ok: !errors.length, errors, ...(similar?.length ? { similar } : {}) };
}

/** Pure: a document's text with every link that meant `from` pointing at `to` instead. */
export function relink(body: string, from: string, to: string, resolve: (t: string) => string | null): string {
  const target = to.replace(/\.md$/, "");
  return body.replace(
    /\[\[([^\]|#]+)((?:#[^\]|]*)?)((?:\|[^\]]*)?)\]\]/g,
    (m, t: string, h: string, label: string) => resolve(t.trim()) === from ? `[[${target}${h}${label}]]` : m,
  );
}

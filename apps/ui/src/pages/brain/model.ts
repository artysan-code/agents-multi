// model.ts — the brain as the page reasons about it: areas, the link index, who wrote, the diff,
// the diary's lines. Pure, so it is read here and drawn elsewhere.

import { lang, t } from "../../i18n.ts";
import type { HealthReply, PageInfo, PagesReply } from "./api.ts";

export const AREAS = ["io", "progetti", "clienti", "persone", "note", "diario", "inbox"];
/** An account in English names its areas me/, projects/…: the same groups, colours and labels. */
const AREA_EN: Record<string, string> = {
  me: "io",
  projects: "progetti",
  clients: "clienti",
  people: "persone",
  notes: "note",
  diary: "diario",
};
export const areaOf = (a: string | undefined): string => a && AREAS.includes(a) ? a : a ? AREA_EN[a] ?? "other" : "other";
export const bare = (path: string): string => String(path).replace(/\.md$/, "");

type GroupKey = `brain.g.${"io" | "progetti" | "clienti" | "persone" | "note" | "diario" | "inbox" | "other"}`;
export const groupLabel = (g: string): string => t(`brain.g.${g}` as GroupKey);

export interface Brain extends PagesReply {
  health: HealthReply | null;
  byPath: Map<string, PageInfo>;
  out: Map<string, Set<string>>;
  in: Map<string, Set<string>>;
}

export function indexBrain(pages: PagesReply, health: HealthReply | null): Brain {
  const out = new Map<string, Set<string>>(), inn = new Map<string, Set<string>>();
  for (const [a, b] of pages.edges) {
    if (!out.has(a)) out.set(a, new Set());
    if (!inn.has(b)) inn.set(b, new Set());
    out.get(a)!.add(b);
    inn.get(b)!.add(a);
  }
  return { ...pages, health, byPath: new Map(pages.pages.map((p) => [p.path, p])), out, in: inn };
}

export const healthIssues = (h: HealthReply | null): number =>
  h
    ? h.orphans.length + h.broken_links.length + h.too_long.length + h.inbox_older_than_a_week.length +
      h.outside_the_areas.length
    : 0;

/** Where a [[target]] points, as the brain resolves it: the exact path, else the shallowest page
 *  with that name. */
export function resolvePage(b: Brain | null, target: string): string | null {
  if (!b || !target) return null;
  const tg = bare(String(target).replace(/^\/+/, ""));
  if (b.byPath.has(`${tg}.md`)) return `${tg}.md`;
  const name = tg.split("/").pop()!.toLowerCase();
  const hits = b.pages.filter((p) => bare(p.path).split("/").pop()!.toLowerCase() === name);
  hits.sort((a, c) => a.path.split("/").length - c.path.split("/").length || a.path.localeCompare(c.path));
  return hits[0]?.path ?? null;
}

/** Who wrote: "claude:Claude Code" → "Claude · Claude Code", "token:fisso" → "fisso". */
export function who(by: string | undefined): string {
  const [kind, rest] = String(by ?? "").split(/:(.*)/s);
  if (kind === "claude") return rest && rest !== "Claude" ? `Claude · ${rest}` : "Claude";
  if (kind === "token") return rest || t("brain.machine");
  return by || "—";
}

export const when = (iso: string): string =>
  new Date(iso).toLocaleString(lang(), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** The page's text without its "# Title" line (the title is shown above). */
export const withoutTitle = (body: string): string => body.replace(/^\s*#\s+.*\n/, "");

export type Found = { q: string; results: { path: string; title: string; excerpt?: string }[]; note?: string };

/** Pure: the lines of two texts as kept, removed and added (a longest common subsequence: pages
 *  are a few hundred lines at most). */
export function lineDiff(a: string, b: string): [" " | "-" | "+", string][] {
  const x = a.split("\n"), y = b.split("\n"), n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out: [" " | "-" | "+", string][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push([" ", x[i]]);
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) out.push(["-", x[i++]]);
    else out.push(["+", y[j++]]);
  }
  while (i < n) out.push(["-", x[i++]]);
  while (j < m) out.push(["+", y[j++]]);
  return out;
}

/** Pure: a diary page's lines ("- 15:21 text", continued by indented lines) as { time, text }. */
export function diaryEntries(body: string): { time: string; text: string }[] {
  const out: { time: string; text: string }[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^- (\d{2}:\d{2}) (.*)$/);
    if (m) out.push({ time: m[1], text: m[2] });
    else if (/^\s+\S/.test(line) && out.length) out[out.length - 1].text += `\n${line.trim()}`;
  }
  return out;
}

/** Titles and paths matching what is typed (plus the service's last results for it), at once. */
export function matchSet(b: Brain, q: string, found: Found | null): Set<string> | null {
  const s = q.trim().toLowerCase();
  if (!s) return null;
  const set = new Set(b.pages.filter((p) => `${p.title} ${p.path}`.toLowerCase().includes(s)).map((p) => p.path));
  if (found?.q === q.trim()) for (const r of found.results) set.add(r.path);
  return set;
}

// tree.tsx — the page tree (the seven areas, folders under them) and the search results that replace
// it while a search is on screen.

import type { VNode } from "preact";
import { t } from "../../i18n.ts";
import { short } from "../../lib/format.ts";
import { AREAS, areaOf, bare, type Brain, type Found, groupLabel } from "./model.ts";

interface Dir {
  dirs: Map<string, Dir>;
  pages: Brain["pages"];
  path: string;
}
const count = (n: Dir): number => n.pages.length + [...n.dirs.values()].reduce((s, d) => s + count(d), 0);

export function Tree({ brain, hits, sel, open, onToggle, onPick }: {
  brain: Brain;
  hits: Set<string> | null;
  sel: string | null;
  open: Set<string>;
  onToggle: (dir: string) => void;
  onPick: (path: string) => void;
}) {
  // the areas as this brain names them (the API lists them in order)
  const names = brain.areas ? Object.keys(brain.areas) : AREAS;
  const roots = new Map<string, Dir>(names.map((a) => [a, { dirs: new Map(), pages: [], path: a }]));
  for (const p of brain.pages) {
    if (hits && !hits.has(p.path)) continue;
    const parts = bare(p.path).split("/");
    if (!roots.has(parts[0])) roots.set(parts[0], { dirs: new Map(), pages: [], path: parts[0] });
    let node = roots.get(parts[0])!;
    for (let i = 1; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) {
        node.dirs.set(parts[i], { dirs: new Map(), pages: [], path: parts.slice(0, i + 1).join("/") });
      }
      node = node.dirs.get(parts[i])!;
    }
    node.pages.push(p);
  }

  const draw = (node: Dir, depth: number, area: string): VNode[] => {
    const dirs = [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b));
    // the diary reads newest first; elsewhere by title
    const pages = [...node.pages].sort(
      areaOf(area) === "diario" ? (a, b) => b.path.localeCompare(a.path) : (a, b) => a.title.localeCompare(b.title),
    );
    return [
      ...dirs.map(([name, d]) => folder(d, name, depth, area)),
      ...pages.map((p) => (
        <button
          type="button"
          key={p.path}
          class={`bt-p${p.path === sel ? " on" : ""}`}
          data-page={p.path}
          style={{ "--d": depth }}
          title={bare(p.path)}
          onClick={() => onPick(p.path)}
        >
          {p.title}
        </button>
      )),
    ];
  };
  const folder = (d: Dir, label: string, depth: number, area: string): VNode => {
    const n = count(d);
    const isOpen = hits ? n > 0 : open.has(d.path);
    return (
      <div key={d.path} class={`bt-dir${isOpen ? " open" : ""}${n ? "" : " empty"}`}>
        <button type="button" class="bt-f" data-dir={d.path} style={{ "--d": depth }} onClick={() => onToggle(d.path)}>
          <svg viewBox="0 0 24 24" class="ico chev"><path d="M9 6l6 6-6 6" /></svg>
          {depth === 0 && <i class="gdot" style={{ background: `var(--g-${areaOf(area)})` }} />}
          <span>{label}</span>
          <em>{n}</em>
        </button>
        {isOpen && draw(d, depth + 1, area)}
      </div>
    );
  };

  return (
    <nav class="bn-tree" id="bn-tree" aria-label="Pages">
      {[...roots.entries()].map(([a, node]) => folder(node, areaOf(a) !== "other" ? groupLabel(areaOf(a)) : a, 0, a))}
    </nav>
  );
}

/** An excerpt is raw Markdown: links read as their names, headings and emphasis without the marks. */
const plain = (s: string): string =>
  s.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, tg: string, label?: string) => label ?? tg.trim().split("/").pop()!)
    .replace(/\[\[[^\]]*$/, "…").replace(/(^|\s)#{1,6}\s/g, "$1").replace(/\*\*|`/g, "").replace(/\s+/g, " ");

/** The service's marks («…») around the words found become <mark>. */
function marked(s: string): (string | VNode)[] {
  return s.split(/(«[^»]*(?:»|$))/).filter(Boolean).map((x) =>
    x.startsWith("«") ? <mark>{x.slice(1).replace(/»$/, "")}</mark> : x.replace(/»/g, "")
  );
}

export function Results({ brain, found, sel, onPick, onClear }: {
  brain: Brain;
  found: Found;
  sel: string | null;
  onPick: (path: string) => void;
  onClear: () => void;
}) {
  return (
    <nav class="bn-tree" id="bn-tree" aria-label="Pages">
      <div class="bt-rh">
        <b>{t("brain.results", { n: found.results.length })}</b>
        <button type="button" class="btn sm" onClick={onClear}>{t("brain.clear")}</button>
      </div>
      {found.note && (
        <div class="sub bt-note">{/words only|parole/.test(found.note) ? t("brain.wordsOnly") : found.note}</div>
      )}
      {found.results.length
        ? found.results.map((r) => (
          <button type="button" key={r.path} class={`bt-r${r.path === sel ? " on" : ""}`} data-page={r.path} onClick={() => onPick(r.path)}>
            <span class="bt-rt">
              <i class="gdot" style={{ background: `var(--g-${areaOf(brain.byPath.get(r.path)?.area)})` }} />
              {r.title}
            </span>
            <span class="bt-rp">{bare(r.path)}</span>
            {r.excerpt && <span class="bt-rx">{marked(short(plain(r.excerpt), 180))}</span>}
          </button>
        ))
        : <div class="sub bt-note">{t("brain.nothing")}</div>}
    </nav>
  );
}

export function TreeNote({ text }: { text: string }) {
  return <nav class="bn-tree" id="bn-tree" aria-label="Pages"><div class="sub bt-note">{text}</div></nav>;
}

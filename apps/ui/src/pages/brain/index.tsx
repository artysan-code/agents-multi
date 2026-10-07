// brain/index.tsx — the Brain page: the owner's memory on the brain service, read through the console
// (apps/cli/memory.ts keeps the token). Five modes: the page tree with a reader, the whole graph,
// the diary as a timeline, the brain's health, and the old wiki as a read-only archive. Only a view:
// changes are asked of Claude in the field below (kind "brain"), who writes only in the brain.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { t } from "../../i18n.ts";
import { toast } from "../../lib/ui.tsx";
import { ask, askContext } from "../../shell/ask.tsx";
import { useTopic } from "../../state.ts";
import { brainApi, errText, type PageReply } from "./api.ts";
import { Archive } from "./archive.tsx";
import { Diary } from "./diary.tsx";
import { GlobalGraph, LocalGraph } from "./graphs.tsx";
import { BrainHealth } from "./health.tsx";
import { type Brain, type Found, healthIssues, indexBrain, matchSet, resolvePage } from "./model.ts";
import { Links, type OldVersion, Reader } from "./reader.tsx";
import { Results, Tree, TreeNote } from "./tree.tsx";

const MODES = ["read", "graph", "diary", "health", "archive"] as const;
type Mode = typeof MODES[number];

const KEY_MODE = "cm-bmode", KEY_OPEN = "cm-bopen2";

function stored(): { mode: Mode; open: Set<string> } {
  try {
    const m = localStorage.getItem(KEY_MODE) as Mode;
    return {
      mode: MODES.includes(m) ? m : "read",
      open: new Set(JSON.parse(localStorage.getItem(KEY_OPEN) ?? '["progetti"]') as string[]),
    };
  } catch {
    return { mode: "read", open: new Set(["progetti"]) }; // storage blocked: defaults
  }
}

/** The page on screen survives leaving and coming back to the Brain. */
let lastSel: string | null = null;

/** The page first shown: the latest changed one outside the diary, else the first. */
function firstPage(b: Brain): string | null {
  return (b.pages.find((p) => p.area !== "diario" && p.area !== "diary") ?? b.pages[0])?.path ?? null;
}

export function Brain() {
  const init = useMemo(stored, []);
  const [brain, setBrain] = useState<Brain | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(init.mode);
  const [open, setOpen] = useState<Set<string>>(init.open);
  const [sel, setSel] = useState<string | null>(lastSel);
  const [page, setPage] = useState<PageReply | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [ver, setVer] = useState<OldVersion | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [searching, setSearching] = useState(false);
  const [depth2, setDepth2] = useState(false);
  const seq = useRef(0);
  const tree = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const [pages, health] = await Promise.all([brainApi.pages(), brainApi.health().catch(() => null)]);
      const b = indexBrain(pages, health);
      setBrain(b);
      setLoadError(null);
      setSel((cur) => cur && b.byPath.has(cur) ? cur : firstPage(b));
    } catch (e) {
      setBrain(null);
      setLoadError(errText(e));
    }
  };
  useTopic(load, ["brain"]);

  useEffect(() => {
    lastSel = sel;
    try {
      localStorage.setItem(KEY_OPEN, JSON.stringify([...open]));
      localStorage.setItem(KEY_MODE, mode);
    } catch { /* not remembered */ }
  }, [sel, open, mode]);

  // the page on screen is read again when it changes elsewhere, unless an old version is being looked at
  const rev = sel ? brain?.byPath.get(sel)?.rev : undefined;
  useEffect(() => {
    if (!sel || rev === undefined) return;
    if (ver && page?.path === sel) return;
    let live = true;
    setPageError(null);
    brainApi.page(sel).then((p) => live && setPage(p), (e) => live && setPageError(errText(e)));
    return () => void (live = false);
  }, [sel, rev]);

  // the field below asks for changes to this page (or to the brain as a whole, off the reader)
  const title = sel ? brain?.byPath.get(sel)?.title : undefined;
  useEffect(() => {
    if (ask.value.kind !== "newtask") askContext("brain", mode === "read" ? sel : null, title);
  }, [mode, sel, title]);

  // the folders above the page on screen open, whichever way it was picked
  useEffect(() => {
    if (!sel) return;
    const parts = sel.replace(/\.md$/, "").split("/");
    setOpen((o) => {
      const dirs = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
      return dirs.every((d) => o.has(d)) ? o : new Set([...o, ...dirs]);
    });
  }, [sel]);

  useEffect(() => {
    if (mode === "read" && sel) tree.current?.querySelector(`[data-page="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel, mode, brain, sel ? open.has(sel.split("/").slice(0, -1).join("/")) : true]);

  const selectPage = (path: string) => {
    setSel(path);
    setVer(null);
  };
  const read = (path: string) => {
    setMode("read");
    selectPage(path);
  };
  /** A [[target]] or a page named in the diary or the health: it opens in the reader. */
  const openTarget = (target: string) => {
    const path = resolvePage(brain, target);
    if (!path) return toast(t("brain.missing", { p: target }), true);
    read(path);
  };
  const toggleDir = (dir: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (!n.delete(dir)) n.add(dir);
      return n;
    });

  const showVersion = async (r: number) => {
    if (!page) return;
    if (r === page.rev) return setVer(null);
    try {
      const v = await brainApi.version(page.path, r);
      setVer((cur) => ({ rev: r, body: v.body, at: v.at, by: v.by, diff: cur?.diff ?? true }));
    } catch (e) {
      toast(errText(e), true);
    }
  };

  /** Hands a request to the field below as a change to the brain as a whole, and sends it. */
  const askClaude = (text: string) => {
    askContext("brain", null);
    const ta = document.querySelector<HTMLTextAreaElement>(".ask-dock textarea");
    if (!ta?.form) return;
    ta.value = text;
    ta.form.requestSubmit();
  };

  const search = async (text: string) => {
    const n = ++seq.current;
    setSearching(true);
    let f: Found;
    try {
      const r = await brainApi.search(text);
      f = { q: text, results: r.results ?? [], note: r.note };
    } catch (e) {
      f = { q: text, results: [], note: errText(e) };
    }
    if (n !== seq.current) return;
    setFound(f);
    setSearching(false);
  };
  const clearSearch = () => {
    seq.current++;
    setQ("");
    setFound(null);
    setSearching(false);
  };

  const match = useMemo(() => brain ? matchSet(brain, q, found) : null, [brain, q, found]);
  const issues = healthIssues(brain?.health ?? null);

  const treeEl = !brain
    ? null
    : searching
    ? <TreeNote text={t("brain.searching")} />
    : found && found.q === q.trim()
    ? <Results brain={brain} found={found} sel={sel} onPick={selectPage} onClear={clearSearch} />
    : <Tree brain={brain} hits={match} sel={sel} open={open} onToggle={toggleDir} onPick={selectPage} />;

  return (
    <>
      <div class="tb-bar">
        <div class="seg" id="bn-modes" role="group">
          {MODES.map((m) => (
            <button type="button" key={m} aria-pressed={m === mode} onClick={() => setMode(m)}>
              {m === "health" ? <><span>{t("brain.m.health")}</span>{issues > 0 && <em class="n" id="bn-hn">{issues}</em>}</> : t(`brain.m.${m}`)}
            </button>
          ))}
        </div>
        <input
          id="b-q"
          class="search"
          type="search"
          autocomplete="off"
          placeholder={t("brain.search")}
          value={q}
          onInput={(e) => {
            seq.current++; // a search still on its way is for a query no longer there
            setSearching(false);
            setQ(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") return clearSearch();
            if (e.key !== "Enter" || !brain || mode === "diary" || mode === "archive") return;
            const text = e.currentTarget.value.trim();
            if (!text) return;
            // a second Enter on the same results opens the first one
            if (found?.q === text) {
              if (found.results[0]) selectPage(found.results[0].path);
              return;
            }
            void search(text);
          }}
        />
        {brain && <span class="r sub" id="b-sum">{t("brain.sum", { p: brain.pages.length, l: brain.edges.length })}</span>}
      </div>

      {loadError && !brain && (
        <div class="bn-read" id="bn-read">
          <nav class="bn-tree" id="bn-tree" aria-label="Pages" />
          <article class="panel bn-page" id="bn-page"><div class="bn-body"><p class="sub">{t("brain.away", { e: loadError })}</p></div></article>
        </div>
      )}

      {brain && mode === "read" && (
        <div class="bn-read" id="bn-read" ref={tree}>
          {treeEl}
          <Reader
            brain={brain}
            sel={sel}
            page={page}
            ver={ver}
            error={pageError}
            onPage={openTarget}
            onVerView={(diff) => setVer((v) => v && { ...v, diff })}
            onVerClose={() => setVer(null)}
          />
          <aside class="bn-side">
            <section class="panel">
              <div class="panel-h">
                <h3>{t("brain.near")}</h3>
                <label class="r sub bn-opt">
                  <input type="checkbox" id="bn-d2" checked={depth2} onChange={(e) => setDepth2(e.currentTarget.checked)} />
                  <span>{t("brain.depth2")}</span>
                </label>
              </div>
              {sel && <LocalGraph brain={brain} sel={sel} depth2={depth2} onSelect={selectPage} />}
            </section>
            <Links brain={brain} sel={sel} page={page} ver={ver} onOpen={selectPage} onVersion={showVersion} />
          </aside>
        </div>
      )}

      {brain && mode === "graph" && (
        <GlobalGraph brain={brain} sel={sel} match={match} onPick={selectPage} onRead={read} />
      )}
      {brain && mode === "diary" && <Diary brain={brain} q={q} onPage={openTarget} onRead={read} />}
      {brain && mode === "health" && <BrainHealth brain={brain} onPage={openTarget} onOpen={read} onFix={() => askClaude(t("brain.h.prompt"))} />}
      {mode === "archive" && <Archive q={q} onPage={openTarget} onBring={askClaude} />}
    </>
  );
}

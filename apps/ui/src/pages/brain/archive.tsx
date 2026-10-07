// archive.tsx — the old wiki (~/brains/claude) as a read-only archive: a tree of its pages and a
// reader. "Bring into the brain" hands the page on screen to Claude, who rewrites what still holds.

import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n.ts";
import { Markdown } from "../../lib/markdown.tsx";
import { toast } from "../../lib/ui.tsx";
import { type ArchivePage, type ArchiveReply, brainApi, errText } from "./api.ts";
import { withoutTitle } from "./model.ts";

/** The listing is read once: the archive does not change. */
let cache: ArchiveReply | null = null;

export function Archive({ q, onPage, onBring }: {
  q: string;
  onPage: (target: string) => void;
  onBring: (prompt: string) => void;
}) {
  const [arch, setArch] = useState<ArchiveReply | null>(cache);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [body, setBody] = useState<{ path: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cache) return;
    brainApi.archive().then((a) => setArch((cache = a)), (e) => toast(errText(e), true));
  }, []);

  useEffect(() => {
    if (!sel) return;
    let live = true;
    setError(null);
    brainApi.archivePage(sel).then((p) => live && setBody(p), (e) => live && setError(errText(e)));
    return () => void (live = false);
  }, [sel]);

  const art = useRef<HTMLElement>(null);
  useEffect(() => {
    if (art.current) art.current.scrollTop = 0;
  }, [body?.path]);

  if (!arch) return <div class="bn-read bn-arch" id="bn-archive" />;

  const needle = q.trim().toLowerCase();
  const pages = arch.pages.filter((p) => !needle || `${p.title} ${p.path} ${p.summary}`.toLowerCase().includes(needle));
  const groups = new Map<string, ArchivePage[]>();
  for (const p of pages) groups.set(p.group, [...groups.get(p.group) ?? [], p]);
  const toggle = (g: string) => {
    const next = new Set(open);
    if (!next.delete(g)) next.add(g);
    setOpen(next);
  };
  const cur = sel ? arch.pages.find((x) => x.path === sel) : null;

  return (
    <div class="bn-read bn-arch" id="bn-archive">
      <nav class="bn-tree" id="ba-tree">
        {[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([g, ps]) => {
          const isOpen = !!needle || open.has(g);
          return (
            <div key={g} class={`bt-dir${isOpen ? " open" : ""}`}>
              <button type="button" class="bt-f" style={{ "--d": 0 }} onClick={() => toggle(g)}>
                <svg viewBox="0 0 24 24" class="ico chev"><path d="M9 6l6 6-6 6" /></svg>
                <span>{g}</span>
                <em>{ps.length}</em>
              </button>
              {isOpen && [...ps].sort((a, b) => a.title.localeCompare(b.title)).map((p) => (
                <button
                  type="button"
                  key={p.path}
                  class={`bt-p${p.path === sel ? " on" : ""}`}
                  style={{ "--d": 1 }}
                  title={p.path}
                  onClick={() => setSel(p.path)}
                >
                  {p.title}
                </button>
              ))}
            </div>
          );
        })}
        {!groups.size && <div class="sub bt-note">{t("brain.nothing")}</div>}
      </nav>
      <article class="panel bn-page" id="ba-page" ref={art}>
        <div class="bn-body">
          {error
            ? <p class="sub">{error}</p>
            : sel && body?.path === sel
            ? (
              <>
                <div class="bn-crumb">
                  {sel.split("/").map((x, i) => (
                    <>
                      {i > 0 && <>{" "}<span>/</span>{" "}</>}
                      {x}
                    </>
                  ))}
                </div>
                <h1 class="bn-title">{cur?.title ?? sel}</h1>
                <div class="bn-meta">
                  <span class="chip">{t("brain.a.chip")}</span>
                  {cur?.updated && <span>{t("brain.a.updated", { d: cur.updated })}</span>}
                  <button
                    type="button"
                    class="btn primary sm bn-bring"
                    onClick={() => onBring(t("brain.a.prompt", { f: `${arch.root}/${body.path}.md` }))}
                  >
                    {t("brain.a.bring")}
                  </button>
                </div>
                {cur?.summary && <p class="sub bn-asum">{cur.summary}</p>}
                <Markdown src={withoutTitle(body.body)} onPage={onPage} class="md bn-md" />
              </>
            )
            : sel
            ? <p class="sub">{t("brain.loading")}</p>
            : <p class="sub">{t("brain.a.lede", { r: arch.root })}</p>}
        </div>
      </article>
    </div>
  );
}

// brain/index.tsx — Brain: search the brain and read a page, nothing else. A page's Markdown goes through
// lib/markdown.tsx and its [[links]] open the page they name. Redraws on the `brain` topic (the page on
// screen is read again); «Open the brain's board» is the way to everything else.

import { useRef, useState } from "preact/hooks";
import { t } from "../../i18n.ts";
import { ago } from "../../lib/format.ts";
import { Markdown } from "../../lib/markdown.tsx";
import { useTopic } from "../../state.ts";
import { loadBrainInfo, messageOf, type PageReply, readPage, type SearchHit, searchBrain } from "./api.ts";
import "./brain.css";

export function Brain() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<PageReply | null>(null);
  const [err, setErr] = useState("");
  const [board, setBoard] = useState<string | null>(null);
  // the page on screen, for the reload when the brain moves
  const open = useRef<string | null>(null);

  const show = async (path: string) => {
    try {
      const p = await readPage(path);
      open.current = p.path;
      setPage(p);
      setErr("");
    } catch (e) {
      setErr(messageOf(e as Error));
    }
  };
  const search = async (e?: Event) => {
    e?.preventDefault();
    const w = q.trim();
    if (!w) return;
    setBusy(true);
    setPage(null);
    open.current = null;
    try {
      const r = await searchBrain(w);
      setHits(r.results);
      setNote(r.note ?? "");
      setErr("");
    } catch (x) {
      setErr(messageOf(x as Error));
    }
    setBusy(false);
  };
  useTopic(async () => {
    if (open.current) await show(open.current);
    setBoard((await loadBrainInfo().catch(() => null))?.board ?? null);
  }, ["brain"]);

  return (
    <>
      <header class="pg-hr">
        <h1 class="pg-h">{t("nav.brain")}</h1>
        {board && <a class="btn sm" href={board} target="_blank" rel="noopener noreferrer">{t("bn.board")}</a>}
      </header>
      <p class="sub bn-sub">{t("bn.sub")}</p>
      <form class="bn-q" onSubmit={search}>
        <input
          type="search"
          value={q}
          placeholder={t("bn.ph")}
          aria-label={t("bn.ph")}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="btn primary" disabled={busy || !q.trim()}>{t("bn.search")}</button>
      </form>
      {err && <p class="sub">{t("bn.err", { e: err })}</p>}
      {busy && <p class="sub">{t("bn.searching")}</p>}
      {page
        ? (
          <article class="panel bn-page">
            {hits && (
              <button type="button" class="btn ghost sm" onClick={() => {
                setPage(null);
                open.current = null;
              }}>
                ← {t("bn.back")}
              </button>
            )}
            <div class="bn-meta">
              {page.path} · {t("bn.updated", { d: ago(page.updated) })}
            </div>
            <Markdown src={page.body} onPage={show} />
            {page.links.back.length > 0 && (
              <p class="bn-links">
                <b>{t("bn.backlinks")}</b>
                {page.links.back.map((p) => <a key={p} href="#brain" onClick={(e) => { e.preventDefault(); void show(p); }}>{p}</a>)}
              </p>
            )}
          </article>
        )
        : hits && !busy
        ? (
          <>
            {note && <p class="sub">{note}</p>}
            {hits.length === 0 && <p class="sub">{t("bn.none")}</p>}
            <ul class="bn-hits">
              {hits.map((h) => (
                <li key={h.path}>
                  <a href="#brain" onClick={(e) => { e.preventDefault(); void show(h.path); }}>{h.title}</a>
                  <small>{h.path}</small>
                  {h.excerpt && <p>{h.excerpt}</p>}
                </li>
              ))}
            </ul>
          </>
        )
        : !busy && !err && <p class="sub">{t("bn.hint")}</p>}
    </>
  );
}

// brain.tsx — Brain on the phone: search the memory, read a page (its [[links]] open the page they name).

import { useEffect, useState } from "preact/hooks";
import { Markdown } from "../lib/markdown.tsx";
import { type Hit, type Page, readPage, searchBrain } from "./api.ts";
import { go } from "./route.ts";
import { dateOf, t } from "./t.ts";
import { Empty, Failure, Header } from "./ui.tsx";

const open = (path: string) => go({ view: "brain", id: path });

function Reader({ path }: { path: string }) {
  const [page, setPage] = useState<Page | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    readPage(path).then(setPage, (e: Error) => setErr(e.message));
  }, [path]);
  return (
    <>
      <Header title={page?.title ?? path.split("/").pop() ?? path} back="#brain" />
      {err && <Failure text={err} />}
      {page && (
        <article class="page">
          <p class="meta">{page.path} · {dateOf(page.updated, { day: "numeric", month: "short", year: "numeric" })}</p>
          <Markdown src={page.body} onPage={open} />
        </article>
      )}
    </>
  );
}

function Search() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (e: Event) => {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    await searchBrain(q.trim()).then((r) => (setHits(r), setErr("")), (x: Error) => setErr(x.message));
    setBusy(false);
  };
  return (
    <>
      <Header title={t("brain.title")} />
      <form class="search" onSubmit={run} role="search">
        <input
          type="search"
          value={q}
          placeholder={t("brain.ph")}
          aria-label={t("brain.ph")}
          enterkeyhint="search"
          onInput={(e) => setQ(e.currentTarget.value)}
        />
        <button type="submit" class="btn" disabled={busy || !q.trim()}>{t("brain.search")}</button>
      </form>
      {err && <Failure text={err} />}
      {hits && !hits.length && <Empty text={t("brain.none")} />}
      {hits && hits.length > 0 && (
        <ul class="rows">
          {hits.map((h) => (
            <li key={h.path}>
              <a class="row" href={`#brain/${encodeURIComponent(h.path)}`}>
                <span class="row-t">{h.title}</span>
                <span class="row-s">{h.excerpt || h.path}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {!hits && !err && <Empty text={t("brain.hint")} />}
    </>
  );
}

export const Brain = ({ path }: { path?: string }) => path ? <Reader path={path} /> : <Search />;

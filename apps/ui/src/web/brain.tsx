// brain.tsx — Brain on the phone: search the memory, browse the recent pages, read one in the serif face
// (its [[links]] open the page they name).

import { useEffect, useState } from "preact/hooks";
import { Markdown } from "../lib/markdown.tsx";
import { type Hit, loadPages, type Page, type PageHead, readPage, searchBrain } from "./api.ts";
import { go } from "./route.ts";
import { dateOf, t } from "./t.ts";
import { Empty, Failure, Header, Icon, Skeleton } from "./ui.tsx";

const open = (path: string) => go({ view: "brain", id: path });

function Reader({ path }: { path: string }) {
  const [page, setPage] = useState<Page | null>(null);
  const [err, setErr] = useState("");
  const load = () => readPage(path).then((p) => (setPage(p), setErr("")), (e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
  }, [path]);
  return (
    <>
      <Header title={page?.title ?? path.split("/").pop() ?? path} back="#brain" />
      {err && <Failure text={err} retry={load} />}
      {!page && !err && <Skeleton rows={6} tall />}
      {page && (
        <article class="page">
          <p class="crumb">{page.path} · {dateOf(page.updated, { day: "numeric", month: "short", year: "numeric" })}</p>
          <Markdown src={page.body} onPage={open} class="md prose" />
        </article>
      )}
    </>
  );
}

function Rows({ items }: { items: { path: string; title: string; sub: string }[] }) {
  return (
    <ul class="rows">
      {items.map((h) => (
        <li key={h.path}>
          <a class="row" href={`#brain/${encodeURIComponent(h.path)}`}>
            <span class="row-t">{h.title}</span>
            <span class="row-s">{h.sub}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function Search() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [recent, setRecent] = useState<PageHead[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    loadPages().then(setRecent, () => setRecent([]));
  }, []);
  const run = async (e?: Event) => {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    await searchBrain(q.trim()).then((r) => (setHits(r), setErr("")), (x: Error) => setErr(x.message));
    setBusy(false);
  };
  return (
    <>
      <Header large title={t("brain.title")} />
      <form class="search" onSubmit={run} role="search">
        <Icon name="search" size={18} />
        <input
          type="search"
          value={q}
          placeholder={t("brain.ph")}
          aria-label={t("brain.ph")}
          enterkeyhint="search"
          onInput={(e) => {
            setQ(e.currentTarget.value);
            if (!e.currentTarget.value) setHits(null);
          }}
        />
        <button type="submit" class="btn small" disabled={busy || !q.trim()}>{busy ? t("brain.searching") : t("brain.search")}</button>
      </form>
      {err && <Failure text={err} retry={() => void run()} />}
      {hits && !hits.length && <Empty icon="search" text={t("brain.none")} />}
      {hits && hits.length > 0 && <Rows items={hits.map((h) => ({ path: h.path, title: h.title, sub: h.excerpt || h.path }))} />}
      {!hits && !err && (
        <>
          <h2 class="day">{t("brain.recent")}</h2>
          {!recent && <Skeleton rows={5} />}
          {recent && !recent.length && <Empty icon="brain" text={t("brain.hint")} />}
          {recent && recent.length > 0 && (
            <Rows items={recent.map((p) => ({ path: p.path, title: p.title, sub: `${p.area ? `${p.area} · ` : ""}${dateOf(p.updated, { day: "numeric", month: "short" })}` }))} />
          )}
        </>
      )}
    </>
  );
}

export const Brain = ({ path }: { path?: string }) => path ? <Reader path={path} /> : <Search />;

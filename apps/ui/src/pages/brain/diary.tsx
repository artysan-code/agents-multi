// diary.tsx — the diary as a timeline: one section a day, newest first, each line with its time.

import { useEffect, useState } from "preact/hooks";
import { lang, t } from "../../i18n.ts";
import { Markdown } from "../../lib/markdown.tsx";
import { brainApi } from "./api.ts";
import { areaOf, bare, type Brain, diaryEntries } from "./model.ts";

const STEP = 14; // how many days the timeline grows by
/** path → { rev, body }: a day already read is not asked again until it changes. */
const dayCache = new Map<string, { rev: number; body: string }>();

export function Diary({ brain, q, onPage, onRead }: {
  brain: Brain;
  q: string;
  onPage: (target: string) => void;
  onRead: (path: string) => void;
}) {
  const [days, setDays] = useState(STEP);
  const [, bump] = useState(0);
  const all = brain.pages.filter((p) => areaOf(p.area) === "diario").sort((a, b) => b.path.localeCompare(a.path));
  const shown = all.slice(0, days);
  const stale = shown.filter((p) => dayCache.get(p.path)?.rev !== p.rev);

  useEffect(() => {
    let live = true;
    void Promise.all(stale.map(async (p) => {
      const d = await brainApi.page(p.path).catch(() => null);
      if (d) dayCache.set(p.path, { rev: d.rev, body: d.body });
    })).then(() => live && stale.length && bump((n) => n + 1));
    return () => void (live = false);
  }, [stale.map((p) => `${p.path}@${p.rev}`).join(",")]);

  if (!all.length) return <div class="bn-diary" id="bn-diary"><p class="sub">{t("brain.d.empty")}</p></div>;
  const needle = q.trim().toLowerCase();
  const sections = shown.map((p) => {
    const entries = diaryEntries(dayCache.get(p.path)?.body ?? "").reverse().filter((e) => !needle || e.text.toLowerCase().includes(needle));
    if (needle && !entries.length) return null;
    const day = bare(p.path).split("/").pop()!;
    const label = /^\d{4}-\d{2}-\d{2}$/.test(day)
      ? new Date(`${day}T12:00`).toLocaleDateString(lang(), { weekday: "long", day: "numeric", month: "long", year: "numeric" })
      : p.title;
    return (
      <section class="dy-day" key={p.path}>
        <div class="dy-h">
          <h3>{label}</h3>
          <button type="button" class="btn sm" onClick={() => onRead(p.path)}>{t("brain.d.open")}</button>
        </div>
        {entries.map((e, i) => (
          <div class="dy-e" key={i}>
            <time>{e.time}</time>
            <Markdown src={e.text} onPage={onPage} />
          </div>
        ))}
      </section>
    );
  }).filter(Boolean);
  return (
    <div class="bn-diary" id="bn-diary">
      {sections.length ? sections : <p class="sub">{t("brain.d.none")}</p>}
      {all.length > days && <button type="button" class="btn" onClick={() => setDays(days + STEP)}>{t("brain.d.more")}</button>}
    </div>
  );
}

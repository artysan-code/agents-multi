// tasks/index.tsx — Tasks: today with its times first, what is overdue marked, then the open tasks by
// project. Read only but for «done». Redraws on the `brain` topic; «Open the brain's board» is the way to
// everything else (adding, moving, notes, steps).

import { useState } from "preact/hooks";
import { t } from "../../i18n.ts";
import { toast } from "../../lib/ui.tsx";
import { touch, useTopic } from "../../state.ts";
import { loadBrainInfo, loadTasks, markDone, type TaskRow, type TasksView } from "./api.ts";
import "./tasks.css";

function Row({ r, late, onDone }: { r: TaskRow; late?: boolean; onDone: (r: TaskRow) => void }) {
  return (
    <li class={`tk-r${late ? " late" : ""}${r.status === "waiting" ? " wait" : ""}`}>
      {r.source
        ? <span class="tk-dot" style={r.color ? { background: r.color } : undefined} aria-hidden="true" />
        : (
          <button type="button" class="tk-chk" title={t("tk.done")} aria-label={t("tk.done")} onClick={() => onDone(r)} />
        )}
      <span class="tk-time">{r.time ?? ""}</span>
      <span class="tk-title">
        {r.ref && <small>{r.ref}</small>}
        {r.link ? <a href={r.link} target="_blank" rel="noopener noreferrer">{r.title}</a> : r.title}
      </span>
      {late && r.due && <span class="tk-tag">{t("tk.late", { d: r.due.slice(5) })}</span>}
      {r.status === "waiting" && <span class="tk-tag">{t("tk.waiting")}</span>}
    </li>
  );
}

export function Tasks() {
  const [v, setV] = useState<TasksView | null>(null);
  const [err, setErr] = useState("");
  const [board, setBoard] = useState<string | null>(null);
  useTopic(async () => {
    try {
      setV(await loadTasks());
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
    setBoard((await loadBrainInfo().catch(() => null))?.board ?? null);
  }, ["brain"]);

  const done = async (r: TaskRow) => {
    const res = await markDone(r.id).catch((e: Error) => ({ ok: false, message: e.message }));
    if (!res.ok) return toast(res.message ?? "", true);
    toast(t("tk.doneToast", { t: r.title }));
    touch("brain");
  };

  return (
    <>
      <header class="pg-hr">
        <h1 class="pg-h">{t("nav.tasks")}</h1>
        {board && <a class="btn sm" href={board} target="_blank" rel="noopener noreferrer">{t("tk.board")}</a>}
      </header>
      <p class="sub tk-sub">{t("tk.sub")}</p>
      {err && <p class="sub">{t("tk.err", { e: err })}</p>}
      {!v && !err && <p class="sub">{t("tk.loading")}</p>}
      {v && (
        <div class="tk">
          <section class="panel tk-sec">
            <h2 class="tk-h">{t("tk.today")} <small>{v.day}</small></h2>
            {v.today.length
              ? <ul class="tk-l">{v.today.map((r) => <Row key={r.id} r={r} onDone={done} />)}</ul>
              : <p class="sub">{t("tk.nothingToday")}</p>}
          </section>
          {v.overdue.length > 0 && (
            <section class="panel tk-sec">
              <h2 class="tk-h late">{t("tk.overdue")}</h2>
              <ul class="tk-l">{v.overdue.map((r) => <Row key={r.id} r={r} late onDone={done} />)}</ul>
            </section>
          )}
          <section class="panel tk-sec">
            <h2 class="tk-h">{t("tk.open")}</h2>
            {v.projects.length === 0 && <p class="sub">{t("tk.none")}</p>}
            {v.projects.map((p) => (
              <div key={p.project ?? ""} class="tk-grp">
                <h3>{p.project ?? t("tk.noProject")}</h3>
                <ul class="tk-l">
                  {p.tasks.map((r) => (
                    <li key={r.id} class={`tk-r${r.status === "waiting" ? " wait" : ""}`}>
                      <button type="button" class="tk-chk" title={t("tk.done")} aria-label={t("tk.done")} onClick={() => done(r)} />
                      <span class="tk-time">{r.due ? r.due.slice(5) : ""}</span>
                      <span class="tk-title">{r.ref && <small>{r.ref}</small>}{r.title}</span>
                      {r.status === "waiting" && <span class="tk-tag">{t("tk.waiting")}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        </div>
      )}
    </>
  );
}

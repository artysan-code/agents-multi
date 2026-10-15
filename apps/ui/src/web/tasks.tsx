// tasks.tsx — Tasks on the phone: today with its times, what is overdue, what was done today. «Done» is the
// one change (the board's own route, where the repeat and the other rules run).

import { useEffect, useState } from "preact/hooks";
import { markDone, taskFiles } from "./api.ts";
import { parseTasks, type Task, taskSections } from "./lib.ts";
import { t } from "./t.ts";
import { Empty, Failure, Header } from "./ui.tsx";

function Row({ task, late, onDone }: { task: Task; late?: boolean; onDone?: (t: Task) => void }) {
  const finished = task.status === "done";
  return (
    <li class={`task-r${late ? " late" : ""}${finished ? " fin" : ""}`}>
      <button
        type="button"
        class="chk"
        disabled={finished || !onDone}
        aria-label={finished ? t("tasks.isDone") : t("tasks.done")}
        onClick={() => onDone?.(task)}
      >
        {finished && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4 10-10" /></svg>}
      </button>
      <span class="time">{task.time ?? ""}</span>
      <span class="task-t">
        {task.title}
        {(task.ref || task.project) && <small>{[task.ref, task.project?.split("/").pop()].filter(Boolean).join(" · ")}</small>}
      </span>
      {late && task.due && <span class="tag">{t("tasks.since", { d: task.due.slice(5) })}</span>}
      {task.status === "waiting" && <span class="tag">{t("tasks.waiting")}</span>}
    </li>
  );
}

export function Tasks() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [err, setErr] = useState("");
  const load = () => taskFiles().then((f) => (setTasks(parseTasks(f)), setErr("")), (e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
    const again = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, []);

  const done = async (task: Task) => {
    // shown done at once; read again from the service, which is the one that knows the next of a repeating task
    setTasks((all) => all?.map((x) => (x.id === task.id ? { ...x, status: "done", done: new Date().toISOString() } : x)) ?? null);
    await markDone(task.id).then(load, (e: Error) => (setErr(e.message), load()));
  };

  const s = tasks ? taskSections(tasks, new Date()) : null;
  return (
    <>
      <Header title={t("tasks.title")} />
      {err && <Failure text={err} retry={load} />}
      {s && !s.overdue.length && !s.today.length && !s.done.length && !err && <Empty text={t("tasks.none")} />}
      {s && s.overdue.length > 0 && (
        <section>
          <h2 class="day late">{t("tasks.overdue")}</h2>
          <ul class="rows tasks">{s.overdue.map((x) => <Row key={x.id} task={x} late onDone={done} />)}</ul>
        </section>
      )}
      {s && s.today.length > 0 && (
        <section>
          <h2 class="day">{t("tasks.today")}</h2>
          <ul class="rows tasks">{s.today.map((x) => <Row key={x.id} task={x} onDone={done} />)}</ul>
        </section>
      )}
      {s && s.done.length > 0 && (
        <section>
          <h2 class="day">{t("tasks.doneToday", { n: s.done.length })}</h2>
          <ul class="rows tasks">{s.done.map((x) => <Row key={x.id} task={x} />)}</ul>
        </section>
      )}
    </>
  );
}

// tasks.tsx — Tasks on the phone: today with its times, what is overdue, what was done today. «Done» is the
// one change (the board's own route, where the repeat and the other rules run).

import { useEffect, useState } from "preact/hooks";
import { markDone, taskFiles } from "./api.ts";
import { parseTasks, type Task, taskSections } from "./lib.ts";
import { dateOf, t } from "./t.ts";
import { Empty, Failure, Header, Icon, Skeleton, usePull } from "./ui.tsx";

function Row({ task, late, onDone }: { task: Task; late?: boolean; onDone?: (t: Task) => void }) {
  const finished = task.status === "done";
  const sub = [task.ref, task.project?.split("/").pop()].filter(Boolean).join(" · ");
  return (
    <li class={`task-r${late ? " late" : ""}${finished ? " fin" : ""}`}>
      <button
        type="button"
        class="chk"
        disabled={finished || !onDone}
        aria-label={finished ? t("tasks.isDone") : t("tasks.done", { t: task.title })}
        onClick={() => onDone?.(task)}
      >
        {finished && <Icon name="check" size={14} />}
      </button>
      <span class="task-t">
        {task.title}
        {sub && <small>{sub}</small>}
      </span>
      {task.time && <span class="time">{task.time}</span>}
      {late && task.due && <span class="tag crit">{t("tasks.since", { d: dateOf(task.due, { day: "numeric", month: "short" }) })}</span>}
      {task.status === "waiting" && <span class="tag warn">{t("tasks.waiting")}</span>}
      {task.status === "doing" && <span class="tag">{t("tasks.doing")}</span>}
    </li>
  );
}

export function Tasks() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [err, setErr] = useState("");
  const load = () => taskFiles().then((f) => (setTasks(parseTasks(f)), setErr("")), (e: Error) => setErr(e.message));
  const pull = usePull(load);
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

  const now = new Date();
  const s = tasks ? taskSections(tasks, now) : null;
  const open = s ? s.overdue.length + s.today.length : 0;
  return (
    <>
      {pull.indicator}
      <Header
        large
        title={t("tasks.title")}
        sub={s ? (open ? t("tasks.open", { n: open }) : undefined) : dateOf(now.toISOString(), { weekday: "long", day: "numeric", month: "long" })}
      />
      {err && <Failure text={err} retry={load} />}
      {!tasks && !err && <Skeleton rows={5} />}
      {s && !open && !s.done.length && !err && <Empty icon="tasks" text={t("tasks.none")} />}
      {s && !open && s.done.length > 0 && <Empty icon="check" text={t("tasks.clear")} />}
      {s && s.overdue.length > 0 && (
        <section>
          <h2 class="day late">{t("tasks.overdue")} · {s.overdue.length}</h2>
          <ul class="rows tasks">{s.overdue.map((x) => <Row key={x.id} task={x} late onDone={done} />)}</ul>
        </section>
      )}
      {s && s.today.length > 0 && (
        <section>
          <h2 class="day">{t("tasks.today")} · {s.today.length}</h2>
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

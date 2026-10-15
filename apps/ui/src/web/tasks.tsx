// tasks.tsx — Tasks on the phone: today with its times, what is overdue, what was done today, in compact rows.
// «Done» is the one change (the board's own route, where the repeat and the other rules run), by the circle or
// by swiping the row to the right.

import { useEffect, useState } from "preact/hooks";
import { markDone, taskFiles } from "./api.ts";
import { parseTasks, type Task, taskSections } from "./lib.ts";
import { dateOf, t } from "./t.ts";
import { Swipe } from "./swipe.tsx";
import { Empty, Failure, Header, Icon, Skeleton, usePull } from "./ui.tsx";

/** One task: a title at a readable size cut at two lines, and under it one small line (time, reference, project,
 *  how late it is, what it waits on). Swiping it to the right marks it done; the circle does the same. */
function Row({ task, late, onDone }: { task: Task; late?: boolean; onDone?: (t: Task) => void }) {
  const finished = task.status === "done";
  const project = task.project?.split("/").pop();
  const meta = [
    task.time && <b class="time" key="t">{task.time}</b>,
    task.ref && <span key="r">{task.ref}</span>,
    project && <span key="p">{project}</span>,
    late && task.due && <span class="since" key="s">{t("tasks.since", { d: dateOf(task.due, { day: "numeric", month: "short" }) })}</span>,
    task.status === "waiting" && <span class="st warn" key="w">{t("tasks.waiting")}</span>,
    task.status === "doing" && <span class="st" key="d">{t("tasks.doing")}</span>,
  ].filter(Boolean);
  return (
    <li class={`task-r${late ? " late" : ""}${finished ? " fin" : ""}`}>
      <Swipe
        disabled={finished || !onDone}
        right={{ label: t("tasks.doneShort"), tone: "ok", icon: "check", leave: true, run: () => onDone?.(task) }}
      >
        <div class="task-in">
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
            <span class="tt">{task.title}</span>
            {meta.length > 0 && <small class="tm">{meta}</small>}
          </span>
        </div>
      </Swipe>
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

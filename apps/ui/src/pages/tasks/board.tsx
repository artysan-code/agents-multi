// board.tsx — what the main pane shows: one project's Kanban board (cards move between columns by
// dragging), or all the projects at a glance.

import { useState } from "preact/hooks";
import { type Key, t, tk } from "../../i18n.ts";
import { toast } from "../../lib/ui.tsx";
import { owner } from "../../state.ts";
import { type BoardTask, type Progress, taskOp } from "./api.ts";
import {
  board,
  byDue,
  byWeight,
  COLS,
  currentProject,
  dayLabel,
  isOpen,
  NONE,
  openCount,
  pickProject,
  projectLabel,
  projectOf,
  refreshBoard,
  stepsOf,
} from "./model.ts";
import { openTask } from "./sheet.tsx";

export function Bar({ p }: { p: Progress }) {
  return (
    <>
      <span class="tbar" title={`${p.done}/${p.total}`}>
        <i style={{ width: `${p.pct}%` }} />
      </span>
      <small class="tpct">{p.done}/{p.total}</small>
    </>
  );
}

function Card(
  { x, onDragId }: { x: BoardTask; onDragId: (id: string | null) => void },
) {
  const today = board.value!.today;
  const late = !!x.due && x.due < today && isOpen(x);
  const where = currentProject() ? "" : projectLabel(projectOf(x));
  const repeat = x.repeat ? tk(`ts.r.${x.repeat}`) : "";
  const [dragging, setDragging] = useState(false);
  return (
    <article
      class={`tcard${x.status === "doing" ? " doing" : ""}${
        dragging ? " dragging" : ""
      }`}
      draggable
      data-task={x.id}
      onClick={() => openTask(x.id)}
      onDragStart={(e) => {
        onDragId(x.id);
        e.dataTransfer?.setData("text/plain", x.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => {
        onDragId(null);
        setDragging(false);
      }}
    >
      <div class="tc-top">
        {x.ref && <span class="tc-ref">{x.ref}</span>}
        {x.priority === 1 && <span class="tc-prio">{t("ts.p1")}</span>}
        {where && <span class="tc-where">{where}</span>}
        {x.due && (
          <span
            class={`tc-due${
              late ? " tc-late" : x.due === today ? " tc-today" : ""
            }`}
          >
            {dayLabel(x.due, x.time)}
          </span>
        )}
      </div>
      <div class="tc-t">{x.title}</div>
      {x.blocked && isOpen(x) && (
        <span class="tc-blocked">{t("tb.blocked")}</span>
      )}
      <div class="tc-m">
        {x.stage && <span class="tc-stage">{x.stage}</span>}
        {(x.labels ?? []).map((l) => <span key={l} class="tc-label">{l}</span>)}
        {x.owner && x.owner !== owner.value.id && (
          <span class="tc-who">
            <i>{x.owner[0]}</i>
            {x.owner}
          </span>
        )}
        {x.repeat && <span title={repeat}>{repeat}</span>}
        {!!x.attachments && <span>{t("tb.attN", { n: x.attachments })}</span>}
        {x.parts && (
          <span>{t("tb.parts", { d: x.parts.done, n: x.parts.total })}</span>
        )}
      </div>
      {x.progress && x.status !== "done" && (
        <div class="tc-pr">
          <Bar p={x.progress} />
        </div>
      )}
    </article>
  );
}

/** Dragging a card to another column sets its status: the card moves now, the event redraws with the truth. */
async function moveTask(id: string, status: string): Promise<void> {
  const b = board.value;
  const x = b?.tasks.find((y) => y.id === id);
  if (!b || !x || x.status === status) return;
  const was = x.status;
  board.value = {
    ...b,
    tasks: b.tasks.map((y) =>
      y.id === id ? { ...y, status: status as BoardTask["status"] } : y
    ),
  };
  const r = await taskOp({ op: "update", id, status });
  if (!r) {
    board.value = {
      ...board.value!,
      tasks: board.value!.tasks.map((y) =>
        y.id === id ? { ...y, status: was } : y
      ),
    };
    return;
  }
  toast(t("tb.moved", { t: r.task.title, s: tk(`tb.col.${status}`) }));
  await refreshBoard().catch(() => {});
}

export function Kanban({ xs }: { xs: BoardTask[] }) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  return (
    <div class="kanban">
      {COLS.map((c) => {
        const cs = xs.filter((x) => x.status === c).sort(
          c === "done"
            ? (a, b) => (b.done ?? "").localeCompare(a.done ?? "")
            : byWeight,
        );
        return (
          <section
            key={c}
            class={`kcol${over === c ? " over" : ""}`}
            data-col={c}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              if (over !== c) setOver(c);
            }}
            onDrop={(e) => {
              if (!dragId) return;
              e.preventDefault();
              const id = dragId;
              setOver(null);
              setDragId(null);
              void moveTask(id, c);
            }}
          >
            <header>
              <b>{t(`tb.col.${c}` as Key)}</b>
              <i>{cs.length}</i>
            </header>
            <div class="kcards">
              {cs.map((x) => (
                <Card
                  key={x.id}
                  x={x}
                  onDragId={(id) => {
                    setDragId(id);
                    if (!id) setOver(null);
                  }}
                />
              ))}
              {!cs.length && c !== "done" && (
                <div class="kempty">
                  {t(c === "todo" ? "tb.emptyTodo" : "tb.dropHere")}
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** All projects at a glance: what is open in each, how far along, and what comes next. */
export function Overview({ xs }: { xs: BoardTask[] }) {
  const groups = new Map<string, BoardTask[]>();
  for (const x of xs.filter(isOpen)) {
    const k = projectOf(x);
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  const keys = [...groups.keys()].sort((a, b) =>
    (a === NONE ? 1 : 0) - (b === NONE ? 1 : 0) ||
    projectLabel(a).localeCompare(projectLabel(b))
  );
  if (!keys.length) return <div class="kempty">{t("tb.empty")}</div>;
  return (
    <div class="plist">
      {keys.map((k) => {
        const g = [...groups.get(k)!].sort(byDue);
        const next = g.find((x) => x.status !== "waiting") ?? g[0];
        const s = stepsOf(g);
        return (
          <button
            key={k}
            type="button"
            class={`pcard${
              g.some((x) => x.status === "doing") ? " doing" : ""
            }`}
            onClick={() => pickProject(k)}
          >
            <span class="pc-h">
              <b>{projectLabel(k)}</b>
              <span class="pc-n">{openCount(g.length)}</span>
            </span>
            {k !== NONE && (
              <small>{k.startsWith("~other:") ? k.slice(7) : `~/${k}`}</small>
            )}
            {s.n > 0 && (
              <span class="tc-pr">
                <Bar
                  p={{
                    done: s.d,
                    total: s.n,
                    pct: Math.round(s.d / s.n * 100),
                  }}
                />
              </span>
            )}
            <span class="pc-next">
              {next.due && <small>{dayLabel(next.due, next.time)}</small>}
              <span>{next.title}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// groups.tsx — Today's tasks in four groups that mean something: late, today, in progress, waiting
// (on someone, Claude apart). Each row has its progress bar, one segment per step, with the next step
// half filled; hovering the bar lists the steps, Enter opens them under the row with «Tick …» and
// «Open card». The filters keep mine, Claude's or the others'; J/K move, Enter opens, X marks done.
// Only this list scrolls on the page.

import { useEffect, useRef, useState } from "preact/hooks";
import { lang, t } from "../../i18n.ts";
import { short } from "../../lib/format.ts";
import { inline } from "../../lib/markdown.tsx";
import { drawerOpen, toast } from "../../lib/ui.tsx";
import { owner, touch } from "../../state.ts";
import { type BoardTask, taskOp } from "../tasks/api.ts";
import { board, refreshBoard } from "../tasks/model.ts";
import { openTask } from "../tasks/sheet.tsx";
import { daysBetween, GROUPS, type GroupName, groupTasks } from "./model.ts";

type Filter = "all" | "me" | "claude" | "others";
const FILTERS: Filter[] = ["all", "me", "claude", "others"];

const shortDay = (d: string) => new Date(d + "T12:00").toLocaleDateString(lang(), { weekday: "short", day: "numeric" });
const where = (x: BoardTask) => (x.folder ? x.folder.split("/").pop()! : x.project ?? "");
const mine = (x: BoardTask) => !x.owner || x.owner === owner.value.id;

function keep(x: BoardTask, f: Filter): boolean {
  if (f === "all") return true;
  if (f === "me") return mine(x);
  if (f === "claude") return x.owner === "claude";
  return !mine(x) && x.owner !== "claude";
}

/** The steps, as the board sends them; an older console sends only the counts. */
function stepsOf(x: BoardTask): { text: string; done: boolean }[] {
  if (x.steps?.length) return x.steps;
  const p = x.progress;
  return p ? Array.from({ length: p.total }, (_, i) => ({ text: "", done: i < p.done })) : [];
}

/** The bar's colour: green when ready, red when late, amber waiting, the spark while Claude works. */
function tone(x: BoardTask, g: GroupName): string {
  if (x.progress && x.progress.pct === 100) return "ok";
  if (x.owner === "claude") return "cl";
  if (g === "late") return "late";
  if (g === "wait") return "wait";
  return "";
}

const ICK = (
  <svg viewBox="0 0 14 14">
    <path d="M3 7.5l2.6 2.5L11 4.5" />
  </svg>
);
const SPK = (
  <svg viewBox="0 0 14 14">
    <path d="M7 1.5v11M1.5 7h11M3.1 3.1l7.8 7.8M10.9 3.1l-7.8 7.8" />
  </svg>
);

function StepList({ steps, max = 99 }: { steps: { text: string; done: boolean }[]; max?: number }) {
  const nx = steps.findIndex((s) => !s.done);
  // a long list: the done ones before the next step fold into one line
  const fold = steps.length > max && nx > 1 ? nx - 1 : 0;
  const shown = steps.slice(fold, fold + max);
  return (
    <>
      {fold > 0 && <div class="st dn">{ICK}{t("steps.doneN", { n: fold })}</div>}
      {shown.map((s, j) => {
        const i = j + fold;
        return (
          <div key={i} class={`st${s.done ? " dn" : i === nx ? " x" : ""}`}>
            {s.done ? ICK : <span class="o" />}
            <span>{s.text ? inline(s.text) : t("steps.n", { n: i + 1 })}</span>
          </div>
        );
      })}
      {fold + max < steps.length && <div class="st dn">{t("steps.more", { n: steps.length - fold - max })}</div>}
    </>
  );
}

function Progress({ x, g, onHover }: {
  x: BoardTask;
  g: GroupName;
  onHover: (h: { id: string; r: DOMRect } | null) => void;
}) {
  const steps = stepsOf(x);
  if (!steps.length) return <div class="pg" />;
  const done = steps.filter((s) => s.done).length, n = steps.length;
  // one plain bar and the count: the steps themselves are in the hover and in the open row
  return (
    <div
      class={`pg ${tone(x, g)}`}
      onMouseEnter={(e) => onHover({ id: x.id, r: e.currentTarget.getBoundingClientRect() })}
      onMouseLeave={() => onHover(null)}
    >
      <div class="pg-bar">
        <i class="d" style={{ width: `${Math.round((done / n) * 100)}%` }} />
      </div>
      <b>{done}/{n}</b>
    </div>
  );
}

function Due({ x, g, today }: { x: BoardTask; g: GroupName; today: string }) {
  if (g === "late" && x.due) {
    const d = daysBetween(x.due, today);
    return (
      <div class="due late">
        {shortDay(x.due)}
        <small>{d === 1 ? t("due.yesterday") : t("due.daysAgo", { n: d })}</small>
      </div>
    );
  }
  if (x.due === today) return <div class="due d0">{x.time ?? t("due.today")}</div>;
  if (x.due) return <div class={`due${x.due < today ? " late" : ""}`}>{shortDay(x.due)}{x.time && <small>{x.time}</small>}</div>;
  if (g === "wait" && x.updated) return <div class="due">{t("due.since", { d: shortDay(x.updated.slice(0, 10)) })}</div>;
  return <div class="due">—</div>;
}

function Row({ x, g, today, sel, open, onSel, onToggle, onDone, onLater, onHover }: {
  x: BoardTask;
  g: GroupName;
  today: string;
  sel: boolean;
  open: boolean;
  onSel: () => void;
  onToggle: () => void;
  onDone: () => void;
  onLater: () => void;
  onHover: (h: { id: string; r: DOMRect } | null) => void;
}) {
  const claude = x.owner === "claude";
  const waits = g === "wait" && !claude;
  const who = claude
    ? <span class="who cl">{SPK}{t("row.claude")}</span>
    : x.owner && x.owner !== owner.value.id
    ? <span class="who">{t("row.waits", { w: x.owner })}</span>
    : null;
  // the row says the project; who has it, the stage and the rest are in the open row
  const secondary = [
    who,
    x.stage ? <span class="stage">{x.stage}</span> : null,
    x.parts ? <span>{t("row.parts", { d: x.parts.done, n: x.parts.total })}</span> : null,
    x.blocked ? <span class="blk">{t("row.blocked")}</span> : null,
    x.ref ? <span class="mono ref">{x.ref}</span> : null,
  ].filter(Boolean);
  const steps = stepsOf(x);
  const nx = steps.findIndex((s) => !s.done);
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sel) el.current?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  return (
    <>
      <div
        ref={el}
        class={`tr${sel ? " cur" : ""}${open ? " open" : ""}${waits || claude ? " w" : ""}`}
        onClick={() => {
          onSel();
          onToggle();
        }}
      >
        <button
          type="button"
          class="ck"
          title={t("ts.done")}
          aria-label={t("ts.done")}
          onClick={(e) => {
            e.stopPropagation();
            onDone();
          }}
        />
        <div class="tt">
          <b title={x.title}>
            {x.priority === 1 && <span class="pri">! </span>}
            {x.title}
          </b>
          {where(x) && (
            <div class="tm">
              <span class="proj">{where(x)}</span>
            </div>
          )}
        </div>
        <Progress x={x} g={g} onHover={onHover} />
        <Due x={x} g={g} today={today} />
        {g === "late" && (
          <div class="ra" onClick={(e) => e.stopPropagation()}>
            <button type="button" class="bt sm" onClick={onLater}>{t("row.tomorrow")}</button>
            <button type="button" class="bt sm" onClick={onDone}>{t("row.done")}</button>
          </div>
        )}
      </div>
      {open && (
        <div class="exp">
          {steps.length > 0 ? <div class="exp-steps"><StepList steps={steps} /></div> : <div class="exp-none">{t("steps.none")}</div>}
          <div class="exp-r">
            {secondary.length > 0 && <div class="tm exp-meta">{secondary}</div>}
            <div class="exp-bt">
              {nx >= 0 && steps[nx].text && (
                <button
                  type="button"
                  class="bt sm pri"
                  onClick={() => void taskOp({ op: "step", id: x.id, index: nx, done: true }).then((r) => r && refresh())}
                >
                  {t("steps.tick", { s: short(steps[nx].text.replace(/[`*_]/g, ""), 36) })}
                </button>
              )}
              <button type="button" class="bt sm" onClick={() => void openTask(x.id)}>{t("row.card")}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function refresh(): void {
  void refreshBoard().catch(() => {});
  touch("tasks");
}

export function TaskGroups() {
  const [filter, setFilter] = useState<Filter>("all");
  const [sel, setSel] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [hover, setHover] = useState<{ id: string; r: DOMRect } | null>(null);
  const b = board.value;
  const today = b?.today ?? new Date().toISOString().slice(0, 10);
  const groups = groupTasks((b?.tasks ?? []).filter((x) => keep(x, filter)), today, owner.value.id);
  const flat = GROUPS.flatMap((g) => groups[g].map((x) => ({ x, g })));

  const done = async (x: BoardTask) => {
    const r = await taskOp({ op: "update", id: x.id, status: "done" });
    if (!r) return;
    toast(t("tasks.done", { t: x.title }));
    refresh();
  };
  const later = async (x: BoardTask) => {
    const d = new Date(today + "T12:00");
    d.setDate(d.getDate() + 1);
    const r = await taskOp({ op: "update", id: x.id, due: d.toISOString().slice(0, 10) });
    if (r) refresh();
  };

  // J/K move, Enter opens the steps, X marks done, Esc closes; never under a field or a drawer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || drawerOpen()) return;
      if ((e.target as Element)?.closest?.("input, textarea, select, [contenteditable], [role=listbox], [role=menu]")) return;
      const i = flat.findIndex((r) => r.x.id === sel);
      const k = e.key.toLowerCase();
      if (k === "j" || k === "k") {
        const n = flat[Math.max(0, Math.min(flat.length - 1, i < 0 ? 0 : i + (k === "j" ? 1 : -1)))];
        if (n) setSel(n.x.id);
      } else if (e.key === "Enter" && sel) setOpen(open === sel ? null : sel);
      else if (k === "x" && i >= 0) void done(flat[i].x);
      else if (e.key === "Escape" && open) setOpen(null);
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [flat, sel, open]);

  const hx = hover && flat.find((r) => r.x.id === hover.id);
  const hsteps = hx ? stepsOf(hx.x) : [];
  const stepSum = (xs: BoardTask[]) =>
    xs.reduce((a, x) => (x.progress ? { d: a.d + x.progress.done, n: a.n + x.progress.total } : a), { d: 0, n: 0 });

  return (
    <article class="card tq">
      <div class="tq-h">
        <h3>{t("nav.tasks")}</h3>
        <div class="sg tq-f" role="radiogroup" aria-label={t("tq.filter")}>
          {FILTERS.map((f) => (
            <button type="button" role="radio" key={f} aria-checked={filter === f} onClick={() => setFilter(f)}>
              {t(`tq.f.${f}`)}
            </button>
          ))}
        </div>
        <span class="tq-hint">
          <kbd class="k2">J</kbd>
          <kbd class="k2">K</kbd> {t("tq.move")} · <kbd class="k2">↵</kbd> {t("tq.steps")} · <kbd class="k2">X</kbd> {t("tq.done")}
        </span>
      </div>
      <div class="tq-list" tabindex={0} aria-label={t("nav.tasks")}>
        {!b && <div class="tq-empty" />}
        {b && !flat.length && <div class="tq-empty">{t("tq.empty")} <a href="#tasks">{t("tq.all")}</a></div>}
        {GROUPS.map((g) => {
          const xs = groups[g];
          if (!xs.length) return null;
          const s = stepSum(xs);
          return (
            <section key={g} class="tq-g">
              <div class={`gh ${g}`}>
                {t(`tq.g.${g}`)}
                <span class="c">{xs.length}</span>
                {g === "doing" && s.n > 0 && <span class="r">{t("tq.stepsSum", { d: s.d, n: s.n })}</span>}
              </div>
              {xs.map((x) => (
                <Row
                  key={x.id}
                  x={x}
                  g={g}
                  today={today}
                  sel={sel === x.id}
                  open={open === x.id}
                  onSel={() => setSel(x.id)}
                  onToggle={() => setOpen(open === x.id ? null : x.id)}
                  onDone={() => void done(x)}
                  onLater={() => void later(x)}
                  onHover={setHover}
                />
              ))}
            </section>
          );
        })}
      </div>
      {hover && hsteps.length > 0 && hsteps.some((s) => s.text) && (
        <div
          class="pg-pop"
          style={{
            left: `${Math.max(8, hover.r.right - 280)}px`,
            // above the bar, unless it is too near the top of the window
            ...(hover.r.top > 280 ? { bottom: `${innerHeight - hover.r.top + 8}px` } : { top: `${hover.r.bottom + 8}px` }),
          }}
          role="tooltip"
        >
          <StepList steps={hsteps} max={8} />
        </div>
      )}
    </article>
  );
}

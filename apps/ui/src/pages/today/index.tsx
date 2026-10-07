// today/index.tsx — the Today page: the day (late, then one line of time with a mark for now), the
// morning debrief, the sessions running and the ones to pick up again, and what waits to be updated.
// The task sheet belongs to the Tasks page: a click on a row goes there.

import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { get, ndjson, post, postInit } from "../../api.ts";
import { type Key, lang, t } from "../../i18n.ts";
import { Spark } from "../../lib/claude.tsx";
import { ago, cap, dur, hhmm, modelShort } from "../../lib/format.ts";
import { Markdown } from "../../lib/markdown.tsx";
import { Pf, toast, toastErr } from "../../lib/ui.tsx";
import { go, request } from "../../router.ts";
import { owner, status, summary, useTopic, working } from "../../state.ts";
import type { Day, DayItem, DebriefDone, SessionRow } from "./api.ts";

/* ---------------- status card ---------------- */

function StatusCard() {
  const s = summary.value;
  const level = s?.level ?? "ok";
  // all good needs no card: the rail says it; the card is for something to act on
  if (level === "ok" && !s?.staged) return null;
  const extra = [
    s?.staged ? t("status.staged", { v: s.staged }) : null,
    s?.warns.length ? t("status.warns", { n: s.warns.length }) : null,
  ].filter(Boolean).map((x) => <div class="sub">{x}</div>);
  return (
    <div class={`status-card ${level}`}>
      <i />
      {level === "fail"
        ? (
          <>
            <div>
              <b>{t("status.fail")}</b>
              <ul>{s!.fails.map((f) => <li>{f}</li>)}</ul>
              {extra}
            </div>
            <a class="btn" href="#system/health">{t("status.open")}</a>
          </>
        )
        : (
          <div>
            <b>{t("status.ok")}</b>
            <div class="sub">{t("status.ok.sub")}</div>
            {extra}
          </div>
        )}
    </div>
  );
}

/* ---------------- the day ---------------- */

const notesProgress = (notes?: string | null) => {
  const all = (notes ?? "").match(/^\s*[-*] \[[ xX]\] /gm) ?? [];
  if (!all.length) return null;
  const done = all.filter((s) => /\[[xX]\]/.test(s)).length;
  return { done, total: all.length, pct: Math.round(done / all.length * 100) };
};

const shortDay = (d: string) => new Date(d + "T12:00").toLocaleDateString(lang(), { weekday: "short", day: "numeric" });

function Row({ x, when = x.time ?? "", cls = "", onDone }: {
  x: DayItem;
  when?: string;
  cls?: string;
  onDone: (x: DayItem, b: HTMLButtonElement) => void;
}) {
  const ev = x.source === "calendar";
  const p = ev ? null : notesProgress(x.notes);
  const sub = ev
    ? t("day.calendar", { a: x.calendar ? `${x.calendar} · ${x.project ?? ""}` : x.project ?? "" })
    : [x.project, x.owner && x.owner !== owner.value.id ? x.owner : null].filter(Boolean).join("  ");
  const c = `it${ev ? " event" : ""}${x.priority === 1 ? " hi" : ""}${cls ? ` ${cls}` : ""}`;
  return (
    <div class={c} onClick={ev ? undefined : () => go("tasks")}>
      <span class="tm">{when}</span>
      {ev
        ? <span class="ev"><i style={x.color ? { background: x.color } : undefined} /></span>
        : (
          <button
            type="button"
            class="ck"
            title={t("ts.done")}
            aria-label={t("ts.done")}
            onClick={(e) => {
              e.stopPropagation();
              onDone(x, e.currentTarget);
            }}
          />
        )}
      <span class="tt">
        <span>{x.title}</span>
        {sub && <small>{sub}</small>}
      </span>
      <span class="rt">
        {p
          ? (
            <>
              <span class="tbar" title={`${p.done}/${p.total}`}>
                <i style={{ width: `${p.pct}%` }} />
              </span>
              <small class="tpct">{p.done}/{p.total}</small>
            </>
          )
          : cls === "late"
          ? t("day.late")
          : ""}
      </span>
    </div>
  );
}

function AllDay({ xs }: { xs: DayItem[] }) {
  if (!xs.length) return null;
  return (
    <div class="allday">
      {xs.map((x) => <span><i style={x.color ? { background: x.color } : undefined} />{x.title}</span>)}
    </div>
  );
}

function DayList({ tk, reload }: { tk: Day; reload: () => Promise<void> }) {
  // the line for now moves with the clock
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60000);
    return () => clearInterval(id);
  }, []);
  const now = hhmm();

  const onDone = async (x: DayItem, b: HTMLButtonElement) => {
    b.disabled = true;
    const r = await post<{ ok: boolean; message?: string; task?: { title: string } }>("/api/tasks", {
      op: "update",
      id: x.id,
      status: "done",
    }).catch((err: Error) => ({ ok: false, message: err.message, task: undefined }));
    if (!r.ok) {
      b.disabled = false;
      return toast(r.message ?? "", true);
    }
    toast(t("tasks.done", { t: r.task?.title ?? x.title }));
    await reload().catch(toastErr);
  };
  const row = (x: DayItem, when?: string, cls?: string) => (
    <Row key={x.id + (cls ?? "") + (when ?? "")} x={x} when={when} cls={cls} onDone={onDone} />
  );

  // today: what is late first, then one line of time with a mark for now
  const todayAll = [...(tk.earlier ?? []), ...tk.today];
  const untimedEv = todayAll.filter((x) => x.source === "calendar" && !x.time);
  const timed = todayAll.filter((x) => x.time).sort((a, b) => a.time!.localeCompare(b.time!));
  const loose = todayAll.filter((x) => x.source !== "calendar" && !x.time);
  const out: ComponentChildren[] = [<AllDay xs={untimedEv} />];
  out.push(
    ...tk.overdue.map((x) => row(x, shortDay(x.due!), "late")),
    ...tk.missed.map((x) => row(x, x.time ?? "", "late")),
  );
  let marked = false;
  for (const x of timed) {
    if (!marked && x.time! > now) {
      out.push(<div class="now"><span>{now}</span></div>);
      marked = true;
    }
    out.push(row(x, x.time!, x.time! < now ? "past" : ""));
  }
  if (!marked) out.push(<div class="now"><span>{now}</span></div>);
  out.push(...loose.map((x) => row(x, "")));
  if (!timed.length && !loose.length && !tk.overdue.length && !tk.missed.length && !untimedEv.length) {
    out.push(<div class="pane-empty">{t("day.free")}</div>);
  }

  const later = (key: Key, xs: DayItem[], when: (x: DayItem) => string) =>
    xs.length
      ? [
        <div class="dhead">{t(key)}</div>,
        <AllDay xs={xs.filter((x) => x.source === "calendar" && !x.time)} />,
        ...xs.filter((x) => x.source !== "calendar" || x.time).map((x) => row(x, when(x))),
      ]
      : [];
  out.push(...later("day.tomorrow", tk.tomorrow, (x) => x.time ?? ""));
  if (tk.moment !== "evening") out.push(...later("day.next", tk.upcoming, (x) => (x.due ? shortDay(x.due) : "")));
  out.push(...later("day.waiting", tk.waiting, (x) => (x.due ? shortDay(x.due) : "")));
  return <div class="pane-b">{out}</div>;
}

/* ---------------- the morning debrief ---------------- */
// Written by Claude once a day, at the first look at Today after five in the morning; kept by the server.

let debriefAsked = false;

function Debrief() {
  const [text, setText] = useState("");
  const [writing, setWriting] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const write = async () => {
    debriefAsked = true;
    setWriting(true);
    setText("");
    let acc = "";
    try {
      const res = await fetch("/api/debrief", postInit({}));
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await ndjson<{ t: string; d?: string } & Partial<DebriefDone>>(res, (o) => {
        if (!alive.current) return;
        if (o.t === "text") setText(acc += o.d ?? "");
        else if (o.t === "done") setText(o.error ? "" : o.text ?? acc);
      });
    } catch {
      if (alive.current) setText("");
    }
    if (alive.current) setWriting(false);
  };

  useEffect(() => {
    get<{ debrief?: { text: string } | null }>("/api/debrief").catch(() => null).then((r) => {
      if (!alive.current) return;
      if (r?.debrief) setText(r.debrief.text);
      else if (!debriefAsked && new Date().getHours() >= 5) void write();
    });
  }, []);

  const has = text.trim() !== "";
  if (!writing && !has) return null;
  return (
    <div class="debrief">
      {has && <Markdown src={text} class="" />}
      {writing
        ? (!has && (
          <div class="debrief-f">
            <Spark mode="thinking" />
            <span>{t("debrief.writing")}</span>
          </div>
        ))
        : (
          <div class="debrief-f">
            <span>{t("debrief.by")}</span>
            <button type="button" onClick={() => void write()}>{t("debrief.again")}</button>
          </div>
        )}
    </div>
  );
}

/* ---------------- sessions ---------------- */

/** A row stays "working" for a few seconds after its last write, because a session pauses between
 *  turns and flickering would be worse than a short lag. */
const WORKING_MS = 12000;
const seen = new Map<string, number>();

function useWorking(): (id: string | null, lastActivity: string | null) => boolean {
  const [, tick] = useState(0);
  const w = working.value;
  useEffect(() => {
    for (const id of w.ids) seen.set(id, w.at);
    tick((n) => n + 1);
    const id = setTimeout(() => tick((n) => n + 1), WORKING_MS + 100);
    return () => clearTimeout(id);
  }, [w]);
  return (id, lastActivity) => {
    const at = id ? seen.get(id) : undefined;
    if (at && Date.now() - at < WORKING_MS) return true;
    // on first paint there has been no event yet: fall back to how fresh the transcript is
    return !!lastActivity && Date.now() - new Date(lastActivity).getTime() < WORKING_MS;
  };
}

async function focus(pid: number) {
  const r = await post("/api/focus", { pid }).catch((err: Error) => ({ ok: false, message: err.message }));
  if (!r.ok) toast(r.message ?? t("run.noFocus"), true);
}

function Running() {
  const isWorking = useWorking();
  const s = status.value;
  const cli = s?.running.cli ?? [], desk = s?.running.desktop ?? [];
  // busy first, then the most recent
  const rows = cli.map((c) => ({ c, busy: isWorking(c.session, c.lastActivity) })).sort((a, b) =>
    Number(b.busy) - Number(a.busy) || String(b.c.lastActivity ?? "").localeCompare(String(a.c.lastActivity ?? ""))
  );
  const active = rows.filter((r) => r.busy).length;
  return (
    <section class="pane run-pane">
      <div class="pane-h">
        <h3>{t("today.running")}</h3>
        <span class="pane-r">{active ? t("run.busyN", { n: active }) : ""}</span>
      </div>
      <div class="pane-b">
        {!cli.length && !desk.length
          ? <div class="pane-empty">{t("today.nothing")}</div>
          : (
            <>
              {rows.map(({ c, busy }) => (
                <button type="button" class="ses" title={c.cwd ?? ""} onClick={() => void focus(c.pid)}>
                  <span class="mark">{busy ? <Spark mode="thinking" /> : <i class="idle" />}</span>
                  <span class="nm">{c.cwd ? c.cwd.split("/").filter(Boolean).pop() : "—"}</span>
                  <span class={`when${busy ? " on" : ""}`}>
                    {busy ? t("run.working") : c.lastActivity ? t("run.idle", { d: dur(c.lastActivity) }) : ""}
                  </span>
                  <span class="sub">
                    <Pf name={c.profile ?? "?"} />
                    <span>{t(c.embedded ? "run.desktop" : "run.terminal")}</span>
                    {c.model && <span>{modelShort(c.model)}</span>}
                  </span>
                </button>
              ))}
              {desk.map((d) => (
                <button type="button" class="ses" onClick={() => void focus(d.pid)}>
                  <span class="mark"><i class="idle" /></span>
                  <span class="nm">{t("run.desktopApp")}</span>
                  <span class="when" />
                  <span class="sub">
                    <Pf name={String(d.variant)} />
                    <span>{t("run.window", { n: cli.filter((c) => c.embedded && c.profile === d.variant).length })}</span>
                  </span>
                </button>
              ))}
            </>
          )}
      </div>
    </section>
  );
}

/** The last sessions, one per directory; a click reopens one in a terminal. A busy session writes
 *  every second: the list is re-read at most every 15 s. */
let resumeAt = 0;

function Resume() {
  const [rows, setRows] = useState<SessionRow[]>([]);
  useTopic(async () => {
    if (Date.now() - resumeAt < 15000) return;
    resumeAt = Date.now();
    try {
      const all = await get<SessionRow[]>("/api/sessions?" + new URLSearchParams({ since: "7d", limit: "60" }));
      const dirs = new Set<string>();
      setRows(all.filter((r) => r.cwd && !dirs.has(r.cwd) && dirs.add(r.cwd)).slice(0, 12));
    } catch { /* the panel stays as it was */ }
  }, ["state", "usage"]);
  const open = async (r: SessionRow) => {
    const res = await post("/api/terminal", { cwd: r.cwd, profile: r.profile, resume: r.session_id })
      .catch((err: Error) => ({ ok: false, message: err.message }));
    if (!res.ok) toast(res.message ?? "", true);
  };
  return (
    <section class="pane">
      <div class="pane-h">
        <h3>{t("today.resume")}</h3>
        <span class="pane-r">{t("today.resume.sub")}</span>
      </div>
      <div class="pane-b">
        {!rows.length
          ? <div class="pane-empty">{t("today.noResume")}</div>
          : rows.map((r) => (
            <button type="button" class="ses" title={r.cwd ?? ""} onClick={() => void open(r)}>
              <span class="mark" />
              <span class="nm">{r.project}</span>
              <span class="when">{ago(r.ended)}</span>
              <span class="sub"><Pf name={r.profile} /></span>
            </button>
          ))}
      </div>
    </section>
  );
}

/* ---------------- updates ---------------- */

/** What is pending, in the Updates tab's words; the button starts the wizard. */
function Updates() {
  const s = status.value;
  const pending: string[] = [];
  if (s) {
    const m = s.machine, u = s.update ?? {}, r = s.repo;
    if (u.cli?.latest && u.cli.latest !== m.cliVersion) pending.push(`Claude Code: ${t("up.next", { v: u.cli.latest })}`);
    if (m.desktopStaged) pending.push(`Claude Desktop: ${t("up.staged", { v: m.desktopStaged })}`);
    if (r?.isRepo && r.behind) pending.push(`agents-multi: ${t("up.self.behind", { n: r.behind })}`);
  }
  return (
    <section class="pane">
      <div class="pane-h">
        <h3>{t("sys.updates")}</h3>
        <span class="pane-r">
          <button type="button" class="btn sm" onClick={() => request("update.wizard")}>{t("up.now")}</button>
        </span>
      </div>
      <div class="pane-b sub">{s ? (pending.length ? pending.join(" · ") : t("up.uptodate")) : ""}</div>
    </section>
  );
}

/* ---------------- the page ---------------- */

export function Today() {
  const [tk, setTk] = useState<Day | null>(null);
  const load = async () => {
    setTk(await get<Day>("/api/tasks"));
  };
  useTopic(() => load().catch(() => {}), ["tasks"]);
  return (
    <div class="today">
      <section class="pane day-pane">
        <div class="pane-h">
          <h3>{cap(new Date().toLocaleDateString(lang(), { weekday: "long", day: "numeric", month: "long" }))}</h3>
          <a class="pane-link" href="#tasks">{t("tasks.all")}</a>
        </div>
        <StatusCard />
        <Debrief />
        {tk && <DayList tk={tk} reload={load} />}
      </section>
      <div class="today-side">
        <Running />
        <Resume />
        <Updates />
      </div>
    </div>
  );
}

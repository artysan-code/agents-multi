// day.tsx — the day, Today's main card: «Next», the next appointment with a countdown (an event or a
// task with a time), in one row; the counts, the all-day events, Claude's debrief in one sentence and
// the day's tasks without a time; then the agenda, the hours down the card as a calendar draws them:
// events filled with their calendar's colour, timed tasks outlined (ticked when done), side by side
// when they overlap, the past hatched, a line for now.

import { useEffect, useRef, useState } from "preact/hooks";
import { get, ndjson, postInit } from "../../api.ts";
import { lang, t } from "../../i18n.ts";
import { Spark } from "../../lib/claude.tsx";
import { minute } from "../../lib/clock.ts";
import { cap, hhmm } from "../../lib/format.ts";
import { Markdown } from "../../lib/markdown.tsx";
import { closeDrawer, openDrawer } from "../../lib/ui.tsx";
import { askNow } from "../../shell/ask.tsx";
import { board } from "../tasks/model.ts";
import { openTask } from "../tasks/sheet.tsx";
import type { Day, DayItem, DebriefDone } from "./api.ts";
import { columns, countdown, dayWindow, firstSentence, minutes, upNext } from "./model.ts";

const isEvent = (x: DayItem) => x.source === "calendar";
const nowMin = (d: Date) => d.getHours() * 60 + d.getMinutes();

/** Today's timed items, events and tasks, not done. */
function timed(day: Day): DayItem[] {
  return [...(day.earlier ?? []), ...day.today].filter((x) =>
    x.time && x.status !== "done" && x.status !== "dropped"
  );
}

/** What a click on an item does: an event opens in its calendar, a task opens its sheet. */
function openItem(x: DayItem): void {
  if (isEvent(x)) {
    if (x.link) window.open(x.link, "_blank", "noopener");
  } else void openTask(x.id);
}

const span = (x: DayItem) => (x.end ? `${x.time}–${x.end}` : x.time ?? "");

/* ---------------- next ---------------- */

function Next({ day }: { day: Day }) {
  const now = nowMin(minute.value);
  const [next, then] = upNext(timed(day), now);
  if (!next) {
    const tomorrow = day.tomorrow.filter((x) => x.time).sort((a, b) => a.time!.localeCompare(b.time!))[0];
    return (
      <div class="nx">
        <span class="lbl nx-l">{t("next.label")}</span>
        <b class="nx-free">{t("next.free")}</b>
        {tomorrow && (
          <span class="nx-then">
            {t("next.tomorrow")} <i class="dot2" style={{ "--k": tomorrow.color ?? "var(--accent)" }} />
            <span>{tomorrow.title}</span>
            <time>· {tomorrow.time}</time>
          </span>
        )}
      </div>
    );
  }
  const cd = countdown(now, minutes(next.time)!);
  const ev = isEvent(next);
  return (
    <div class="nx">
      <span class="lbl nx-l">{t("next.label")}</span>
      <span class="nx-cd">
        {t("next.in")} <b>{cd.n}</b>{" "}
        {cd.unit === "min" ? t("next.min") : cd.rest ? t("next.hm", { m: cd.rest }) : t("next.h")}
      </span>
      <span class="nx-what">
        <b title={next.title}>{next.title}</b>
        <span class="nx-meta">
          <i class="dot2" style={{ "--k": ev ? next.color ?? "var(--c-blue)" : "var(--accent)" }} />
          {span(next)} · {ev ? t("next.cal", { c: next.calendar ?? "" }) : next.project ?? t("next.task")}
          {then && <>{" · "}{t("next.then")} {then.title} {then.time}</>}
        </span>
      </span>
      <span class="nx-act">
        <button
          type="button"
          class="bt sm pri"
          onClick={() =>
            askNow(t("next.prep.ask", { t: next.title, h: span(next), c: next.calendar ?? next.project ?? "" }))}
        >
          {t("next.prep")}
        </button>
        {ev
          ? next.link && (
            <a class="bt sm ghost" href={next.link} target="_blank" rel="noopener">
              {t("next.open")}
            </a>
          )
          : (
            <button type="button" class="bt sm ghost" onClick={() => void openTask(next.id)}>
              {t("next.openTask")}
            </button>
          )}
      </span>
    </div>
  );
}

/* ---------------- the debrief, in one sentence ---------------- */
// Written by Claude once a day, at the first look at Today after five in the morning; kept by the server.

let debriefAsked = false;

function DebriefFull({ text, again }: { text: string; again: () => void }) {
  return (
    <div class="deb-full">
      <Markdown src={text} class="" />
      <p>
        <button
          type="button"
          class="bt sm"
          onClick={() => {
            closeDrawer();
            again();
          }}
        >
          {t("debrief.again")}
        </button>
      </p>
    </div>
  );
}

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
      await ndjson<{ t: string; d?: string } & Partial<DebriefDone>>(
        res,
        (o) => {
          if (!alive.current) return;
          if (o.t === "text") setText(acc += o.d ?? "");
          else if (o.t === "done") setText(o.error ? "" : o.text ?? acc);
        },
      );
    } catch {
      if (alive.current) setText("");
    }
    if (alive.current) setWriting(false);
  };

  useEffect(() => {
    get<{ debrief?: { text: string } | null }>("/api/debrief").catch(() => null)
      .then((r) => {
        if (!alive.current) return;
        if (r?.debrief) setText(r.debrief.text);
        else if (!debriefAsked && new Date().getHours() >= 5) void write();
      });
  }, []);

  if (writing && !text.trim()) {
    return (
      <p class="deb">
        <Spark mode="thinking" /> <small>{t("debrief.writing")}</small>
      </p>
    );
  }
  if (!text.trim()) return <p class="deb" />;
  return (
    <button
      type="button"
      class="deb"
      title={t("debrief.open")}
      onClick={() =>
        openDrawer(t("debrief.by"), () => (
          <DebriefFull
            text={text}
            again={() => void write()}
          />
        ))}
    >
      {firstSentence(text)} <small>— {t("debrief.by")}</small>
    </button>
  );
}

/* ---------------- the agenda ---------------- */

interface Mark {
  x: DayItem;
  start: number;
  end: number;
  done: boolean;
}

function marks(day: Day): Mark[] {
  const items = [...(day.earlier ?? []), ...day.today].filter((x) =>
    x.time && x.status !== "dropped"
  );
  const out: Mark[] = items.map((x) => {
    const s = minutes(x.time)!;
    // a task, or an event without its end, takes half an hour
    return {
      x,
      start: s,
      end: Math.max(s + 15, minutes(x.end) ?? s + 30),
      done: x.status === "done",
    };
  });
  // the tasks done today with a time are not in /api/tasks: the board has them
  const b = board.value;
  for (const x of b?.tasks ?? []) {
    if (
      x.status !== "done" || x.done !== day.day || x.due !== day.day || !x.time
    ) continue;
    if (out.some((m) => m.x.id === x.id)) continue;
    const s = minutes(x.time)!;
    out.push({
      x: { id: x.id, title: x.title, time: x.time, status: "done" },
      start: s,
      end: s + 30,
      done: true,
    });
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** Pixels a minute: 48 an hour. */
const PX = 0.8;

function Agenda({ day, next }: { day: Day; next: DayItem | undefined }) {
  const now = nowMin(minute.value);
  const ms = marks(day);
  // the window widens to now too, from the early morning on: the line for now is always there by day
  const { from, to } = dayWindow(now >= 5 * 60 ? [...ms, { start: now, end: now }] : ms);
  const y = (m: number) => (m - from) * PX;
  const cols = columns(ms);
  const hours: number[] = [];
  for (let h = from / 60; h <= to / 60; h++) hours.push(h);
  const inDay = now >= from && now <= to;
  // opened on the hour before now, or on the first item when the day has not begun
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const at = inDay ? now - 60 : ms[0]?.start ?? from;
    el.scrollTop = Math.max(0, y(at));
  }, []);
  return (
    <div class="ag" ref={box}>
      <div class="ag-in" style={{ height: `${y(to) + 8}px` }}>
        {hours.map((h) => (
          <div class="ag-hr" key={h} style={{ top: `${y(h * 60)}px` }}>
            {(!inDay || Math.abs(h * 60 - now) > 12) && <span>{String(h).padStart(2, "0")}:00</span>}
          </div>
        ))}
        {inDay && <div class="ag-past" style={{ height: `${y(now)}px` }} />}
        {ms.map((m, i) => {
          const ev = isEvent(m.x);
          const { col, cols: n } = cols[i];
          const h = Math.max((m.end - m.start) * PX - 2, 20);
          const cls = [
            "ag-ev",
            ev ? "" : "task",
            ev ? "" : m.done ? "done" : "todo",
            m.end <= now ? "past" : "",
            next && m.x.id === next.id ? "nx-on" : "",
            h < 34 ? "short" : "",
          ].filter(Boolean).join(" ");
          return (
            <button
              type="button"
              key={m.x.id}
              class={cls}
              style={{
                top: `${y(m.start) + 1}px`,
                height: `${h}px`,
                left: `calc(var(--gut) + (100% - var(--gut)) * ${col / n})`,
                width: `calc((100% - var(--gut)) / ${n} - 4px)`,
                ...(ev ? { "--k": m.x.color ?? "var(--c-blue)" } : {}),
              }}
              title={`${span(m.x)} ${m.x.title}`}
              onClick={() => openItem(m.x)}
            >
              {/* placed, not laid out: WebKitGTK centres what a button holds */}
              <span class="in">
                {!ev && (
                  <svg viewBox="0 0 14 14">
                    {m.done ? <path d="M3 7.5l2.6 2.5L11 4.5" /> : <circle cx="7" cy="7" r="4.5" />}
                  </svg>
                )}
                <span class="t">{m.x.title}</span>
                <time>{span(m.x) || m.x.time}</time>
              </span>
            </button>
          );
        })}
        {inDay && (
          <div class="ag-now" style={{ top: `${y(now)}px` }}>
            <span>{hhmm(minute.value)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function DayCard({ day }: { day: Day | null }) {
  const now = nowMin(minute.value);
  const date = cap(
    minute.value.toLocaleDateString(lang(), {
      weekday: "long",
      day: "numeric",
      month: "long",
    }),
  );
  if (!day) {
    return (
      <article class="card dc">
        <div class="dc-h">
          <h2>{date}</h2>
        </div>
      </article>
    );
  }
  const all = [...(day.earlier ?? []), ...day.today];
  const allDay = all.filter((x) => isEvent(x) && !x.time);
  const coming = timed(day).filter((x) => minutes(x.time)! > now).length;
  const looseItems = day.today.filter((x) => !isEvent(x) && !x.time);
  const loose = looseItems.length;
  const counts = [
    day.doneToday ? t("day.doneN", { n: day.doneToday }) : "",
    t("day.comingN", { n: coming }),
    loose ? t("day.looseN", { n: loose }) : "",
  ].filter(Boolean).join(" · ");
  return (
    <article class="card dc">
      <div class="dc-h">
        <h2>{date}</h2>
        <span class="dc-cnt">{counts}</span>
        <span class="hd-sp" />
        {allDay.slice(0, 2).map((x) => (
          <span class="dc-chip" key={x.id} title={x.calendar ?? ""}>
            <i class="dot2" style={{ "--k": x.color ?? "var(--c-rose)" }} />
            {t("day.allDay")} · {x.title}
          </span>
        ))}
        {allDay.length > 2 && <span class="dc-chip">+{allDay.length - 2}</span>}
      </div>
      <Next day={day} />
      <Debrief />
      {looseItems.some((x) => x.status !== "done") && (
        <div class="dc-loose" aria-label={t("day.loose")}>
          <span class="lbl">{t("day.loose")}</span>
          {looseItems.filter((x) => x.status !== "done").map((x) => (
            <button type="button" class="dc-lt" key={x.id} title={x.title} onClick={() => openItem(x)}>
              {x.title}
            </button>
          ))}
        </div>
      )}
      <Agenda day={day} next={upNext(timed(day), now)[0]} />
    </article>
  );
}

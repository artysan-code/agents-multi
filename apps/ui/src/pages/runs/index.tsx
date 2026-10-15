// runs/index.tsx — Runs: what is working for the owner right now. The Claude Code sessions running, with
// how much of their context they use and whether they are working (a click brings the window forward);
// the agents the hub started (ADR 0005), with what they were asked, what they said last and whether they
// wait for an answer; the workflow runs with their steps; and «Pick up again», the last sessions, one
// per folder. Read only: an agent or a run is acted on by its coordinator, or with `agents run`.

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Result } from "../../api.ts";
import { t, tk } from "../../i18n.ts";
import { Spark } from "../../lib/claude.tsx";
import { ago, cap, dur, modelShort, shortHome } from "../../lib/format.ts";
import { useThrottled } from "../../lib/throttle.ts";
import { pcolor, toast } from "../../lib/ui.tsx";
import { status, useTopic, working } from "../../state.ts";
import type { LiveView } from "../limits/api.ts";
import {
  type AgentRow,
  focusWindow,
  loadLive,
  loadRuns,
  loadSessions,
  resumeSession,
  type RunRow,
  type SessionRow,
} from "./api.ts";
import "./runs.css";

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

async function say(p: Promise<Result>, fallback = ""): Promise<void> {
  const r = await p.catch((e: Error): Result => ({ ok: false, message: e.message }));
  if (!r.ok) toast(r.message || fallback, true);
}

const folder = (p: string | null | undefined) => (p ? p.split("/").filter(Boolean).pop() ?? "~" : "—");
const level = (pct: number) => (pct >= 80 ? "crit" : pct >= 50 ? "warn" : "ok");

function Section({ title, sub, children }: { title: string; sub?: string; children: ComponentChildren }) {
  return (
    <section class="rn-sec">
      <h2 class="rn-h">
        {title}
        {sub && <small>{sub}</small>}
      </h2>
      {children}
    </section>
  );
}

/* ---------------- sessions ---------------- */

function Sessions() {
  const isWorking = useWorking();
  const s = status.value;
  const cli = s?.running.cli ?? [];
  const [view, setView] = useState<LiveView | null>(null);
  // the status line writes at every turn: read again at most every 15 s, the last change included
  const load = useThrottled(async () => {
    const v = await loadLive().catch(() => null);
    if (v) setView(v);
  }, 15000);
  useTopic(load, ["state", "usage"]);
  // busy first, then the most recent
  const rows = cli.map((c) => ({ c, busy: isWorking(c.session, c.lastActivity) })).sort((a, b) =>
    Number(b.busy) - Number(a.busy) || String(b.c.lastActivity ?? "").localeCompare(String(a.c.lastActivity ?? ""))
  );
  const active = rows.filter((r) => r.busy).length;
  return (
    <Section title={t("rn.sessions")} sub={active ? t("run.busyN", { n: active }) : undefined}>
      <div class="card rn-list">
        {s && !rows.length && <div class="rn-none">{t("rn.nothing")}</div>}
        {rows.map(({ c, busy }) => {
          const ctx = c.session ? view?.sessions[c.session]?.context : null;
          return (
            <button
              type="button"
              class="ss"
              key={c.pid}
              title={c.cwd ?? ""}
              style={{ "--k": pcolor(c.profile) }}
              onClick={() => void say(focusWindow(c.pid), t("run.noFocus"))}
            >
              <span class="m">{busy ? <Spark mode="thinking" /> : <i />}</span>
              <span class="nm">
                {folder(c.cwd)}{" "}
                <small>
                  <i class="dot2" />
                  {[c.profile, c.model ? cap(modelShort(c.model)) : ""].filter(Boolean).join(" · ")}
                </small>
              </span>
              {ctx?.used != null && (
                <span class={`ctx ${level(ctx.used)}`} title={t("now.ctx")}>
                  <span class="lim-bar">
                    <i style={{ width: `${Math.min(100, ctx.used)}%` }} />
                  </span>
                  {Math.round(ctx.used)}%
                </span>
              )}
              <span class={`w${busy ? " on" : ""}`}>
                {busy ? t("run.working") : c.lastActivity ? t("run.idle", { d: dur(c.lastActivity) }) : ""}
              </span>
            </button>
          );
        })}
      </div>
    </Section>
  );
}

/* ---------------- the hub ---------------- */

function Agent({ a }: { a: AgentRow }) {
  const tone = a.error ? "crit" : a.pending ? "warn" : a.phase === "working" ? "on" : "";
  return (
    <div class={`ag2 ${tone}`} style={{ "--k": pcolor(a.profile) }} title={a.dir}>
      <span class="ag2-m">{a.phase === "working" ? <Spark mode="thinking" /> : <i />}</span>
      <div class="ag2-b">
        <div class="ag2-t">
          <b>{a.project ? folder(a.project) : shortHome(a.dir)}</b>
          <small>
            <i class="dot2" />
            {[a.profile, a.provider !== "claude" ? cap(a.provider) : "", a.run ? `${a.run.id} › ${a.run.step}` : ""]
              .filter(Boolean).join(" · ")}
          </small>
        </div>
        <div class="ag2-task">{a.task}</div>
        {a.error ? <div class="ag2-said err">{a.error}</div> : a.said && <div class="ag2-said">{a.said}</div>}
      </div>
      <div class="ag2-r">
        <span class={`ph ${tone}`}>{a.pending ? t("rn.asks", { n: a.pending }) : tk(`rn.ph.${a.phase}`)}</span>
        <small>{t("rn.turns", { n: a.turns })} · {ago(a.started)}</small>
      </div>
    </div>
  );
}

function Run({ r }: { r: RunRow }) {
  return (
    <div class="rr">
      <div class="rr-h">
        <b>{r.name}</b>
        <small>{[r.id, r.project ? folder(r.project) : "", r.started ? ago(r.started) : ""].filter(Boolean).join(" · ")}</small>
        <span class="hd-sp" />
        {r.status === "running" && !r.alive && <span class="ph warn">{t("rn.noRunner")}</span>}
        <span class={`ph ${r.status === "running" ? "on" : ""}`}>{tk(`rn.st.${r.status}`)}</span>
      </div>
      <div class="rr-steps">
        {r.steps.map((s) => (
          <span key={s.id} class={`st2 ${s.status}`} title={s.error ?? `${s.profile} · ${tk(`rn.step.${s.status}`)}`}>
            {s.id}
          </span>
        ))}
      </div>
    </div>
  );
}

function Hub() {
  const [data, setData] = useState<{ runs: RunRow[]; agents: AgentRow[] } | null>(null);
  // a working agent writes every second: read again at most every 3 s, the last change included
  const load = useThrottled(async () => {
    const d = await loadRuns().catch(() => null);
    if (d) setData(d);
  }, 3000);
  useTopic(load, ["agents"]);
  return (
    <>
      <Section title={t("rn.agents")} sub={t("rn.agents.sub")}>
        <div class="card rn-list">
          {data && !data.agents.length && <div class="rn-none">{t("rn.noAgents")}</div>}
          {data?.agents.map((a) => <Agent key={a.id} a={a} />)}
        </div>
      </Section>
      {!!data?.runs.length && (
        <Section title={t("rn.runs")} sub={t("rn.runs.sub")}>
          <div class="card rn-list">{data.runs.map((r) => <Run key={r.id} r={r} />)}</div>
        </Section>
      )}
    </>
  );
}

/* ---------------- pick up again ---------------- */

function Resume() {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [all, setAll] = useState(false);
  // a busy session writes every second: the list is re-read at most every 15 s, the last change included
  const load = useThrottled(async () => {
    try {
      const list = await loadSessions();
      const dirs = new Set<string>();
      setRows(list.filter((r) => r.cwd && !dirs.has(r.cwd) && dirs.add(r.cwd)).slice(0, 30));
    } catch { /* the list stays as it was */ }
  }, 15000);
  useTopic(load, ["state", "usage"]);
  const shown = all ? rows : rows.slice(0, 8);
  return (
    <Section title={t("rn.resume")} sub={t("rn.resume.sub")}>
      <div class="card rn-list">
        {!rows.length && <div class="rn-none">{t("rn.noResume")}</div>}
        {shown.map((r) => (
          <button
            type="button"
            class="rc-r"
            key={r.session_id}
            title={r.cwd ?? ""}
            style={{ "--k": pcolor(r.profile) }}
            onClick={() => void say(resumeSession(r))}
          >
            <i class="dot2" />
            <span class="nm">{r.project}</span>
            <small>{r.profile} · {ago(r.ended)}</small>
            <span class="go">↵</span>
          </button>
        ))}
        {rows.length > shown.length && (
          <button type="button" class="lnk rn-more" onClick={() => setAll(true)}>
            {t("rn.resume.all")} ({rows.length})
          </button>
        )}
      </div>
    </Section>
  );
}

export function Runs() {
  return (
    <>
      <h1 class="pg-h">{t("nav.runs")}</h1>
      <div class="rn">
        <div class="rn-col">
          <Sessions />
          <Hub />
        </div>
        <div class="rn-col">
          <Resume />
        </div>
      </div>
    </>
  );
}

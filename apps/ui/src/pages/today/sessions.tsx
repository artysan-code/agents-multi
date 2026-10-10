// sessions.tsx — «Claude now»: one row per profile with its usage limits (the five hours and the week,
// with when they start again) and today's tokens, and its Desktop (a click opens it or brings it
// forward); the Claude Code sessions running, with how much of their context they use and whether they
// are working; and «Pick up again»: the last sessions, one per folder, in the room left — whole rows
// only. The limits and the context come from the status line (apps/cli/live.ts); «refresh» asks
// Anthropic for the limits now.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Result } from "../../api.ts";
import { lang, t } from "../../i18n.ts";
import { Spark } from "../../lib/claude.tsx";
import { ago, cap, dur, modelShort } from "../../lib/format.ts";
import { openDrawer, pcolor, toast } from "../../lib/ui.tsx";
import { useThrottled } from "../../lib/throttle.ts";
import { status, useTopic, working } from "../../state.ts";
import { focusWindow, type Limit, type LiveView, loadLive, loadSessions, openDesktop, refreshLive, resumeSession, type SessionRow } from "./api.ts";

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

const folder = (p: string | null) => (p ? p.split("/").filter(Boolean).pop() ?? "~" : "—");
const ROW = 30; // a resume row's height: whole rows only

function Resume() {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [fit, setFit] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  // a busy session writes every second: the list is re-read at most every 15 s, the last change included
  const load = useThrottled(async () => {
    try {
      const all = await loadSessions();
      const dirs = new Set<string>();
      setRows(all.filter((r) => r.cwd && !dirs.has(r.cwd) && dirs.add(r.cwd)).slice(0, 20));
    } catch { /* the list stays as it was */ }
  }, 15000);
  useTopic(load, ["state", "usage"]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setFit(Math.floor(el.clientHeight / ROW)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const resume = (r: SessionRow) => void say(resumeSession(r));
  const row = (r: SessionRow) => (
    <button type="button" class="rc-r" key={r.session_id} title={r.cwd ?? ""} style={{ "--k": pcolor(r.profile) }} onClick={() => resume(r)}>
      <i class="dot2" />
      <span class="nm">{r.project}</span>
      <small>{r.profile} · {ago(r.ended)}</small>
      <span class="go">↵</span>
    </button>
  );
  return (
    <div class={`rs${rows.length && fit < 1 ? " gone" : ""}`}>
      <div class="sc-h">
        <span class="lbl">{t("today.resume")}</span>
        <span class="r">
          {t("today.resume.sub")}
          {rows.length > fit && (
            <>
              {" · "}
              <button type="button" class="lnk" onClick={() => openDrawer(t("today.resume"), () => <div class="rc rc-all">{rows.map(row)}</div>)}>
                {t("today.resume.all")}
              </button>
            </>
          )}
        </span>
      </div>
      <div class="rc" ref={box}>
        {rows.length ? rows.slice(0, fit).map(row) : <div class="rc-none">{t("today.noResume")}</div>}
      </div>
    </div>
  );
}

/** Tokens as a person reads them: 950, 12k, 3.4M. */
const tokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

/** When a window starts again: the hour today, else the day and the hour. */
function resetsAt(sec: number | null): string {
  if (!sec) return "";
  const d = new Date(sec * 1000), now = new Date();
  const hm = d.toLocaleTimeString(lang(), { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString(lang(), { weekday: "short" })} ${hm}`;
}

const level = (pct: number) => (pct >= 80 ? "crit" : pct >= 50 ? "warn" : "ok");

function LimitBar({ label, l }: { label: string; l?: Limit }) {
  if (!l) return null;
  const pct = Math.max(0, Math.min(100, l.used));
  return (
    <div class={`lim ${level(l.used)}`}>
      <span class="lim-l">{label}</span>
      <span class="lim-bar">
        <i style={{ width: `${pct}%` }} />
      </span>
      <b>{Math.round(l.used)}%</b>
      <small>{l.resets ? t("now.resets", { w: resetsAt(l.resets) }) : ""}</small>
    </div>
  );
}

const DESK = (
  <svg viewBox="0 0 16 16">
    <rect x="2" y="3" width="12" height="9" rx="1.5" />
    <path d="M6 14h4" />
  </svg>
);

export function SessionsCard() {
  const isWorking = useWorking();
  const s = status.value;
  const profiles = Object.keys(s?.profiles ?? {});
  const cli = s?.running.cli ?? [];
  const open = new Set(s?.running.desktop.map((d) => d.variant) ?? []);
  const [view, setView] = useState<LiveView | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // the status line writes at every turn: read again at most every 15 s, the last change included
  const load = useThrottled(async () => {
    const v = await loadLive().catch(() => null);
    if (v) setView(v);
  }, 15000);
  useTopic(load, ["state", "usage"]);
  const refresh = async () => {
    setRefreshing(true);
    const v = await refreshLive().catch((e: Error) => {
      toast(e.message, true);
      return null;
    });
    setRefreshing(false);
    if (!v) return;
    setView(v);
    const errs = Object.entries(v.errors ?? {});
    if (errs.length) toast(errs.map(([p, e]) => `${p}: ${e}`).join(" · "), true);
  };
  // busy first, then the most recent
  const rows = cli.map((c) => ({ c, busy: isWorking(c.session, c.lastActivity) })).sort((a, b) =>
    Number(b.busy) - Number(a.busy) || String(b.c.lastActivity ?? "").localeCompare(String(a.c.lastActivity ?? ""))
  );
  const active = rows.filter((r) => r.busy).length;
  return (
    <article class="card ac">
      <div class="sc-h">
        <span class="lbl">{t("now.title")}</span>
        {active > 0 && <span class="r on">{t("run.busyN", { n: active })}</span>}
        <button
          type="button"
          class={`now-rf${refreshing ? " on" : ""}`}
          title={t("now.refresh")}
          aria-label={t("now.refresh")}
          onClick={() => void refresh()}
        >
          <svg viewBox="0 0 16 16">
            <path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3" />
          </svg>
        </button>
      </div>
      <div class="cus">
        {profiles.map((p) => {
          const v = view?.profiles[p];
          const on = open.has(p);
          return (
            <div class="cu" key={p} style={{ "--k": pcolor(p) }}>
              <div class="cu-h">
                <i class="dot2" />
                <b>{p}</b>
                {!!v?.tokens && <span class="cu-tok">{t("now.tokens", { n: tokens(v.tokens) })}</span>}
                <span class="hd-sp" />
                {v?.at && <small class="cu-at">{ago(new Date(v.at * 1000).toISOString())}</small>}
                <button
                  type="button"
                  class={`cu-dk${on ? " on" : ""}`}
                  title={t(on ? "run.focus" : "run.open")}
                  aria-label={t(on ? "run.focus" : "run.open")}
                  onClick={() => void say(openDesktop(p))}
                >
                  {DESK}
                </button>
              </div>
              {v?.limits
                ? (
                  <>
                    <LimitBar label={t("now.5h")} l={v.limits.five_hour} />
                    <LimitBar label={t("now.7d")} l={v.limits.seven_day} />
                  </>
                )
                : <small class="cu-none">{t("now.noLimits")}</small>}
            </div>
          );
        })}
      </div>
      <div class="sess">
        {s && !rows.length && <div class="rc-none">{t("today.nothing")}</div>}
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
              {ctx?.used != null
                ? (
                  <span class={`ctx ${level(ctx.used)}`} title={t("now.ctx")}>
                    <span class="lim-bar">
                      <i style={{ width: `${Math.min(100, ctx.used)}%` }} />
                    </span>
                    {Math.round(ctx.used)}%
                  </span>
                )
                : (
                  <span class={`w${busy ? " on" : ""}`}>
                    {busy ? t("run.working") : c.lastActivity ? t("run.idle", { d: dur(c.lastActivity) }) : ""}
                  </span>
                )}
            </button>
          );
        })}
      </div>
      <Resume />
    </article>
  );
}

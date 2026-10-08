// sessions.tsx — «Active now»: one tile per profile (its Desktop open or closed; a click opens it or
// brings it forward), the Claude Code sessions running with their profile, model and whether they are
// working, and «Pick up again»: the last sessions, one per folder, in the room left — whole rows only.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { get, post, type Result } from "../../api.ts";
import { t } from "../../i18n.ts";
import { Spark } from "../../lib/claude.tsx";
import { ago, cap, dur, modelShort } from "../../lib/format.ts";
import { openDrawer, pcolor, toast } from "../../lib/ui.tsx";
import { status, useTopic, working } from "../../state.ts";
import type { SessionRow } from "./api.ts";

/** A row stays "working" for a few seconds after its last write, because a session pauses between
 *  turns and flickering would be worse than a short lag. */
const WORKING_MS = 12000;
const seen = new Map<string, number>();

function useWorking(): (
  id: string | null,
  lastActivity: string | null,
) => boolean {
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
    return !!lastActivity &&
      Date.now() - new Date(lastActivity).getTime() < WORKING_MS;
  };
}

async function say(p: Promise<Result>, fallback = ""): Promise<void> {
  const r = await p.catch((e: Error): Result => ({
    ok: false,
    message: e.message,
  }));
  if (!r.ok) toast(r.message || fallback, true);
}

const folder = (
  p: string | null,
) => (p ? p.split("/").filter(Boolean).pop() ?? "~" : "—");
const ROW = 30; // a resume row's height: whole rows only

function Resume() {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [fit, setFit] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const at = useRef(0);

  // a busy session writes every second: the list is re-read at most every 15 s
  useTopic(async () => {
    if (Date.now() - at.current < 15000) return;
    at.current = Date.now();
    try {
      const all = await get<SessionRow[]>(
        "/api/sessions?" + new URLSearchParams({ since: "7d", limit: "60" }),
      );
      const dirs = new Set<string>();
      setRows(
        all.filter((r) => r.cwd && !dirs.has(r.cwd) && dirs.add(r.cwd)).slice(
          0,
          20,
        ),
      );
    } catch { /* the list stays as it was */ }
  }, ["state", "usage"]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setFit(Math.floor(el.clientHeight / ROW))
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const resume = (r: SessionRow) =>
    void say(
      post("/api/terminal", {
        cwd: r.cwd,
        profile: r.profile,
        resume: r.session_id,
      }),
    );
  const row = (r: SessionRow) => (
    <button
      type="button"
      class="rc-r"
      key={r.session_id}
      title={r.cwd ?? ""}
      style={{ "--k": pcolor(r.profile) }}
      onClick={() => resume(r)}
    >
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
              <button
                type="button"
                class="lnk"
                onClick={() =>
                  openDrawer(
                    t("today.resume"),
                    () => <div class="rc rc-all">{rows.map(row)}</div>,
                  )}
              >
                {t("today.resume.all")}
              </button>
            </>
          )}
        </span>
      </div>
      <div class="rc" ref={box}>
        {rows.length
          ? rows.slice(0, fit).map(row)
          : <div class="rc-none">{t("today.noResume")}</div>}
      </div>
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
  // busy first, then the most recent
  const rows = cli.map((c) => ({
    c,
    busy: isWorking(c.session, c.lastActivity),
  })).sort((a, b) =>
    Number(b.busy) - Number(a.busy) ||
    String(b.c.lastActivity ?? "").localeCompare(String(a.c.lastActivity ?? ""))
  );
  const active = rows.filter((r) => r.busy).length;
  return (
    <article class="card ac">
      <div class="sc-h">
        <span class="lbl">{t("today.running")}</span>
        {active > 0 && <span class="r on">{t("run.busyN", { n: active })}
        </span>}
      </div>
      {profiles.length > 0 && (
        <div class="pfs">
          {profiles.map((p) => {
            const on = open.has(p);
            return (
              <button
                type="button"
                key={p}
                class={`pft${on ? " on" : ""}`}
                style={{ "--k": pcolor(p) }}
                title={t(on ? "run.focus" : "run.open")}
                onClick={() => void say(post("/api/launch", { profile: p }))}
              >
                <span>
                  <i class="dot2" />
                  {p}
                </span>
                <span class="dk">
                  {DESK}
                  {t(on ? "run.deskOn" : "run.deskOff")}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div class="sess">
        {s && !rows.length && <div class="rc-none">{t("today.nothing")}</div>}
        {rows.map(({ c, busy }) => (
          <button
            type="button"
            class="ss"
            key={c.pid}
            title={c.cwd ?? ""}
            style={{ "--k": pcolor(c.profile) }}
            onClick={() =>
              void say(post("/api/focus", { pid: c.pid }), t("run.noFocus"))}
          >
            <span class="m">{busy ? <Spark mode="thinking" /> : <i />}</span>
            <span class="nm">
              {folder(c.cwd)}{" "}
              <small>
                <i class="dot2" />
                {[
                  c.profile,
                  t(c.embedded ? "run.desktop" : "run.terminal"),
                  c.model ? cap(modelShort(c.model)) : "",
                ].filter(Boolean).join(" · ")}
              </small>
            </span>
            <span class={`w${busy ? " on" : ""}`}>
              {busy
                ? t("run.working")
                : c.lastActivity
                ? t("run.idle", { d: dur(c.lastActivity) })
                : ""}
            </span>
          </button>
        ))}
      </div>
      <Resume />
    </article>
  );
}

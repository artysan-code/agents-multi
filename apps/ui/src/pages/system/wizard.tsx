// wizard.tsx — the update screen: «Update now» from anywhere (the "update.wizard" intent) covers the
// whole window and updates everything in one flow, a step at a time with its progress: check what is
// out (the console's check and the desktop app's), update Claude Code, Claude Desktop and the
// agents-multi checkout (the console's update job), download and install the desktop app's new
// version (shell/app-update.ts), close Claude when the install waits for it (updates-close.tsx, drawn in
// the screen), restart, verify, and say «Updated to X.Y.Z» with what is new.
//
// The restart takes the page with it (the console, or the whole app, comes back on new code), so the
// run is kept in localStorage — the app's relaunch is a new window, which sessionStorage would not
// survive — and the screen opens again where it was. An update the timer made on its own is told by a
// notice on the next visit (the version last seen is in localStorage).

import { useEffect, useRef, useState } from "preact/hooks";
import { api, type Plan } from "../../api.ts";
import { loadStatus, reloadSoftly, status, useTopic } from "../../state.ts";
import { type Key, t, tk } from "../../i18n.ts";
import { intent, useIntent } from "../../router.ts";
import { openDrawer, runJob } from "../../lib/ui.tsx";
import {
  appUpdate,
  appUpdateAction,
  appUpdater,
  loadAppUpdate,
  notePoints,
} from "../../shell/app-update.ts";
import {
  cmpVer,
  COMPONENTS,
  fetchNews,
  keep,
  kept,
  News,
  pendingUpdates,
  type Report,
  type Whatsnew,
} from "./updates-lib.tsx";
import { CloseClaude, reopenProfile, runSettle } from "./updates-close.tsx";
import {
  RunMark,
  runShare,
  StepRows,
  type StepState,
} from "../../lib/steps.tsx";
import "../../lib/screen.css";

const UW_KEY = "cm.upwiz", SEEN_KEY = "cm.seenVersion";
const STEPS = [
  "check",
  "update",
  "download",
  "close",
  "restart",
  "verify",
] as const;
type Step = typeof STEPS[number];

/** What the run keeps across the restart. */
interface Run {
  /** agents-multi's version before, for «what is new» */
  from: string | null;
  /** the console's code before: another code after the restart means it came back new */
  code: string;
  /** agents-multi itself moves (the checkout is behind, or the app has a new version) */
  self: boolean;
  /** the desktop app's new version, when it has one, and its notes */
  app: { version: string; notes: string } | null;
  at: string;
  state: Record<Step, StepState>;
  pending: string[];
}

const fresh = (): Run => {
  const S = status.value as Report | null;
  return {
    from: appUpdater()?.current ?? S?.repo.version ?? null,
    code: "",
    self: false,
    app: null,
    at: new Date().toISOString(),
    state: {
      check: "todo",
      update: "todo",
      download: "todo",
      close: "todo",
      restart: "todo",
      verify: "todo",
    },
    pending: [],
  };
};

/** The run after the app's relaunch from an update: the one kept here when there is one, else one made
 *  from the app's note (an update started from the tray, or the run's storage gone). */
function relaunched(u: { from: string; to: string }): Run {
  const kept_ = kept<Run>(localStorage, UW_KEY);
  const base = kept_ ??
    {
      ...fresh(),
      from: u.from,
      self: true,
      app: { version: u.to, notes: "" },
      pending: [`Agents Multi ${u.from} → ${u.to}`],
    };
  return {
    ...base,
    state: {
      ...base.state,
      check: "done",
      download: "done",
      restart: "done",
      update: base.state.update === "todo" ? "skipped" : base.state.update,
    },
  };
}

/** The console answers again, with other code than `old`: the restart is over. */
async function consoleBack(old: string, timeoutMs = 120000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await api.code().catch(() => null);
    if (r?.code && r.code !== old) return true;
    await new Promise((res) => setTimeout(res, 2000));
  }
  return false;
}

/** Resolves when the app's update leaves `states` (it moves on the "app-update" topic), or after `ms`. */
function appLeaves(states: string[], ms: number): Promise<void> {
  return new Promise((res) => {
    const end = Date.now() + ms;
    const tick = () => {
      const s = appUpdate.value?.state;
      if (!s || !states.includes(s) || Date.now() > end) return res();
      setTimeout(tick, 500);
    };
    tick();
  });
}

const lastLine = (out: string) => out.trim().split("\n").filter(Boolean).pop();
/** A job's error in words: "lost" is a stream that ended without its result. */
const why = (e: string) => (e === "lost" ? t("rep.lost") : e);

interface Health {
  n: number;
  fails: number;
  msg: string;
}

/** The install left waiting for every Claude to be closed (status.selfInstall), as of now. */
const installWaits = () =>
  loadStatus(true).then(
    () => !!(status.value as Report | null)?.selfInstall,
    () => false,
  );

function Screen(
  { resume, auto, settle, close }: {
    resume: Run | null;
    auto: boolean;
    /** only the install is left: straight to closing Claude */
    settle: boolean;
    close: () => void;
  },
) {
  const [, force] = useState(0);
  const draw = () => force((n) => n + 1);
  const run = useRef<Run>(resume ?? fresh()).current;
  const v = useRef({
    out: "",
    cause: "",
    running: false,
    jobId: null as string | null,
    news: null as Whatsnew | null,
    health: null as Health | null,
    showOut: false,
    /** the close step on screen: who holds the install, and how the step ends */
    closing: null as { plan: Plan; end: (installed: boolean) => void } | null,
    later: false,
    /** the profiles whose Claude the close step closed, to open again at the end */
    reopen: [] as string[],
    reopened: [] as string[],
  }).current;
  const outEl = useRef<HTMLPreElement>(null);
  const S = status.value as Report | null;
  const app = appUpdater();

  const set = (step: Step, st: StepState) => {
    run.state[step] = st;
    keep(localStorage, UW_KEY, run);
    draw();
  };
  const fail = (step: Step, why: string) => {
    v.cause = why;
    set(step, "failed");
  };
  const logSince = () =>
    (status.value?.updateLog ?? []).filter((e) =>
      e.at >= run.at.replace(/\.\d+Z$/, "Z")
    );

  useEffect(() => {
    if (outEl.current) outEl.current.scrollTop = outEl.current.scrollHeight;
  });

  const job = async (action: string) => {
    v.running = true;
    v.out = "";
    draw();
    const r = await runJob(action, {}, (o) => {
      v.out += o;
      draw();
    }, (j) => v.jobId = j).catch((e: Error) => ({ error: e.message }));
    v.jobId = null;
    v.running = false;
    return r;
  };

  /** The install that waits for Claude, in the screen: the sessions that hold it, closed when the person
   *  says so, then the install; or left for later. False when it failed. */
  const closeStep = async (): Promise<boolean> => {
    set("close", "running");
    let plan: Plan;
    try {
      plan = await api.closePlan();
    } catch (e) {
      fail("close", (e as Error).message);
      return false;
    }
    // closed by hand meanwhile: nothing to ask, the install runs now
    if (!plan.offer) {
      const r = plan.pending ? await runSettle() : { code: 0 };
      if (r.code) {
        fail("close", t("uw.exit", { c: r.code }));
        return false;
      }
      set("close", "done");
      return true;
    }
    const installed = await new Promise<boolean>((end) => {
      v.closing = { plan, end };
      draw();
    });
    v.later = !installed;
    set("close", installed ? "done" : "skipped");
    return true;
  };

  /** After the update: the restart when agents-multi moved, closing Claude when the install waits for
   *  it, the doctor, and what is new. */
  const finish = async () => {
    if (run.state.restart !== "done") {
      // an install still waiting for every Claude to be closed restarts nothing: the close step
      // follows instead of a restart that does not come
      const waiting = run.self && !run.app && await installWaits() &&
        !status.value?.repo.behind;
      if (!run.self || waiting) set("restart", "skipped");
      else {
        set("restart", "running");
        const back = await consoleBack(run.code);
        if (!back) return fail("restart", t("uw.noRestart"));
        set("restart", "done");
        // this page runs the old code: the new one, reloaded, carries on from the kept run
        if (!resume) return reloadSoftly();
      }
    }
    if (
      run.state.close !== "done" && run.state.close !== "skipped" &&
      await installWaits()
    ) {
      if (!(await closeStep())) return;
    } else if (run.state.close === "todo") set("close", "skipped");
    set("verify", "running");
    await loadStatus(true).catch(() => null);
    await loadAppUpdate();
    const doctor = status.value?.doctor ?? [];
    const fails = doctor.filter((c) => c.status === "fail");
    v.health = {
      n: doctor.length,
      fails: fails.length,
      msg: fails[0]?.msg ?? "",
    };
    const bad = logSince().find((e) =>
      e.event === "failed" || e.event === "verify-failed"
    );
    if (bad && !v.cause) {
      v.cause = `${COMPONENTS[bad.component] ?? bad.component}: ${
        bad.detail || tk("up.ev.failed")
      }`;
    }
    v.news = await fetchNews(run.from);
    const now = appUpdate.value?.current ?? v.news?.version ??
      status.value?.repo.version;
    if (now) keep(localStorage, SEEN_KEY, now);
    set("verify", fails.length || bad ? "failed" : "done");
  };

  const start = async () => {
    v.cause = "";
    run.code =
      (await api.code().catch(() => ({ code: "" })))
        .code ?? "";
    set("check", "running");
    // the console's check, and the app's when there is an app to update
    const [r] = await Promise.all([
      job("update-check"),
      appUpdater()
        ? appUpdateAction("check").then(() => appLeaves(["checking"], 60000))
        : Promise.resolve(),
    ]);
    if ("error" in r || r.code) {
      return fail(
        "check",
        "error" in r
          ? why(r.error)
          : lastLine(v.out) ?? t("uw.exit", { c: r.code }),
      );
    }
    await loadStatus().catch(() => null);
    const a = appUpdater()?.available;
    run.app = a ? { version: a.version, notes: a.notes } : null;
    const ours = pendingUpdates(status.value as Report | null);
    run.pending = [
      ...(a
        ? [`Agents Multi ${appUpdate.value?.current ?? "—"} → ${a.version}`]
        : []),
      ...ours,
    ];
    run.self = !!(status.value?.repo.behind ||
      (status.value as Report | null)?.selfInstall || a);
    v.out = "";
    set("check", "done");
    if (!run.pending.length) {
      set("update", "skipped");
      set("download", "skipped");
      return await finish();
    }

    // Claude Code, Claude Desktop and the checkout: the console's own update
    if (ours.length) {
      set("update", "running");
      const u = await job("update-now");
      // the stream ends early when agents-multi restarts the console under it: the restart step follows
      if ("error" in u && !run.self) return fail("update", why(u.error));
      if ("cancelled" in u && u.cancelled) {
        return fail("update", t("uw.cancelled"));
      }
      if (!("error" in u) && u.code) {
        return fail("update", lastLine(v.out) ?? t("uw.exit", { c: u.code }));
      }
      set("update", "done");
    } else set("update", "skipped");

    // the desktop app last: installing it relaunches everything, this page included
    if (run.app) {
      set("download", "running");
      const r = await appUpdateAction("install");
      if (!r.ok) {
        return fail("download", r.message ?? appUpdate.value?.error ?? "");
      }
      await appLeaves(["checking", "downloading", "ready"], 15 * 60000);
      if (appUpdate.value?.state === "error") {
        return fail("download", appUpdate.value.error ?? "");
      }
      set("download", "done");
    } else set("download", "skipped");
    await finish();
  };

  // back after the restart: the update ran as far as the restart, the rest is here
  useEffect(() => {
    if (resume) {
      if (run.state.update === "running") run.state.update = "done";
      if (run.state.download === "running") run.state.download = "done";
      void finish();
    } else if (settle) {
      // only the install is left: the rest was done before
      for (const s of ["check", "update", "download", "restart"] as const) {
        run.state[s] = "skipped";
      }
      void finish();
    } else if (auto) void start();
  }, []);

  // the steps on screen: the download only when the app has a new version, closing Claude only when
  // the install waited for it
  const shown = STEPS.filter((s) =>
    (s !== "download" || run.app || run.state.download === "running") &&
    (s !== "close" || run.state.close === "running" ||
      run.state.close === "done" || v.later ||
      run.state.close === "failed")
  );
  const step = shown.find((s) => run.state[s] === "running");
  const failed = shown.find((s) => run.state[s] === "failed");
  const begun = shown.some((s) => run.state[s] !== "todo");
  const finished = run.state.verify === "done" ||
    (run.state.verify === "failed" && !!v.health);
  const busy = (S?.running.cli ?? []).length;
  const log = finished ? logSince() : [];
  const notes = run.app?.notes ? notePoints(run.app.notes, 6) : [];
  const h = v.health;
  const nowVersion = appUpdate.value?.current ?? v.news?.version ??
    S?.repo.version ?? "";

  const title: Key = finished
    ? (run.pending.length ? "uw.h.done" : "uw.h.current")
    : failed
    ? "uw.h.failed"
    : step === "close" && v.closing
    ? "uw.h.close"
    : step === "restart"
    ? "uw.h.restarting"
    : begun
    ? "uw.h.running"
    : "uw.h.ready";
  const stepState = (s: Step): StepState => run.state[s];

  return (
    <div
      class="uw-screen"
      role="dialog"
      aria-modal="true"
      aria-label={t("uw.title")}
    >
      <div class="uw-card">
        <button
          type="button"
          class="ib uw-x"
          title={t("close")}
          aria-label={t("close")}
          onClick={close}
        >
          <svg viewBox="0 0 24 24">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <RunMark
          share={runShare(shown.map(stepState))}
          state={finished && !failed
            ? "ok"
            : failed
            ? "bad"
            : step
            ? "on"
            : "idle"}
        />
        <h2 key={title}>{t(title, { v: nowVersion })}</h2>
        {!begun && (
          <>
            {pendingUpdates(S).length || app?.available
              ? (
                <ul class="uw-pend">
                  {app?.available && (
                    <li>
                      Agents Multi {app.current ?? "—"} →{" "}
                      {app.available.version}
                    </li>
                  )}
                  {pendingUpdates(S).map((p) => <li key={p}>{p}</li>)}
                </ul>
              )
              : <p class="uw-sub">{t("uw.h.readySub")}</p>}
          </>
        )}

        {begun && (
          <StepRows
            rows={shown.map((s) => {
              const st = stepState(s);
              const pct =
                s === "download" && st === "running" && app?.progress != null
                  ? Math.round(app.progress * 100)
                  : null;
              const detail = st === "skipped"
                ? t("uw.st.skipped")
                : pct != null
                ? `${pct}%`
                : s === "download" && run.app
                ? run.app.version
                : "";
              return { key: s, label: t(`uw.s.${s}`), state: st, detail, pct };
            })}
          />
        )}

        {step === "close" && v.closing && (
          <div class="uw-close">
            <CloseClaude
              plan={v.closing.plan}
              onSettled={(r, reopen) => {
                const c = v.closing;
                v.reopen = reopen;
                if (r.code) {
                  v.closing = null;
                  return fail("close", t("uw.exit", { c: r.code }));
                }
                c?.end(true);
              }}
              onLater={() => {
                const c = v.closing;
                v.closing = null;
                c?.end(false);
              }}
            />
          </div>
        )}
        {v.later && finished && <p class="uw-sub">{t("uw.closeLater")}</p>}
        {step === "restart" && <p class="uw-sub">{t("uw.restartNote")}</p>}
        {v.cause && <p class="uw-cause">{v.cause}</p>}
        {h && (
          <p class={h.fails ? "uw-cause" : "uw-sub"}>
            {h.fails
              ? t("uw.fails", { n: h.fails, msg: h.msg })
              : t("uw.healthy", { n: h.n })}
          </p>
        )}

        {finished && (notes.length > 0 || v.news?.releases?.length)
          ? (
            <div class="uw-news">
              <h3>{t("uw.news")}</h3>
              {notes.length
                ? <ul>{notes.map((l) => <li key={l}>{l}</li>)}</ul>
                : <News news={v.news} since={run.from} />}
            </div>
          )
          : null}
        {log.length > 0 && (
          <div class="uw-log">
            {log.map((e, i) => (
              <div key={`${e.at}${i}`}>
                {COMPONENTS[e.component] ?? e.component} ·{" "}
                {tk(`up.ev.${e.event}`)}
                {e.detail ? ` · ${e.detail}` : ""}
              </div>
            ))}
          </div>
        )}

        {!begun && busy > 0 && <p class="uw-sub">{t("uw.busy", { n: busy })}
        </p>}

        <div class="uw-go">
          {v.running
            ? (
              <button
                type="button"
                class="bt"
                onClick={() => v.jobId &&
                  void api.jobCancel(v.jobId)}
              >
                {t("uw.cancel")}
              </button>
            )
            : !begun
            ? (
              <>
                <button
                  type="button"
                  class="bt pri"
                  onClick={() => void start()}
                >
                  {t(
                    pendingUpdates(S).length || app?.available
                      ? "up.now"
                      : "uw.start",
                  )}
                </button>
                <button type="button" class="bt ghost" onClick={close}>
                  {t("sc.later")}
                </button>
              </>
            )
            : failed && failed !== "verify"
            ? (
              <>
                <button
                  type="button"
                  class="bt pri"
                  onClick={() => {
                    for (const s of STEPS) run.state[s] = "todo";
                    v.cause = "";
                    void start();
                  }}
                >
                  {t("uw.retry")}
                </button>
                <button type="button" class="bt ghost" onClick={close}>
                  {t("close")}
                </button>
              </>
            )
            : finished
            ? (
              <>
                {v.reopen.map((p) => (
                  <button
                    type="button"
                    class="bt"
                    key={p}
                    disabled={v.reopened.includes(p)}
                    onClick={() => {
                      v.reopened.push(p);
                      draw();
                      void reopenProfile(p);
                    }}
                  >
                    {t("cc.reopen", { p })}
                  </button>
                ))}
                <button type="button" class="bt pri" onClick={close}>
                  {t("uw.done")}
                </button>
              </>
            )
            : null}
          {v.out && (
            <button
              type="button"
              class="bt ghost uw-more"
              onClick={() => (v.showOut = !v.showOut, draw())}
            >
              {t(v.showOut ? "uw.hideOut" : "uw.showOut")}
            </button>
          )}
        </div>
        {v.out && v.showOut && (
          <pre
            class="out uw-out"
            ref={outEl}
          >{v.out}</pre>
        )}
      </div>
    </div>
  );
}

/** «What's new» alone: the notice after an update the timer made. */
function NewsDrawer({ since }: { since: string | null }) {
  const [news, setNews] = useState<Whatsnew | null | undefined>(undefined);
  useEffect(() => {
    void fetchNews(since).then((n) => {
      setNews(n);
      if (n?.version) keep(localStorage, SEEN_KEY, n.version);
    });
  }, []);
  return (
    <div class="rep uw-news">
      {news === undefined
        ? <p class="sub">{t("uw.loading")}</p>
        : <News news={news} since={since} />}
    </div>
  );
}

export function UpdateWizardHost() {
  const [open, setOpen] = useState<
    { resume: Run | null; auto: boolean; settle?: boolean; at: number } | null
  >(null);
  const [note, setNote] = useState<{ v: string; seen: string } | null>(null);
  const booted = useRef(false);
  const ready = status.value !== null;

  // the desktop app's update, from the start and on each of its events
  useTopic(() => loadAppUpdate(), ["app-update"]);

  useIntent(
    "update.wizard",
    (arg) =>
      setOpen({
        resume: null,
        auto: arg === "auto",
        settle: arg === "settle",
        at: Date.now(),
      }),
  );

  // At start: a run that the restart interrupted opens again; otherwise a version newer than the last
  // one seen here (the timer updated in the background) gets a notice.
  useEffect(() => {
    const S = status.value;
    if (!S || booted.current) return;
    booted.current = true;
    const w = kept<Run>(localStorage, UW_KEY);
    // only a run that got as far as the update resumes; one still asking is simply closed
    const past = w?.state &&
      ["running", "done"].some((x) =>
        x === w.state.update || x === w.state.download
      );
    if (w && past && Date.now() - Date.parse(w.at) < 30 * 60000) {
      return setOpen({ resume: w, auto: false, at: Date.now() });
    }
    keep(localStorage, UW_KEY);
    const v = S.repo.version, seen = kept<string>(localStorage, SEEN_KEY);
    if (!v) return;
    if (!seen) return keep(localStorage, SEEN_KEY, v);
    if (cmpVer(v, seen) > 0) setNote({ v, seen });
  }, [ready]);

  // the app relaunched from an update: say so, once (closing the screen dismisses the app's note)
  const updated = appUpdate.value?.updated;
  useEffect(() => {
    if (updated && !open) {
      setOpen({ resume: relaunched(updated), auto: false, at: Date.now() });
    }
  }, [updated?.to]);

  // a request that came before the shell drew this host
  useEffect(() => {
    if (intent.value?.name === "update.wizard") {
      setOpen({
        resume: null,
        auto: intent.value.arg === "auto",
        settle: intent.value.arg === "settle",
        at: Date.now(),
      });
    }
  }, []);

  return (
    <>
      {open && (
        <Screen
          key={open.at}
          resume={open.resume}
          auto={open.auto}
          settle={!!open.settle}
          close={() => {
            setOpen(null);
            keep(localStorage, UW_KEY);
            if (appUpdate.value?.updated) void appUpdateAction("dismiss");
          }}
        />
      )}
      {note && (
        <div class="upnote">
          <span>{t("uw.notice", { v: note.v })}</span>
          <button
            type="button"
            class="btn sm"
            onClick={() => {
              setNote(null);
              openDrawer(t("uw.news"), () => <NewsDrawer since={note.seen} />);
            }}
          >
            {t("uw.news")}
          </button>
          <button
            type="button"
            class="x"
            aria-label={t("close")}
            onClick={() => {
              setNote(null);
              keep(localStorage, SEEN_KEY, note.v);
            }}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}

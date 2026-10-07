// wizard.tsx — the update wizard: a drawer any page can open (the "update.wizard" intent), and what
// the console says on boot when it was updated. «Update now» as steps: what is out, the update with
// its live output, the console's restart when agents-multi itself changed, the doctor, and what is
// new. The restart reloads this page, so the wizard keeps its state in sessionStorage and opens again
// where it was. An update the timer made on its own is told by a notice on the next visit (the
// version last seen is in localStorage).

import { useEffect, useRef, useState } from "preact/hooks";
import { get, post } from "../../api.ts";
import { loadStatus, status } from "../../state.ts";
import { t, tk } from "../../i18n.ts";
import { useIntent } from "../../router.ts";
import { openDrawer, runJob } from "../../lib/ui.tsx";
import {
  cmpVer,
  COMPONENTS,
  fetchNews,
  keep,
  kept,
  News,
  pendingUpdates,
  type Report,
  SEEN_KEY,
  type Step,
  UW_KEY,
  UW_STEPS,
  type StepState,
  type Whatsnew,
  type WizState,
} from "./updates-lib.tsx";
import { openCloseClaude } from "./updates-close.tsx";

const at = (step: Step) => UW_STEPS.indexOf(step);
const lastLine = (out: string) => out.trim().split("\n").filter(Boolean).pop();

/** The console answers again, with other code than `old`: agents-multi's restart is over. */
async function consoleBack(old: string, timeoutMs = 90000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await get<{ code?: string }>("/api/code").catch(() => null);
    if (r?.code && r.code !== old) return true;
    await new Promise((res) => setTimeout(res, 2000));
  }
  return false;
}

interface Health {
  n: number;
  fails: number;
  msg: string;
}

/** What the run says to the screen and nothing else keeps: mutated by the flow, drawn by `draw`. */
interface View {
  out: string;
  cause: string;
  running: boolean;
  jobId: string | null;
  news: Whatsnew | null;
  health: Health | null;
}

function Wizard({ resume }: { resume: WizState | null }) {
  const [, force] = useState(0);
  const draw = () => force((n) => n + 1);
  const w = useRef<WizState>(resume ?? {
    from: (status.value as Report | null)?.repo.version ?? null,
    code: "",
    self: !!((status.value as Report | null)?.repo.behind || (status.value as Report | null)?.selfInstall),
    at: new Date().toISOString(),
    state: UW_STEPS.map(() => "todo" as StepState),
    pending: [],
  }).current;
  const v = useRef<View>({ out: "", cause: "", running: false, jobId: null, news: null, health: null }).current;
  const proceed = useRef<(() => void) | null>(null);
  const outEl = useRef<HTMLPreElement>(null);
  const S = status.value as Report | null;

  const set = (step: Step, st: StepState) => {
    w.state[at(step)] = st;
    keep(sessionStorage, UW_KEY, w);
    draw();
  };
  const logSince = () => (status.value?.updateLog ?? []).filter((e) => e.at >= w.at.replace(/\.\d+Z$/, "Z"));

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

  const finish = async () => {
    // restart: only when agents-multi itself moved; the page may already be the new one
    if (w.state[at("restart")] !== "done") {
      if (!w.self) set("restart", "skipped");
      else {
        set("restart", "running");
        const back = await consoleBack(w.code);
        set("restart", back ? "done" : "failed");
        if (!back) v.cause = t("uw.noRestart");
        // this page runs the old code: the new one, reloaded, carries on from the saved state
        else if (!resume) return location.reload();
      }
    }
    set("verify", "running");
    await loadStatus(true).catch(() => null);
    const doctor = status.value?.doctor ?? [];
    const fails = doctor.filter((c) => c.status === "fail");
    v.health = { n: doctor.length, fails: fails.length, msg: fails[0]?.msg ?? "" };
    const bad = logSince().find((e) => e.event === "failed" || e.event === "verify-failed");
    if (bad && !v.cause) v.cause = `${COMPONENTS[bad.component] ?? bad.component}: ${bad.detail || tk("up.ev.failed")}`;
    set("verify", fails.length || bad ? "failed" : "done");
    set("news", "running");
    v.news = await fetchNews(w.from);
    if (v.news?.version) keep(localStorage, SEEN_KEY, v.news.version);
    set("news", "done");
    keep(sessionStorage, UW_KEY);
  };

  const start = async () => {
    v.cause = "";
    w.code = (await get<{ code?: string }>("/api/code").catch(() => ({ code: "" }))).code ?? "";
    set("check", "running");
    const r = await job("update-check");
    if ("error" in r || r.code) {
      v.cause = ("error" in r ? r.error : undefined) ?? lastLine(v.out) ?? t("uw.exit", { c: "code" in r ? r.code : "?" });
      return set("check", "failed");
    }
    await loadStatus().catch(() => null);
    w.pending = pendingUpdates(status.value as Report | null);
    w.self = !!(status.value?.repo.behind || (status.value as Report | null)?.selfInstall);
    v.out = "";
    set("check", "done");
    if (!w.pending.length) {
      for (const s of ["update", "restart"] as const) w.state[at(s)] = "skipped";
      v.cause = "";
      v.out = t("uw.current");
      return await finish();
    }
    set("update", "waiting");
    await new Promise<void>((res) => proceed.current = res);
    proceed.current = null;
    set("update", "running");
    const u = await job("update-now");
    // the stream ends early when agents-multi restarts the console under it: the restart step follows
    if ("error" in u && !w.self) {
      v.cause = u.error;
      return set("update", "failed");
    }
    if ("cancelled" in u && u.cancelled) {
      v.cause = t("uw.cancelled");
      return set("update", "failed");
    }
    if (!("error" in u) && u.code) {
      v.cause = lastLine(v.out) ?? t("uw.exit", { c: u.code });
      return set("update", "failed");
    }
    set("update", "done");
    await finish();
  };

  // back after the console's restart: the update ran as far as the restart, the rest is here
  useEffect(() => {
    if (!resume) return;
    if (w.state[at("update")] === "running") w.state[at("update")] = "done";
    void finish();
  }, []);

  const step = UW_STEPS.find((_s, i) => w.state[i] === "running" || w.state[i] === "waiting");
  const verified = w.state[at("verify")] === "done" || w.state[at("verify")] === "failed";
  const log = verified ? logSince() : [];
  const h = v.health;
  return (
    <div class="rep">
      <ol class="rep-steps">
        {UW_STEPS.map((s, i) => (
          <li class={`rep-${w.state[i]}`} key={s}>
            <span class="rep-st">{tk(`uw.st.${w.state[i]}`)}</span> {tk(`uw.${s}`)}
          </li>
        ))}
      </ol>
      {w.pending.length > 0 && step === "update" && w.state[at("update")] === "waiting" && (
        <>
          <p>{t("uw.found")}</p>
          <ul class="uw-list">{w.pending.map((p) => <li key={p}>{p}</li>)}</ul>
        </>
      )}
      {v.cause && <p class="rep-cause">{v.cause}</p>}
      {step === "restart" && <p class="sub">{t("uw.restarting")}</p>}
      {v.out && <pre class="out rep-out" ref={outEl}>{v.out}</pre>}
      {h && (
        <p class={h.fails ? "rep-cause" : ""}>
          {h.fails ? t("uw.fails", { n: h.fails, msg: h.msg }) : t("uw.healthy", { n: h.n })}
        </p>
      )}
      {log.length > 0 && (
        <div class="uw-log">
          {log.map((e, i) => (
            <div class="sub" key={`${e.at}${i}`}>
              {COMPONENTS[e.component] ?? e.component} · {tk(`up.ev.${e.event}`)}
              {e.detail ? ` · ${e.detail}` : ""}
            </div>
          ))}
        </div>
      )}
      {S?.selfInstall && log.length > 0 && (
        <p><button type="button" class="btn sm" onClick={() => void openCloseClaude()}>{t("cc.btn")}</button></p>
      )}
      {v.news && (
        <>
          <h3 class="uw-h">{t("uw.news")}</h3>
          <div class="uw-news"><News news={v.news} since={w.from} /></div>
        </>
      )}
      <p>
        {v.running
          ? (
            <button
              type="button"
              class="btn sm"
              onClick={() => v.jobId && void post("/api/job/cancel", { id: v.jobId }).catch(() => {})}
            >
              {t("uw.cancel")}
            </button>
          )
          : step === "update"
          ? <button type="button" class="btn" onClick={() => proceed.current?.()}>{t("uw.go")}</button>
          : w.state.every((s) => s === "todo")
          ? <button type="button" class="btn" onClick={() => void start()}>{t("uw.start")}</button>
          : null}
      </p>
    </div>
  );
}

function openWizard(resume: WizState | null = null): void {
  openDrawer(t("uw.title"), () => <Wizard resume={resume} />);
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
      {news === undefined ? <p class="sub">{t("uw.loading")}</p> : <News news={news} since={since} />}
    </div>
  );
}

export function UpdateWizardHost() {
  const [note, setNote] = useState<{ v: string; seen: string } | null>(null);
  const booted = useRef(false);
  const ready = status.value !== null;

  useIntent("update.wizard", () => openWizard());

  // At start: a wizard that the console's restart interrupted opens again; otherwise a version newer
  // than the last one seen here (the timer updated in the background) gets a notice.
  useEffect(() => {
    const S = status.value;
    if (!S || booted.current) return;
    booted.current = true;
    const w = kept<WizState>(sessionStorage, UW_KEY);
    // only a wizard that got as far as the update resumes; one still asking is simply closed
    const past = w?.state && ["running", "done", "failed"].includes(w.state[at("update")]);
    if (w && past && Date.now() - Date.parse(w.at) < 30 * 60000) return openWizard(w);
    keep(sessionStorage, UW_KEY);
    const v = S.repo.version, seen = kept<string>(localStorage, SEEN_KEY);
    if (!v) return;
    if (!seen) return keep(localStorage, SEEN_KEY, v);
    if (cmpVer(v, seen) > 0) setNote({ v, seen });
  }, [ready]);

  if (!note) return null;
  return (
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
  );
}

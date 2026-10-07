// system.tsx — Today's system card. Calm by default: when every check passes it is two lines (health
// and versions). A problem gets a human title, the doctor's message as detail and one button: «Repair»
// when the check has repair steps or a fix the console runs, else «Ask Claude». A repaired problem is
// ticked, the count goes down, and at the end the card is calm again. An update shows here once, with
// the versions and what is new, and «Update now» opens the update screen; «Later» folds it into the
// header's pill.

import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Check } from "../../api.ts";
import { t } from "../../i18n.ts";
import { ago } from "../../lib/format.ts";
import { FIX_ACTIONS, runJob, toastErr } from "../../lib/ui.tsx";
import { request, useIntent } from "../../router.ts";
import { loadStatus, status } from "../../state.ts";
import { askNow } from "../../shell/ask.tsx";
import { appUpdater, notePoints } from "../../shell/app-update.ts";
import { setUpdateLater, sys, updateLater } from "../../shell/sysstate.ts";
import { openRepair, useRepair } from "../system/health-repair.tsx";
import { checkTitle } from "./health-title.ts";

const RECHECK = (
  <svg viewBox="0 0 16 16">
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
  </svg>
);

/** A fix the console can run by itself, without the drawer: a single allowlisted action. */
function useFix(c: Check) {
  const [running, setRunning] = useState(false);
  const [cause, setCause] = useState("");
  const act = c.fix ? FIX_ACTIONS[c.fix.trim()] : undefined;
  const start = async (): Promise<boolean> => {
    if (!act) return false;
    setRunning(true);
    setCause("");
    let last = "";
    const r = await runJob(act, undefined, (o) => (last = o.trim().split("\n").filter(Boolean).pop() ?? last))
      .catch((e: Error) => ({ error: e.message }));
    setRunning(false);
    if ("error" in r || r.code) {
      setCause("error" in r ? r.error : last);
      return false;
    }
    await loadStatus(true).catch(toastErr);
    const now = status.value?.doctor.find((x) => x.id === c.id);
    if (now && now.status !== "ok") {
      setCause(now.msg);
      return false;
    }
    return true;
  };
  return { act, running, cause, start };
}

function Problem({ c, fixed, onFixed }: { c: Check; fixed: boolean; onFixed: () => void }) {
  const steps = c.repair ?? [];
  const rep = useRepair(c.id, steps);
  const fix = useFix(c);
  const title = checkTitle(c);
  const n = steps.length;
  const at = rep.state.findIndex((s) => s === "running" || s === "waiting");
  const waiting = at >= 0 && rep.state[at] === "waiting";
  const running = rep.running || fix.running;
  const cause = rep.cause || fix.cause;
  const detail = waiting && steps[at].kind === "user" ? steps[at].text : cause || c.msg;

  const go = async () => {
    const ok = n ? await rep.start() : await fix.start();
    if (ok) onFixed();
  };

  let button;
  if (fixed) button = <span class="bt sm ok">{t("sc.fixed")}</span>;
  else if (waiting) button = <button type="button" class="bt sm pri" onClick={rep.userDone}>{t("rep.userDone")}</button>;
  else if (running) {
    button = (
      <button type="button" class="bt sm" disabled>
        <span class="spin2" />
        {n > 1 ? t("sc.repairingN", { i: at + 1, n }) : t("sc.repairing")}
      </button>
    );
  } else if (n || fix.act) {
    button = (
      <button type="button" class={`bt sm${c.status === "fail" ? " pri" : ""}`} onClick={() => void go()}>
        {cause ? t("sc.retry") : n > 1 ? t("sc.repairN", { n }) : t("sc.repair")}
      </button>
    );
  } else {
    button = (
      <button type="button" class="bt sm" onClick={() => askNow(t("sc.ask.text", { t: title, msg: c.msg, fix: c.fix ?? "—" }))}>
        {t("sc.ask")}
      </button>
    );
  }
  return (
    <div class={`prob ${fixed ? "fixed" : c.status}`}>
      <span class="ic">{fixed ? "✓" : c.status === "fail" ? "!" : "·"}</span>
      <b title={c.id}>{title}</b>
      {button}
      <p class={cause && !fixed ? "bad" : ""}>
        {detail}
        {cause && !fixed && n > 0 && (
          <>
            {" · "}
            <button type="button" class="lnk" onClick={() => openRepair(c.id)}>{t("sc.details")}</button>
          </>
        )}
      </p>
    </div>
  );
}

function Versions() {
  const S = status.value;
  if (!S) return null;
  const m = S.machine;
  const parts = [
    S.repo.version ? `${S.repo.version}` : null,
    m.cliVersion ? `Code ${m.cliVersion}` : null,
    m.desktopVersion ? `Desktop ${m.desktopVersion}` : null,
  ].filter(Boolean);
  return (
    <div class="calm">
      <i class="still" />
      <span><b>{t("sc.current")}</b></span>
      <span class="v">{parts.join(" · ")}</span>
    </div>
  );
}

function Health({ n }: { n: number }) {
  return (
    <div class="calm">
      <i />
      <span><b>{t("pill.ok")}</b> · {t("sc.checks", { n })}</span>
      <span class="v">{status.value ? ago(status.value.generatedAt) : ""}</span>
    </div>
  );
}

/** One row per component an update would move: from → to. */
function UpdateRows() {
  const S = status.value, app = appUpdater();
  const rows: [string, string][] = [];
  if (app?.available) rows.push(["Agents Multi", `${app.current ?? "—"} → ${app.available.version}`]);
  if (S) {
    const m = S.machine, u = S.update ?? {}, r = S.repo;
    if (r.isRepo && r.behind) rows.push(["agents-multi", `${r.version} → ${t("sc.commits", { n: r.behind })}`]);
    if (u.cli?.latest && u.cli.latest !== m.cliVersion) rows.push(["Claude Code", `${m.cliVersion ?? "—"} → ${u.cli.latest}`]);
    if (m.desktopStaged) rows.push(["Claude Desktop", `${m.desktopVersion ?? "—"} → ${m.desktopStaged} · ${t("sc.staged")}`]);
  }
  return (
    <div class="vv">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <span>{k}</span>
          <em>{v}</em>
        </Fragment>
      ))}
    </div>
  );
}

function UpdateCard() {
  const S = status.value, app = appUpdater();
  const news = app?.available?.notes ? notePoints(app.available.notes) : [];
  // Desktop restarts to take its new version: say which ones are open, and if a session works in one
  const desk = S?.running.desktop.map((d) => d.variant) ?? [];
  const busy = S?.running.cli.filter((c) => c.embedded).length ?? 0;
  return (
    <div class="upd">
      <h4>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M8 13V3M4 7l4-4 4 4" />
        </svg>
        {t("pill.up")}
      </h4>
      <UpdateRows />
      {news.length > 0 && <ul>{news.map((l) => <li key={l}>{l}</li>)}</ul>}
      <div class="go">
        <button type="button" class="bt pri" onClick={() => request("update.wizard", undefined, "auto")}>{t("up.now")}</button>
        <button type="button" class="bt ghost" onClick={() => setUpdateLater(true)}>{t("sc.later")}</button>
      </div>
      {S?.machine.desktopStaged && desk.length > 0 && (
        <div class="note">{busy ? t("sc.note.busy", { p: desk.join(", "), n: busy }) : t("sc.note", { p: desk.join(", ") })}</div>
      )}
    </div>
  );
}

export function SystemCard() {
  const s = sys.value;
  const [rechecking, setRechecking] = useState(false);
  const [fixed, setFixed] = useState<Check[]>([]);
  const [flash, setFlash] = useState(0);
  const card = useRef<HTMLElement>(null);

  // the header's pill: bring the card to the eye
  useIntent("system.show", () => setFlash((n) => n + 1));
  useEffect(() => {
    if (!flash || !card.current) return;
    card.current.classList.remove("flash");
    void card.current.offsetWidth;
    card.current.classList.add("flash");
  }, [flash]);

  // the ticked problems stay a moment after the last one, then the card is calm
  const open = s.problems.filter((c) => !fixed.some((f) => f.id === c.id));
  useEffect(() => {
    if (!fixed.length || open.length) return;
    const id = setTimeout(() => setFixed([]), 1500);
    return () => clearTimeout(id);
  }, [fixed.length, open.length]);

  const recheck = async () => {
    setRechecking(true);
    await loadStatus(true).catch(toastErr);
    setRechecking(false);
  };
  const rc = (
    <button type="button" class={`sc-rc${rechecking ? " on" : ""}`} title={t("sc.recheck")} aria-label={t("sc.recheck")} onClick={recheck}>
      {RECHECK}
    </button>
  );
  const update = s.pending.length > 0 && !updateLater.value;
  const rows = [...open, ...fixed];
  if (!status.value) return <article class="card sc" ref={card} />;

  return (
    <article class="card sc" ref={card}>
      {rows.length > 0
        ? (
          <>
            <div class="sc-h">
              <span class={`lbl ${open.some((c) => c.status === "fail") ? "crit" : open.length ? "warn" : "ok"}`}>
                {open.length ? t("sc.toFix", { n: open.length }) : t("sc.allFixed")}
              </span>
              <span class="r">
                {t("health.okN", { n: s.ok })} · {status.value ? ago(status.value.generatedAt) : ""} {rc}
              </span>
            </div>
            {update && <UpdateCard />}
            <div class="probs">
              {rows.map((c) => (
                <Problem
                  key={c.id}
                  c={c}
                  fixed={fixed.some((f) => f.id === c.id)}
                  onFixed={() => setFixed((f) => [...f, c])}
                />
              ))}
            </div>
          </>
        )
        : (
          <>
            <div class="sc-h">
              <span class="lbl">{t("nav.system")}</span>
              <span class="r">{rc}</span>
            </div>
            {update && <UpdateCard />}
            <Health n={s.total} />
            {!update && <Versions />}
          </>
        )}
    </article>
  );
}

// agents.tsx — Agents: what runs on every machine of the person, what it is doing now, the routines and what ended
// this week (ADR 0014, third round, B). The page reads GET /api/runs once and then follows its stream; a Stop is signed
// with the passkey and checked by the machine, a resume elsewhere is a proposal accepted in Waiting.

import { useEffect, useRef, useState } from "preact/hooks";
import { loadNodes, loadRuns, resumeRun, runsEvents, stopRun } from "./api.ts";
import {
  applyRunEvent,
  cannotResume,
  lastStop,
  type RoutineInfo,
  type Run,
  type RunsState,
  stopChallenge,
  stoppable,
  toneOf,
} from "./agents-core.ts";
import { type Explained, type NodeInfo, online, type Passkey } from "./lib.ts";
import { explain, PkError, usePasskeys } from "./passkeys.tsx";
import { go } from "./route.ts";
import { Swipe } from "./swipe.tsx";
import { dateOf, t, tk } from "./t.ts";
import { Empty, Failure, Header, Icon, Sheet, Skeleton, toast, usePull } from "./ui.tsx";
import { assertWith, expiryFrom } from "./webauthn.ts";

const CLIENT = "(client)";
const time = (iso: string) => dateOf(iso, { hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => dateOf(iso, { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const nameOf = (r: Run) =>
  r.title || r.workflow?.name || r.routine || (r.project === CLIENT ? t("agents.client") : r.project.split("/").pop()) || r.id;

/** The list and its stream: loaded once, then every event applied; a stream that comes back reads the list again. */
function useRuns() {
  const [s, setS] = useState<RunsState | null>(null);
  const [err, setErr] = useState("");
  const cur = useRef<RunsState | null>(null);
  const load = () =>
    loadRuns().then((r) => {
      cur.current = r;
      setS(r);
      setErr("");
    }, (e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
    const es = runsEvents();
    let connected = false;
    es.addEventListener("open", () => {
      // what happened while the stream was down is only in the list
      if (connected) void load();
      connected = true;
    });
    for (const name of ["run", "gone", "node"]) {
      es.addEventListener(name, (e) => {
        if (!cur.current) return;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse((e as MessageEvent<string>).data);
        } catch {
          return;
        }
        cur.current = applyRunEvent(cur.current, name, data);
        setS(cur.current);
      });
    }
    return () => es.close();
  }, []);
  return { s, err, load };
}

function StateTag({ r }: { r: Run }) {
  return <span class={`tag ${toneOf(r.state)}`}>{tk(`agents.state.${r.state}`) ?? r.state}</span>;
}

/** The Stop, explained first: the passkey signs it, the machine checks it and stops the agent at once. */
function StopSheet({ r, onClose, stop }: { r: Run; onClose: () => void; stop: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title={t("agents.stopTitle", { n: nameOf(r) })} onClose={onClose}>
      <p class="meta">{t("agents.stopHelp", { node: r.node })}</p>
      <div class="sheet-actions">
        <button
          type="button"
          class="btn danger"
          disabled={busy}
          aria-busy={busy}
          onClick={async () => {
            setBusy(true);
            if (await stop()) onClose();
            setBusy(false);
          }}
        >
          {busy ? t("agents.confirm") : t("agents.stop")}
        </button>
        <button type="button" class="btn" disabled={busy} onClick={onClose}>{t("cancel")}</button>
      </div>
    </Sheet>
  );
}

/** Resume elsewhere: which machine (or the best one free), then a proposal the person accepts in Waiting. */
function ResumeSheet({ r, onClose }: { r: Run; onClose: () => void }) {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    loadNodes().then((n) => setNodes(n.nodes.filter((x) => x.name !== r.node && online(x, n.now))), () => {});
  }, []);
  const go_ = async () => {
    setBusy(true);
    try {
      await resumeRun(r.node, r.id, to || undefined);
      toast(t("agents.resumed"), { label: t("tab.waiting"), run: () => go({ view: "waiting" }) });
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Sheet title={t("agents.resumeTitle", { n: nameOf(r) })} onClose={onClose}>
      <p class="meta">{t("agents.resumeHelp")}</p>
      <label class="field">
        <span>{t("agents.resumeOn")}</span>
        <select value={to} onChange={(e) => setTo(e.currentTarget.value)}>
          <option value="">{t("agents.resumeAuto")}</option>
          {nodes.map((n) => <option key={n.name} value={n.name}>{n.name}</option>)}
        </select>
      </label>
      {err && <p class="err" role="alert">{err}</p>}
      <div class="sheet-actions">
        <button type="button" class="btn primary" disabled={busy} aria-busy={busy} onClick={go_}>{t("agents.resumeGo")}</button>
        <button type="button" class="btn" disabled={busy} onClick={onClose}>{t("cancel")}</button>
      </div>
    </Sheet>
  );
}

function RunCard({ r, usable, stops, reload }: { r: Run; usable: Passkey[]; stops: RunsState["stops"]; reload: () => void }) {
  const [sheet, setSheet] = useState<"stop" | "resume" | null>(null);
  const [err, setErr] = useState<Explained | null>(null);
  const [asked, setAsked] = useState(false);
  const canStop = stoppable(r) && usable.length > 0;
  const why = cannotResume(r);
  const stale = r.online === false;
  const last = lastStop(stops, r);
  const stop = async (): Promise<boolean> => {
    try {
      const expires = expiryFrom(new Date());
      const assertion = await assertWith(await stopChallenge({ node: r.node, run: r.id, expires }), usable.map((k) => k.id));
      await stopRun(r.node, r.id, expires, assertion);
      setErr(null);
      setAsked(true);
      toast(t("agents.stopAsked", { node: r.node }));
      reload();
      return true;
    } catch (e) {
      setErr(explain(e));
      return false;
    }
  };
  const meta = [
    r.node,
    r.profile,
    r.project === CLIENT ? t("agents.client") : r.project.split("/").slice(-2).join("/"),
    r.branch,
  ].filter(Boolean).join(" · ");
  return (
    <li class={`card run flush${stale ? " stale" : ""}`} data-state={r.state}>
      <Swipe
        class="sw-pad"
        disabled={!canStop}
        left={canStop ? { label: t("agents.stop"), tone: "crit", icon: "stop", run: () => void stop() } : undefined}
      >
        <div class="run-h">
          <span class={`dot ${r.state}`} aria-hidden="true" />
          <div class="run-t">
            <h3>{nameOf(r)}</h3>
            <p class="meta wrap">{meta}</p>
          </div>
          <StateTag r={r} />
        </div>
        <p class="meta run-k">
          {tk(`agents.kind.${r.kind}`) ?? r.kind}
          {r.workflow?.step && <> · {t("agents.step", { s: r.workflow.step })}</>}
          {" · "}{t("agents.since", { t: time(r.started) })}
        </p>
        {r.workflow && r.workflow.steps.length > 1 && (
          <ol class="run-steps" aria-label={r.workflow.name}>
            {r.workflow.steps.map((s) => <li key={s.id} class={s.state} title={`${s.id}: ${s.state}`}>{s.id}</li>)}
          </ol>
        )}
        {r.tail.length > 0
          ? <pre class="run-tail">{r.tail.join("\n")}</pre>
          : <p class="meta">{t("agents.noOutput")}</p>}
        {stale && <p class="banner warn"><Icon name="alert" size={18} /><span>{t("agents.offline")}</span></p>}
        {last && last.state === "refused" && <p class="err">{t("agents.stopRefused", { node: r.node, why: last.why ?? "" })}</p>}
        {(asked || last?.state === "pending") && last?.state !== "refused" && <p class="meta">{t("agents.stopPending", { node: r.node })}</p>}
        <div class="verdicts">
          {r.waiting && r.waiting.length > 0 && (
            <a class="btn primary" href="#waiting">{t("agents.answer")}</a>
          )}
          {stoppable(r) && (
            <button type="button" class="btn danger-o" disabled={!canStop} onClick={() => setSheet("stop")}>
              <Icon name="stop" size={16} />{t("agents.stop")}
            </button>
          )}
          {!why && <button type="button" class="btn" onClick={() => setSheet("resume")}>{t("agents.resume")}</button>}
        </div>
        {why && why !== "running" && (
          <p class="meta">{why === "nojob" ? t("agents.why.nojob") : t("agents.why", { why })}</p>
        )}
        {stoppable(r) && usable.length === 0 && <p class="meta">{t("agents.needKey")}</p>}
        {err && <PkError e={err} />}
        {canStop && <p class="meta swipe-hint">{t("agents.swipeHint")}</p>}
      </Swipe>
      {sheet === "stop" && <StopSheet r={r} onClose={() => setSheet(null)} stop={stop} />}
      {sheet === "resume" && <ResumeSheet r={r} onClose={() => setSheet(null)} />}
    </li>
  );
}

function Routines({ list }: { list: RoutineInfo[] }) {
  return (
    <section class="card" aria-labelledby="rt-h">
      <h2 id="rt-h">{t("agents.routines")}</h2>
      <ul class="plain-list">
        {list.map((x) => (
          <li key={`${x.node}/${x.name}`} class="run-row">
            <span class="row-t">{x.name === CLIENT ? t("agents.client") : x.name}</span>
            <span class="meta">
              {[
                x.node,
                x.schedule,
                !x.enabled ? t("agents.paused") : x.next ? t("agents.next", { t: day(x.next) }) : undefined,
                x.last ? t("agents.last", { t: day(x.last) }) : undefined,
              ].filter(Boolean).join(" · ")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Recent({ list }: { list: Run[] }) {
  return (
    <section class="card" aria-labelledby="rc-h">
      <h2 id="rc-h">{t("agents.recent")}</h2>
      <ul class="plain-list">
        {list.map((r) => (
          <li key={`${r.node}/${r.id}`} class="run-row">
            <span class="row-t">{nameOf(r)}</span>
            <span class="meta">
              <StateTag r={r} /> {[r.node, r.profile, t("agents.endedAt", { t: day(r.ended ?? r.updated) })].join(" · ")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AgentsView() {
  const { s, err, load } = useRuns();
  const pk = usePasskeys();
  const pull = usePull(async () => {
    await Promise.all([load(), pk.load()]);
  });
  const n = s?.runs.length ?? 0;
  return (
    <>
      {pull.indicator}
      <Header large title={t("agents.title")} sub={n ? t("agents.count", { n }) : undefined} />
      {err && <Failure text={err} retry={() => void load()} />}
      {!s && !err && <Skeleton rows={3} tall />}
      {s && !n && !err && <Empty icon="job" text={t("agents.none")} />}
      {s && n > 0 && (
        <ul class="stack">
          {s.runs.map((r) => <RunCard key={`${r.node}/${r.id}`} r={r} usable={pk.ready} stops={s.stops} reload={() => void load()} />)}
        </ul>
      )}
      {s && s.routines.length > 0 && <Routines list={s.routines} />}
      {s && s.recent.length > 0 && <Recent list={s.recent} />}
    </>
  );
}

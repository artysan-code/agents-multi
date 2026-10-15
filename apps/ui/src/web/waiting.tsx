// waiting.tsx — What waits: the requests of the agents on the person's machines and the jobs proposed to them,
// each answered with the passkey (ADR 0014, G5). The phone computes the challenge, the passkey signs it, the
// machine checks it: nothing here is trusted by the service.

import { useState } from "preact/hooks";
import { acceptJob, answerRequest, declineJob } from "./api.ts";
import { answersOf, type Passkey, type ProposedJob, type Question, type Waiting as Req } from "./lib.ts";
import { PasskeyCard, usePasskeys } from "./passkeys.tsx";
import { pendingCount, refreshWaiting, waiting, waitingError } from "./state.ts";
import { dateOf, t } from "./t.ts";
import { Empty, Failure, Header, Icon, Skeleton, usePull } from "./ui.tsx";
import { answerChallenge, assertWith, expiryFrom, jobChallenge, type Verdict } from "./webauthn.ts";

/** Runs one passkey-signed action: shows it is waiting for the device, and the reason when it fails. */
function useSigned() {
  const [busy, setBusy] = useState<string>("");
  const [err, setErr] = useState("");
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await fn();
      setErr("");
      await refreshWaiting();
    } catch (e) {
      const n = (e as Error).name;
      setErr(n === "NotAllowedError" || n === "AbortError" ? t("pk.cancelled") : (e as Error).message);
    }
    setBusy("");
  };
  return { busy, err, run };
}

function Meta({ items }: { items: (string | undefined)[] }) {
  return <p class="meta wrap">{items.filter(Boolean).join(" · ")}</p>;
}

function Choices({ questions, chosen, set }: { questions: Question[]; chosen: Record<string, string[]>; set: (c: Record<string, string[]>) => void }) {
  return (
    <>
      {questions.map((q, qi) => (
        <fieldset key={qi} class="q">
          <legend>{q.header ? <small>{q.header}</small> : null}{q.question}</legend>
          {q.options.map((o) => {
            const on = (chosen[q.question] ?? []).includes(o.label);
            const toggle = () => {
              const cur = chosen[q.question] ?? [];
              set({ ...chosen, [q.question]: q.multiSelect ? (on ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : [o.label] });
            };
            return (
              <label key={o.label} class={`opt${on ? " on" : ""}`}>
                {q.multiSelect
                  ? <input type="checkbox" name={`q${qi}`} checked={on} onChange={toggle} />
                  : <input type="radio" name={`q${qi}`} checked={on} onChange={toggle} />}
                <span><b>{o.label}</b>{o.description && <small>{o.description}</small>}</span>
              </label>
            );
          })}
        </fieldset>
      ))}
    </>
  );
}

function Request({ r, usable }: { r: Req; usable: Passkey[] }) {
  const { busy, err, run } = useSigned();
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const ask = r.kind === "question";
  const answers = ask ? answersOf(r.questions ?? [], chosen) : undefined;
  const off = usable.length === 0 || !!busy;

  const answer = (verdict: Verdict) =>
    run(verdict, async () => {
      const expires = expiryFrom(new Date());
      const body = { id: r.id, node: r.node, verdict, answers: verdict === "deny" ? undefined : answers ?? undefined, expires };
      const assertion = await assertWith(await answerChallenge(body), usable.map((k) => k.id));
      await answerRequest(r.id, { verdict, ...(body.answers ? { answers: body.answers } : {}), expires, assertion });
    });

  return (
    <li class="card ask">
      <div class="ask-h">
        <span class={`badge ${ask ? "info" : "warn"}`}><Icon name={ask ? "chat" : "shield"} size={16} /></span>
        <div>
          <h3>{ask ? t("wait.question") : t("wait.request")}</h3>
          <Meta items={[r.node, r.profile, r.project.split("/").slice(-2).join("/")]} />
        </div>
      </div>
      <p class="what">{r.what}</p>
      {ask && r.questions && <Choices questions={r.questions} chosen={chosen} set={setChosen} />}
      <div class="verdicts">
        {ask
          ? (
            <button type="button" class="btn primary" disabled={off || !answers} aria-busy={busy === "allow"} onClick={() => void answer("allow")}>
              {busy === "allow" ? t("wait.confirm") : t("wait.send")}
            </button>
          )
          : (
            <>
              <button type="button" class="btn primary" disabled={off} aria-busy={busy === "allow"} onClick={() => void answer("allow")}>
                {busy === "allow" ? t("wait.confirm") : t("wait.yes")}
              </button>
              <button type="button" class="btn" disabled={off} aria-busy={busy === "session"} onClick={() => void answer("session")}>
                {busy === "session" ? t("wait.confirm") : t("wait.session")}
              </button>
            </>
          )}
        <button type="button" class="btn danger-o" disabled={off} aria-busy={busy === "deny"} onClick={() => void answer("deny")}>
          {busy === "deny" ? t("wait.confirm") : t("wait.no")}
        </button>
      </div>
      {usable.length === 0 && <p class="meta">{t("wait.needKey")}</p>}
      {err && <p class="err" role="alert">{err}</p>}
    </li>
  );
}

function Job({ j, usable }: { j: ProposedJob; usable: Passkey[] }) {
  const { busy, err, run } = useSigned();
  const off = usable.length === 0 || !!busy;
  const accept = () =>
    run("accept", async () => {
      const expires = expiryFrom(new Date());
      const assertion = await assertWith(await jobChallenge(j, expires), usable.map((k) => k.id));
      await acceptJob(j.id, expires, assertion);
    });
  const decline = () => run("decline", () => declineJob(j.id));
  return (
    <li class="card ask">
      <div class="ask-h">
        <span class="badge ok"><Icon name="job" size={16} /></span>
        <div>
          <h3>{j.spec.name}</h3>
          <Meta items={[j.node || undefined, j.spec.account, j.spec.path || j.spec.repo.split("/").pop()]} />
        </div>
      </div>
      <p class="what">{j.reason || (j.kind === "resume" ? t("wait.resume") : t("wait.routine"))}</p>
      <p class="meta">{t("wait.proposedBy", { by: j.by, d: dateOf(j.created, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) })}</p>
      <div class="verdicts">
        <button type="button" class="btn primary" disabled={off} aria-busy={busy === "accept"} onClick={() => void accept()}>
          {busy === "accept" ? t("wait.confirm") : t("wait.accept")}
        </button>
        <button type="button" class="btn danger-o" disabled={!!busy} onClick={() => void decline()}>{t("wait.decline")}</button>
      </div>
      {usable.length === 0 && <p class="meta">{t("wait.needKey")}</p>}
      {err && <p class="err" role="alert">{err}</p>}
    </li>
  );
}

export function WaitingView() {
  const pk = usePasskeys();
  const w = waiting.value;
  const pull = usePull(async () => {
    await Promise.all([refreshWaiting(), pk.load()]);
  });
  const jobs = w?.jobs.filter((j) => j.status === "proposed") ?? [];
  const n = pendingCount.value;
  return (
    <>
      {pull.indicator}
      <Header large title={t("wait.title")} sub={w && n ? t("wait.count", { n }) : undefined} />
      {waitingError.value && <Failure text={waitingError.value} retry={() => void refreshWaiting()} />}
      {pk.err && <Failure text={pk.err} retry={pk.load} />}
      {pk.keys && <PasskeyCard keys={pk.keys} onChange={pk.load} />}
      {!w && !waitingError.value && <Skeleton rows={3} tall />}
      {w && !n && !waitingError.value && <Empty icon="check" text={t("wait.none")} />}
      {w && n > 0 && (
        <ul class="stack">
          {w.requests.map((r) => <Request key={r.id} r={r} usable={pk.ready} />)}
          {jobs.map((j) => <Job key={j.id} j={j} usable={pk.ready} />)}
        </ul>
      )}
    </>
  );
}

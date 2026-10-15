// machines.tsx — Machines: the account's nodes, and which one answers the chat (the orchestrator setting).
// A new machine is paired with the code it shows (`agents node pair`), typed here.

import { useEffect, useState } from "preact/hooks";
import { claimPairing, getOrchestrator, loadNodes, type Orchestrator, setOrchestrator } from "./api.ts";
import { moved, type NodeInfo, online, orderOf, tidyCode } from "./lib.ts";
import { dateOf, t } from "./t.ts";
import { Empty, Failure, Header } from "./ui.tsx";

/** The code a machine shows, typed: the machine's next poll receives its token. */
function Pair({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = (e: Event) => {
    e.preventDefault();
    setBusy(true);
    claimPairing(code).then(
      (r) => (setMsg({ ok: true, text: t("machines.paired", { n: r.node }) }), setCode(""), onPaired()),
      (er: Error) => setMsg({ ok: false, text: er.message }),
    ).finally(() => setBusy(false));
  };
  return (
    <section class="card">
      <h2>{t("machines.pair")}</h2>
      <p class="meta">{t("machines.pairHelp")}</p>
      <form onSubmit={submit}>
        <label class="field">
          <span>{t("machines.code")}</span>
          <input
            value={code}
            onInput={(e) => setCode(tidyCode(e.currentTarget.value))}
            placeholder="XXXX-XXXX"
            autocomplete="off"
            autocapitalize="characters"
            autocorrect="off"
            spellcheck={false}
            maxLength={9}
            aria-describedby="pair-msg"
          />
        </label>
        <button type="submit" class="btn" disabled={busy || code.length < 9}>{t("machines.pairGo")}</button>
      </form>
      <p id="pair-msg" class={msg?.ok ? "ok" : "note"} role="status" hidden={!msg}>{msg?.text}</p>
    </section>
  );
}

export function Machines() {
  const [nodes, setNodes] = useState<{ nodes: NodeInfo[]; now: string } | null>(null);
  const [orch, setOrch] = useState<Orchestrator>({ node: null, order: [] });
  const [err, setErr] = useState("");
  const load = () =>
    Promise.all([loadNodes(), getOrchestrator().catch(() => ({ node: null, order: [] }) as Orchestrator)]).then(
      ([n, o]) => (setNodes(n), setOrch(o), setErr("")),
      (e: Error) => setErr(e.message),
    );
  useEffect(() => {
    void load();
    const again = setInterval(() => document.visibilityState === "visible" && void load(), 30_000);
    return () => clearInterval(again);
  }, []);

  const save = (next: Orchestrator) => {
    setOrch(next);
    setOrchestrator(next).then(() => setErr(""), (e: Error) => (setErr(e.message), load()));
  };

  const names = nodes?.nodes.map((n) => n.name) ?? [];
  const order = orderOf(orch.order, names);
  return (
    <>
      <Header title={t("machines.title")} />
      {err && <Failure text={err} retry={load} />}
      {nodes && !nodes.nodes.length && !err && <Empty text={t("machines.none")} />}
      {nodes && <Pair onPaired={load} />}
      {nodes && nodes.nodes.length > 0 && (
        <>
          <ul class="rows">
            {nodes.nodes.map((n) => {
              const on = online(n, nodes.now);
              return (
                <li key={n.name} class="node">
                  <span class={`dot ${on ? "on" : "off"}`} role="img" aria-label={on ? t("machines.online") : t("machines.offline")} />
                  <span class="node-t">
                    <b>{n.name}</b>
                    <small>
                      {[n.platform, n.headless ? t("machines.server") : t("machines.desktop"), `${n.running}/${n.cap}`, `v${n.version}`].join(" · ")}
                    </small>
                    {!on && <small>{t("machines.seen", { t: dateOf(n.seen, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) })}</small>}
                  </span>
                  {orch.node === n.name && <span class="tag">{t("machines.answers")}</span>}
                </li>
              );
            })}
          </ul>
          <section class="card">
            <h2>{t("machines.orch")}</h2>
            <p class="meta">{t("machines.orchHelp")}</p>
            <label class="field">
              <span>{t("machines.answering")}</span>
              <select value={orch.node ?? ""} onChange={(e) => save({ ...orch, node: e.currentTarget.value || null, order })}>
                <option value="">{t("machines.auto")}</option>
                {names.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            {order.length > 1 && (
              <>
                <h3>{t("machines.fallback")}</h3>
                <ol class="order">
                  {order.map((n, i) => (
                    <li key={n}>
                      <span>{n}</span>
                      <button type="button" class="btn ghost" aria-label={t("machines.up", { n })} disabled={i === 0} onClick={() => save({ ...orch, order: moved(order, i, -1) })}>↑</button>
                      <button type="button" class="btn ghost" aria-label={t("machines.down", { n })} disabled={i === order.length - 1} onClick={() => save({ ...orch, order: moved(order, i, 1) })}>↓</button>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}
